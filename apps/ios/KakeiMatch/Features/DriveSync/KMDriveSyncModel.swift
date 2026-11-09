import Foundation
import Observation

/// Runs the automatic and manual Drive snapshot uploads. Launch/foreground sync
/// and the settings page share one instance, so two uploads never run at once
/// and the page shows the result of the automatic attempt.
@MainActor
@Observable
final class KMDriveSyncModel {
    private(set) var isEnabled: Bool
    private(set) var isSignedIn: Bool
    private(set) var hasDriveScope: Bool
    private(set) var accountEmail: String?
    private(set) var lastSentAt: Date?
    private(set) var isSyncing = false
    private(set) var isAuthenticating = false
    private(set) var failureMessage: String?

    @ObservationIgnored private let linker: any KMDriveLinking
    @ObservationIgnored private let writer: any KMDriveSnapshotWriting
    @ObservationIgnored private let preferences: KMDriveSyncPreferences
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let appVersion: () -> String?
    @ObservationIgnored private var shownAccountID: String?
    @ObservationIgnored private var activeCancellation: KMDriveUploadCancellation?
    @ObservationIgnored private var cancelGeneration = 0

    init(linker: (any KMDriveLinking)? = nil,
         writer: (any KMDriveSnapshotWriting)? = nil,
         preferences: KMDriveSyncPreferences = KMDriveSyncPreferences(),
         now: @escaping () -> Date = { Date() },
         appVersion: @escaping () -> String? = { KMMuseExportPresentation.appVersion() }) {
        let resolvedLinker = linker ?? KMDriveLinkTestSupport.make() ?? KMDriveLinkManager.shared
        self.linker = resolvedLinker
        self.writer = writer ?? KMDriveSnapshotWriter(accessToken: { forceRefresh in
            try await resolvedLinker.accessToken(forceRefresh: forceRefresh)
        })
        self.preferences = preferences
        self.now = now
        self.appVersion = appVersion
        isEnabled = preferences.isEnabled
        isSignedIn = resolvedLinker.isSignedIn
        hasDriveScope = resolvedLinker.hasDriveScope
        accountEmail = resolvedLinker.accountEmail
        let accountID = resolvedLinker.accountID ?? resolvedLinker.accountEmail
        shownAccountID = accountID
        lastSentAt = accountID.flatMap { id in
            preferences.lastAccountID == id ? preferences.lastSentAt : nil
        }
    }

    var canSendNow: Bool {
        isSignedIn && hasDriveScope && !isSyncing && !isAuthenticating
    }

    var statusText: String? {
        KMDriveSyncPresentation.status(lastSentAt: lastSentAt, isSyncing: isSyncing,
                                       failure: failureMessage)
    }

    var isFailureStatus: Bool { !isSyncing && failureMessage != nil }

    /// The settings page calls this when it appears. Restoring a previous sign-in
    /// is allowed here because the user deliberately opened the page.
    func prepare() async {
        isEnabled = preferences.isEnabled
        refreshLinkState()
        await linker.restoreIfNeeded()
        refreshLinkState()
    }

    /// The toggle turns auto-save on for the first time by starting sign-in.
    /// Cancelling or failing returns the switch to OFF and does not persist it.
    /// Turning it off is always accepted, including while a send or sign-in is
    /// still in progress.
    func setEnabled(_ value: Bool) async {
        guard value != isEnabled else { return }
        guard value else {
            preferences.isEnabled = false
            isEnabled = false
            failureMessage = nil
            cancelGeneration += 1
            activeCancellation?.cancel()
            return
        }
        guard !isSyncing, !isAuthenticating else { return }

        isEnabled = true
        isAuthenticating = true
        defer { isAuthenticating = false }
        do {
            if !linker.isSignedIn {
                let signedIn = try await linker.signIn()
                guard signedIn else {
                    // A cancelled sign-in is not an error.
                    isEnabled = false
                    refreshLinkState()
                    return
                }
            }
            // The user may have turned the toggle off while sign-in was waiting.
            guard isEnabled else { return }
            refreshLinkState()
            guard linker.hasDriveScope else {
                isEnabled = false
                failureMessage = KMDriveSyncPresentation.missingScope
                return
            }
            preferences.isEnabled = true
            failureMessage = nil
        } catch {
            let shouldReport = isEnabled
            isEnabled = false
            refreshLinkState()
            failureMessage = shouldReport ? KMDriveSyncPresentation.signInFailure : nil
        }
    }

    func signIn() async {
        guard !isSyncing, !isAuthenticating else { return }
        isAuthenticating = true
        defer { isAuthenticating = false }
        do {
            let signedIn = try await linker.signIn()
            refreshLinkState()
            if signedIn {
                failureMessage = linker.hasDriveScope ? nil : KMDriveSyncPresentation.missingScope
            } else {
                failureMessage = nil
            }
        } catch {
            refreshLinkState()
            failureMessage = KMDriveSyncPresentation.signInFailure
        }
    }

    func signOut() {
        cancelGeneration += 1
        activeCancellation?.cancel()
        linker.signOut()
        refreshLinkState()
        failureMessage = nil
    }

    /// Automatic path: OFF returns before any repository read or builder call.
    /// A failed upload leaves the fingerprint unchanged, so the next foreground
    /// transition tries again; no loop is started from here.
    func syncIfNeeded(repositories: KMRepositories?) async {
        guard isEnabled else { return }
        guard !isSyncing, !isAuthenticating else { return }
        isSyncing = true
        defer { isSyncing = false }

        await linker.restoreIfNeeded()
        refreshLinkState()
        let startIdentity = currentAccountIdentity
        let generation = cancelGeneration
        guard let snapshot = await makeSnapshot(repositories: repositories) else { return }
        // The user may have turned auto-save off or signed out while the snapshot
        // was being built.
        guard isEnabled, generation == cancelGeneration,
              linker.isSignedIn, currentAccountIdentity == startIdentity else { return }

        do {
            let data = try snapshot.jsonData()
            let fingerprint = try KMDriveSnapshotFingerprint.compute(snapshot)
            guard KMDriveSyncPolicy.shouldUpload(
                isEnabled: isEnabled, isSignedIn: linker.isSignedIn,
                hasScope: linker.hasDriveScope, fingerprint: fingerprint,
                lastUploadedFingerprint: lastFingerprintForCurrentAccount) else { return }
            try await runUpload(data: data, startIdentity: startIdentity, generation: generation)
            didSend(fingerprint: fingerprint)
        } catch KMDriveUploadError.cancelled {
            failureMessage = nil
        } catch {
            failureMessage = KMDriveSyncPresentation.failureMessage(error)
        }
    }

    /// Manual path: sends even when the fingerprint matches the last upload.
    /// The toggle only controls automatic sending, so a signed-in user can still
    /// save once while auto-save is OFF.
    func syncNow(repositories: KMRepositories?) async {
        guard !isSyncing, !isAuthenticating else { return }
        isSyncing = true
        defer { isSyncing = false }

        await linker.restoreIfNeeded()
        refreshLinkState()
        let startIdentity = currentAccountIdentity
        let generation = cancelGeneration
        guard let snapshot = await makeSnapshot(repositories: repositories) else { return }
        guard generation == cancelGeneration,
              linker.isSignedIn, currentAccountIdentity == startIdentity else { return }

        do {
            let data = try snapshot.jsonData()
            let fingerprint = try KMDriveSnapshotFingerprint.compute(snapshot)
            try await runUpload(data: data, startIdentity: startIdentity, generation: generation)
            didSend(fingerprint: fingerprint)
        } catch KMDriveUploadError.cancelled {
            failureMessage = nil
        } catch {
            failureMessage = KMDriveSyncPresentation.failureMessage(error)
        }
    }

    /// Runs one upload with its own stop token. Turning auto-save off or signing
    /// out cancels the token, and the connection is checked again before any
    /// success state is saved.
    private func runUpload(data: Data, startIdentity: String?, generation: Int) async throws {
        let cancellation = KMDriveUploadCancellation()
        activeCancellation = cancellation
        defer {
            if let activeCancellation, activeCancellation === cancellation {
                self.activeCancellation = nil
            }
        }
        try await writer.upload(data: data, cancellation: cancellation)
        guard !cancellation.isCancelled,
              generation == cancelGeneration,
              linker.isSignedIn,
              currentAccountIdentity == startIdentity else {
            throw KMDriveUploadError.cancelled
        }
    }

    /// Builds in memory only; no temporary file is written. The period is the
    /// same default range as the manual export (this month and the previous two).
    private func makeSnapshot(repositories: KMRepositories?) async -> KMMuseSnapshot? {
        guard let repositories else {
            failureMessage = KMDriveSyncPresentation.storeUnavailable
            return nil
        }
        guard linker.isSignedIn else {
            failureMessage = KMDriveSyncPresentation.notSignedIn
            return nil
        }
        guard linker.hasDriveScope else {
            failureMessage = KMDriveSyncPresentation.missingScope
            return nil
        }

        let today = now()
        let range = KMMuseExportPresentation.defaultRange(today: today)
        let builder = KMMuseSnapshotBuilder(
            transactions: repositories.transactions,
            accounts: repositories.accounts,
            categories: repositories.categories)
        do {
            return try await builder.build(
                fromMonth: range.from, toMonth: range.to,
                generatedAt: today, appVersion: appVersion())
        } catch {
            failureMessage = KMDriveSyncPresentation.failureMessage(error)
            return nil
        }
    }

    private func didSend(fingerprint: String) {
        let sentAt = now()
        let identity = currentAccountIdentity
        preferences.lastSentAt = sentAt
        preferences.lastFingerprint = fingerprint
        preferences.lastAccountID = identity
        shownAccountID = identity
        lastSentAt = sentAt
        failureMessage = nil
    }

    private var currentAccountIdentity: String? {
        linker.accountID ?? linker.accountEmail
    }

    /// The last upload belongs to one Google account. A different account must
    /// not inherit it, or its first automatic upload would be skipped.
    private var lastFingerprintForCurrentAccount: String? {
        guard let identity = currentAccountIdentity,
              preferences.lastAccountID == identity else { return nil }
        return preferences.lastFingerprint
    }

    private func refreshLinkState() {
        isSignedIn = linker.isSignedIn
        hasDriveScope = linker.hasDriveScope
        accountEmail = linker.accountEmail
        let identity = currentAccountIdentity
        if let identity, let stored = preferences.lastAccountID, stored != identity {
            preferences.clearUploadHistory()
        }
        if identity != shownAccountID {
            shownAccountID = identity
            lastSentAt = identity.flatMap { id in
                preferences.lastAccountID == id ? preferences.lastSentAt : nil
            }
        }
    }
}
