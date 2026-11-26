import Foundation
import Observation

/// State for the Settings > 利用状況 screen and the Settings support ID row.
/// Never reads or writes household repositories; local data stays usable while
/// cloud usage is unavailable or unused.
@MainActor @Observable
final class KMNativeAuthModel {
    enum Phase: Equatable { case loading, signedOut, signedIn, unavailable }

    private(set) var phase = Phase.loading
    private(set) var usage: KMAIUsage?
    private(set) var usageMessage = KMNativeAuthPresentation.usageLoading
    private(set) var usageRowValue: String?
    private(set) var hasLoaded = false

    @ObservationIgnored private var injectedService: (any KMNativeAuthService)?
    @ObservationIgnored private var liveService: (any KMNativeAuthService)?

    init(service: (any KMNativeAuthService)? = nil) {
        injectedService = service ?? KMNativeAuthTestService.make()
    }

    var supportId: String? {
        KMSettingsPresentation.normalizedSupportId(usage?.supportId)
    }

    var usageSummary: String {
        guard let usage else { return usageMessage }
        return KMNativeAuthPresentation.usageSummary(plan: usage.plan.rawValue, period: usage.period.rawValue, used: usage.used, limit: usage.limit)
    }

    var usageFraction: Double? {
        guard let usage else { return nil }
        return KMNativeAuthPresentation.usageFraction(plan: usage.plan.rawValue, used: usage.used, limit: usage.limit)
    }

    var settingsRowValue: String? { usageRowValue }
    var isUnavailable: Bool { phase == .unavailable }

    func refresh() async {
        usage = nil
        usageRowValue = nil
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
        await loadUsage(service)
        hasLoaded = true
    }

    private func loadUsage(_ service: any KMNativeAuthService) async {
        do {
            let value = try await service.accountUsage()
            applyUsage(value, phase: .signedIn)
        } catch let error as KMAPIError where error == .nativeAuthenticationRequired || error == .authenticationRequired {
            await loadGuestUsage(service)
        } catch {
            phase = .unavailable
            usage = nil
            usageMessage = KMNativeAuthPresentation.usageUnavailable
            usageRowValue = nil
        }
    }

    private func loadGuestUsage(_ service: any KMNativeAuthService) async {
        do {
            let value = try await service.guestUsage()
            applyUsage(value, phase: .signedOut)
        } catch let error as KMAPIError where error == .nativeAuthenticationRequired || error == .authenticationRequired {
            phase = .signedOut
            usage = nil
            usageMessage = KMNativeAuthPresentation.signedOutFreeUsage
            usageRowValue = KMNativeAuthPresentation.signedOutRowValue
        } catch {
            phase = .unavailable
            usage = nil
            usageMessage = KMNativeAuthPresentation.guestUsageUnavailable
            usageRowValue = nil
        }
    }

    private func applyUsage(_ value: KMAIUsage, phase: Phase) {
        self.phase = phase
        usage = value
        usageMessage = KMNativeAuthPresentation.usageSummary(plan: value.plan.rawValue, period: value.period.rawValue, used: value.used, limit: value.limit)
        usageRowValue = KMNativeAuthPresentation.settingsRowValue(plan: value.plan.rawValue, period: value.period.rawValue, used: value.used, limit: value.limit)
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
        let supportId = ProcessInfo.processInfo.environment["KM_UI_TEST_SUPPORT_ID"]
        switch ProcessInfo.processInfo.environment["KM_UI_TEST_NATIVE_AUTH_STATE"] {
        case "signedOut": return KMFakeNativeAuthService(initial: .signedOut, supportId: supportId)
        case "signedIn": return KMFakeNativeAuthService(initial: .signedIn, supportId: supportId)
        case "signedInDaily": return KMFakeNativeAuthService(initial: .signedInDaily, supportId: supportId)
        case "guest": return KMFakeNativeAuthService(initial: .guest, supportId: supportId)
        case "unsupported": return KMFakeNativeAuthService(initial: .unsupported, supportId: supportId)
        default: return nil
        }
        #else
        return nil
        #endif
    }
}
