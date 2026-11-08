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

    init(linker: (any KMDriveLinking)? = nil,
         writer: (any KMDriveSnapshotWriting)? = nil,
         preferences: KMDriveSyncPreferences = KMDriveSyncPreferences(),
         now: @escaping () -> Date = { Date() },
         appVersion: @escaping () -> String? = { KMMuseExportPresentation.appVersion() }) {
        let resolvedLinker = linker ?? KMDriveLinkTestSupport.make() ?? KMDriveLinkManager.shared
        self.linker = resolvedLinker
        self.writer = writer ?? KMDriveSnapshotWriter(accessToken: { try await resolvedLinker.accessToken() })
        self.preferences = preferences
        self.now = now
        self.appVersion = appVersion
        isEnabled = preferences.isEnabled
        isSignedIn = resolvedLinker.isSignedIn
        hasDriveScope = resolvedLinker.hasDriveScope
        accountEmail = resolvedLinker.accountEmail
        lastSentAt = preferences.lastSentAt
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
        lastSentAt = preferences.lastSentAt
        isEnabled = preferences.isEnabled
        refreshLinkState()
        await linker.restoreIfNeeded()
        refreshLinkState()
    }

    /// The toggle turns auto-save on for the first time by starting sign-in.
    /// Cancelling or failing returns the switch to OFF and does not persist it.
    func setEnabled(_ value: Bool) async {
        guard value != isEnabled else { return }
        guard !isSyncing, !isAuthenticating else { return }
        guard value else {
            preferences.isEnabled = false
            isEnabled = false
            failureMessage = nil
            return
        }

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
            refreshLinkState()
            guard linker.hasDriveScope else {
                isEnabled = false
                failureMessage = KMDriveSyncPresentation.missingScope
                return
            }
            preferences.isEnabled = true
            failureMessage = nil
        } catch {
            isEnabled = false
            refreshLinkState()
            failureMessage = KMDriveSyncPresentation.signInFailure
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
        guard let snapshot = await makeSnapshot(repositories: repositories) else { return }

        do {
            let data = try snapshot.jsonData()
            let fingerprint = try KMDriveSnapshotFingerprint.compute(snapshot)
            guard KMDriveSyncPolicy.shouldUpload(
                isEnabled: isEnabled, isSignedIn: linker.isSignedIn,
                hasScope: linker.hasDriveScope, fingerprint: fingerprint,
                lastUploadedFingerprint: preferences.lastFingerprint) else { return }
            try await writer.upload(data: data)
            didSend(fingerprint: fingerprint)
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
        guard let snapshot = await makeSnapshot(repositories: repositories) else { return }

        do {
            let data = try snapshot.jsonData()
            let fingerprint = try KMDriveSnapshotFingerprint.compute(snapshot)
            try await writer.upload(data: data)
            didSend(fingerprint: fingerprint)
        } catch {
            failureMessage = KMDriveSyncPresentation.failureMessage(error)
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
        preferences.lastSentAt = sentAt
        preferences.lastFingerprint = fingerprint
        lastSentAt = sentAt
        failureMessage = nil
    }

    private func refreshLinkState() {
        isSignedIn = linker.isSignedIn
        hasDriveScope = linker.hasDriveScope
        accountEmail = linker.accountEmail
    }
}
