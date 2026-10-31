import Foundation
import Observation

/// State for the PWA `settings-page-ai` screen. Authentication never reads or
/// writes household repositories; local data stays usable while this screen is
/// unavailable or signed out.
@MainActor @Observable
final class KMNativeAuthModel {
    enum Phase: Equatable { case loading, signedOut, signedIn, unavailable }

    private(set) var phase = Phase.loading
    private(set) var accountName: String?
    private(set) var usage: KMAIUsage?
    private(set) var usageMessage = KMNativeAuthPresentation.usageLoading
    private(set) var usageRowValue: String?
    private(set) var passkeys: [KMCloudPasskey] = []
    private(set) var passkeysLoaded = false
    private(set) var busy = false
    private(set) var hasLoaded = false
    var message: String?

    @ObservationIgnored private var injectedService: (any KMNativeAuthService)?
    @ObservationIgnored private var liveService: (any KMNativeAuthService)?

    init(service: (any KMNativeAuthService)? = nil) {
        injectedService = service ?? KMNativeAuthTestService.make()
    }

    var accountStatus: String {
        switch phase {
        case .loading:
            // PWA leaves `#account-status` empty until the session check settles;
            // showing the failure copy while loading would flash a false error.
            return ""
        case .unavailable:
            return KMNativeAuthPresentation.unavailableStatus
        case .signedOut, .signedIn:
            return KMNativeAuthPresentation.accountStatus(isSignedIn: phase == .signedIn, name: accountName)
        }
    }

    var usageSummary: String {
        guard let usage else { return usageMessage }
        return KMNativeAuthPresentation.usageSummary(plan: usage.plan.rawValue, used: usage.used, limit: usage.limit)
    }

    var usageFraction: Double? {
        guard let usage else { return nil }
        return KMNativeAuthPresentation.usageFraction(plan: usage.plan.rawValue, used: usage.used, limit: usage.limit)
    }

    var settingsRowValue: String? { usageRowValue }
    var showsSignedOutActions: Bool { phase == .signedOut }
    var showsSignedInActions: Bool { phase == .signedIn }
    var isUnavailable: Bool { phase == .unavailable }

    func refresh() async {
        message = nil
        usage = nil
        usageRowValue = nil
        passkeys = []
        passkeysLoaded = false
        usageMessage = KMNativeAuthPresentation.usageLoading
        phase = .loading
        guard let service = resolvedService() else {
            phase = .unavailable
            usageMessage = KMNativeAuthPresentation.unavailableStatus
            hasLoaded = true
            return
        }
        // Simulator/unsupported devices cannot complete App Attest. Do not issue
        // a request that is guaranteed to fail; explain why cloud features stop.
        guard service.appAttestSupported else {
            phase = .unavailable
            usageMessage = KMNativeAuthPresentation.unsupportedDetail
            hasLoaded = true
            return
        }
        do {
            let configuration = try await service.nativeConfiguration()
            guard configuration.available else {
                phase = .unavailable
                usageMessage = KMNativeAuthPresentation.notConfiguredDetail
                hasLoaded = true
                return
            }
        } catch {
            phase = .unavailable
            usageMessage = (error as? KMAPIError) == .notConfigured
                ? KMNativeAuthPresentation.notConfiguredDetail
                : KMNativeAuthPresentation.usageUnavailable
            hasLoaded = true
            return
        }
        do {
            let session = try await service.accountSession()
            if let session {
                phase = .signedIn
                accountName = session.user.name
                await loadSignedIn(service)
            } else {
                phase = .signedOut
                accountName = nil
                await loadSignedOut(service)
            }
        } catch let error as KMAPIError where error == .authenticationRequired || error == .nativeAuthenticationRequired {
            phase = .signedOut
            accountName = nil
            message = KMNativeAuthPresentation.sessionExpired
            await loadSignedOut(service)
        } catch {
            phase = .unavailable
            usageMessage = KMNativeAuthPresentation.usageUnavailable
        }
        hasLoaded = true
    }

    func signInWithPasskey() async {
        guard !busy, let service = resolvedService() else { return }
        busy = true
        defer { busy = false }
        message = KMNativeAuthPresentation.loginInProgress
        do {
            try await service.signInWithPasskey()
            await refresh()
            if phase == .signedIn { await issueAIToken(service) }
        } catch {
            message = KMNativeAuthPresentation.loginFailed
        }
    }

    func registerWithInvitation(_ invitation: String) async {
        guard !busy, let service = resolvedService(), KMNativeAuthPresentation.invitationIsValid(invitation) else { return }
        busy = true
        defer { busy = false }
        message = KMNativeAuthPresentation.registerInProgress
        do {
            try await service.registerPasskey(context: invitation.trimmingCharacters(in: .whitespacesAndNewlines), name: "この端末")
            await refresh()
            if phase == .signedIn { await issueAIToken(service) }
        } catch {
            message = KMNativeAuthPresentation.registerFailed
        }
    }

    func addPasskey() async {
        guard !busy, let service = resolvedService(), phase == .signedIn else { return }
        busy = true
        defer { busy = false }
        do {
            try await service.addPasskey(name: "追加のPasskey")
            message = KMNativeAuthPresentation.passkeyAdded
            await loadPasskeys(service)
        } catch {
            message = KMNativeAuthPresentation.passkeyAddFailed
        }
    }

    func deletePasskey(_ passkey: KMCloudPasskey) async {
        guard !busy, let service = resolvedService() else { return }
        busy = true
        defer { busy = false }
        do {
            try await service.deletePasskey(id: passkey.id)
            await loadPasskeys(service)
        } catch {
            message = KMNativeAuthPresentation.passkeyDeleteFailed
        }
    }

    func issueAIToken() async {
        guard let service = resolvedService() else { return }
        await issueAIToken(service)
    }

    func signOut() async {
        guard !busy, let service = resolvedService() else { return }
        busy = true
        defer { busy = false }
        do {
            try await service.signOut()
            phase = .signedOut
            accountName = nil
            await loadSignedOut(service)
            message = KMNativeAuthPresentation.logoutDone
        } catch {
            message = KMNativeAuthPresentation.logoutFailed
        }
    }

    func deleteAccount() async {
        guard !busy, let service = resolvedService() else { return }
        busy = true
        defer { busy = false }
        message = KMNativeAuthPresentation.accountDeleteInProgress
        do {
            _ = try await service.deleteAccount()
            phase = .signedOut
            accountName = nil
            passkeys = []
            passkeysLoaded = false
            usage = nil
            usageRowValue = nil
            usageMessage = KMNativeAuthPresentation.accountDeletedUsage
            message = KMNativeAuthPresentation.accountDeleteDone
        } catch let error as KMAPIError where error == .authenticationRequired || error == .nativeAuthenticationRequired {
            message = KMNativeAuthPresentation.accountDeleteSessionExpired
        } catch {
            message = KMNativeAuthPresentation.accountDeleteFailed
        }
    }

    func clearMessage() { message = nil }

    private func issueAIToken(_ service: any KMNativeAuthService) async {
        message = KMNativeAuthPresentation.tokenInProgress
        do {
            try await service.issueAccountAIToken()
            message = KMNativeAuthPresentation.tokenReady
        } catch let error as KMAPIError where error == .nativeAuthenticationRequired || error == .authenticationRequired {
            phase = .signedOut
            accountName = nil
            message = KMNativeAuthPresentation.sessionExpired
            await loadSignedOut(service)
        } catch {
            message = KMNativeAuthPresentation.tokenFailed
        }
    }

    private func loadSignedOut(_ service: any KMNativeAuthService) async {
        // PWA hides the signed-in block; drop the previous account's list too so
        // a later session never shows another account's Passkeys.
        passkeys = []
        passkeysLoaded = false
        do {
            let value = try await service.guestUsage()
            usage = value
            usageMessage = KMNativeAuthPresentation.usageSummary(plan: value.plan.rawValue, used: value.used, limit: value.limit)
            usageRowValue = KMNativeAuthPresentation.settingsRowValue(plan: value.plan.rawValue, used: value.used, limit: value.limit)
        } catch let error as KMAPIError where error == .nativeAuthenticationRequired || error == .authenticationRequired {
            usage = nil
            usageMessage = KMNativeAuthPresentation.signedOutFreeUsage
            usageRowValue = KMNativeAuthPresentation.signedOutRowValue
        } catch {
            usage = nil
            usageMessage = KMNativeAuthPresentation.guestUsageUnavailable
            usageRowValue = nil
        }
    }

    private func loadSignedIn(_ service: any KMNativeAuthService) async {
        do {
            let value = try await service.accountUsage()
            usage = value
            usageMessage = KMNativeAuthPresentation.usageSummary(plan: value.plan.rawValue, used: value.used, limit: value.limit)
            usageRowValue = KMNativeAuthPresentation.settingsRowValue(plan: value.plan.rawValue, used: value.used, limit: value.limit)
        } catch {
            usage = nil
            usageMessage = KMNativeAuthPresentation.usageUnavailable
            usageRowValue = nil
        }
        await loadPasskeys(service)
    }

    private func loadPasskeys(_ service: any KMNativeAuthService) async {
        do {
            passkeys = try await service.listPasskeys()
            passkeysLoaded = true
        } catch {
            passkeys = []
            passkeysLoaded = false
            message = KMNativeAuthPresentation.passkeyListFailed
        }
    }

    private func resolvedService() -> (any KMNativeAuthService)? {
        if let injectedService { return injectedService }
        if let liveService { return liveService }
        guard let configuration = try? KMAPIConfiguration() else { return nil }
        let api = KMWorkerAPI(configuration: configuration)
        liveService = api
        return api
    }
}

/// Debug-only launch states used by XCUITest. Release builds always use the
/// real adapter and never fabricate a session or usage record.
private enum KMNativeAuthTestService {
    static func make() -> (any KMNativeAuthService)? {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["KM_UI_TEST_NATIVE_AUTH_STATE"] {
        case "signedOut": return KMFakeNativeAuthService(initial: .signedOut)
        case "signedIn": return KMFakeNativeAuthService(initial: .signedIn)
        case "guest": return KMFakeNativeAuthService(initial: .guest)
        case "unsupported": return KMFakeNativeAuthService(initial: .unsupported)
        default: return nil
        }
        #else
        return nil
        #endif
    }
}
