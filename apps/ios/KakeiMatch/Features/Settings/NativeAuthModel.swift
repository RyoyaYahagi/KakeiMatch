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

    private(set) var showStoreKitSandboxSection = false
    private(set) var storeKitProducts: [KMStoreKitProduct] = []
    private(set) var storeKitBusy = false
    private(set) var storeKitStatusMessage: String?
    private(set) var storeKitErrorMessage: String?

    @ObservationIgnored private var injectedService: (any KMNativeAuthService)?
    @ObservationIgnored private var liveService: (any KMNativeAuthService)?
    @ObservationIgnored private var injectedStoreKit: (any KMStoreKitServicing)?
    @ObservationIgnored private var liveStoreKit: (any KMStoreKitServicing)?
    @ObservationIgnored private let storeKitSandboxFlagEnabled: Bool
    @ObservationIgnored private var storeKitObserverStarted = false

    init(
        service: (any KMNativeAuthService)? = nil,
        storeKit: (any KMStoreKitServicing)? = nil,
        storeKitSandboxFlagEnabled: Bool? = nil
    ) {
        injectedService = service ?? KMNativeAuthTestService.make()
        injectedStoreKit = storeKit
        self.storeKitSandboxFlagEnabled = storeKitSandboxFlagEnabled ?? KMStoreKitConfiguration.isSandboxUIFlagEnabled()
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

    /// Evaluates the feature flag and Sandbox environment guard. When the flag
    /// is OFF, this exits immediately without touching StoreKit APIs.
    func loadStoreKitSandboxIfNeeded() async {
        guard storeKitSandboxFlagEnabled else {
            showStoreKitSandboxSection = false
            return
        }
        let storeKit = resolvedStoreKitService()
        guard await storeKit.isSandboxEnvironment() else {
            showStoreKitSandboxSection = false
            return
        }
        showStoreKitSandboxSection = true
        if !storeKitObserverStarted {
            storeKitObserverStarted = true
            await storeKit.startObservingUpdates { [weak self] transaction in
                await self?.handleObservedStoreKitTransaction(transaction)
            }
        }
        if storeKitProducts.isEmpty {
            await reloadStoreKitProducts()
        }
    }

    func reloadStoreKitProducts() async {
        guard showStoreKitSandboxSection, !storeKitBusy else { return }
        storeKitBusy = true
        storeKitErrorMessage = nil
        defer { storeKitBusy = false }
        let storeKit = resolvedStoreKitService()
        do {
            storeKitProducts = try await storeKit.fetchProducts()
        } catch {
            storeKitErrorMessage = "Sandbox の商品情報を取得できませんでした。"
        }
    }

    func purchaseStoreKitProduct(id: String) async {
        guard showStoreKitSandboxSection, !storeKitBusy else { return }
        storeKitBusy = true
        storeKitStatusMessage = nil
        storeKitErrorMessage = nil
        defer { storeKitBusy = false }
        let storeKit = resolvedStoreKitService()
        do {
            let outcome = try await storeKit.purchase(productID: id)
            switch outcome {
            case .purchased(let transaction):
                let response = try await submitStoreKitTransactionAndFinish(transaction, storeKit: storeKit)
                await refresh()
                storeKitStatusMessage = Self.storeKitSyncMessage(response, restored: false)
            case .pending:
                storeKitStatusMessage = "購入の承認待ちです。完了後に自動で反映されます。"
            case .userCancelled:
                break
            }
        } catch {
            storeKitErrorMessage = Self.storeKitErrorDescription(error)
        }
    }

    func restoreStoreKitPurchases() async {
        guard showStoreKitSandboxSection, !storeKitBusy else { return }
        storeKitBusy = true
        storeKitStatusMessage = nil
        storeKitErrorMessage = nil
        defer { storeKitBusy = false }
        let storeKit = resolvedStoreKitService()
        do {
            let transactions = try await storeKit.syncAndCollectEntitlements()
            guard !transactions.isEmpty else {
                await refresh()
                storeKitStatusMessage = "復元できる Sandbox の購入が見つかりませんでした。"
                return
            }
            var lastResponse: KMStoreKitTransactionResponse?
            for transaction in transactions {
                lastResponse = try await submitStoreKitTransactionAndFinish(transaction, storeKit: storeKit)
            }
            await refresh()
            if let lastResponse {
                storeKitStatusMessage = Self.storeKitSyncMessage(lastResponse, restored: true)
            }
        } catch {
            storeKitErrorMessage = Self.storeKitErrorDescription(error)
        }
    }

    private func handleObservedStoreKitTransaction(_ transaction: KMStoreKitVerifiedTransaction) async {
        guard showStoreKitSandboxSection else { return }
        let storeKit = resolvedStoreKitService()
        do {
            let response = try await submitStoreKitTransactionAndFinish(transaction, storeKit: storeKit)
            await refresh()
            storeKitStatusMessage = Self.storeKitSyncMessage(response, restored: false)
            storeKitErrorMessage = nil
        } catch {
            storeKitErrorMessage = Self.storeKitErrorDescription(error)
        }
    }

    private func submitStoreKitTransactionAndFinish(
        _ transaction: KMStoreKitVerifiedTransaction,
        storeKit: any KMStoreKitServicing
    ) async throws -> KMStoreKitTransactionResponse {
        guard transaction.isSandboxOrXcode else {
            throw KMStoreKitError.productionEnvironmentRejected
        }
        guard let service = resolvedService() else {
            throw KMAPIError.notConfigured
        }
        let response: KMStoreKitTransactionResponse
        do {
            response = try await service.submitStoreKitTransaction(jws: transaction.jwsRepresentation)
        } catch let error as KMAPIError where error == .nativeAuthenticationRequired {
            try await service.startGuest()
            response = try await service.submitStoreKitTransaction(jws: transaction.jwsRepresentation)
        }
        await storeKit.finishTransaction(id: transaction.transactionID)
        return response
    }

    private static func storeKitSyncMessage(_ response: KMStoreKitTransactionResponse, restored: Bool) -> String {
        if let reason = response.reason {
            switch reason {
            case .staleOwnerTransfer:
                return "取引が古いため所有者を切り替えられませんでした。"
            case .ownerChangeRateLimited:
                return "所有者変更の上限に達したため同期をスキップしました。"
            case .staleTransaction:
                return "より新しい取引が既に反映されています。"
            }
        }
        guard response.synced else {
            return "取引はまだ反映されていません。時間をおいて再度お試しください。"
        }
        return restored
            ? "購入を復元し、利用状況を更新しました。"
            : "購入を確認し、利用状況を更新しました。"
    }

    private static func storeKitErrorDescription(_ error: any Error) -> String {
        if let storeKitError = error as? KMStoreKitError {
            switch storeKitError {
            case .productNotFound: return "対象の商品が見つかりませんでした。"
            case .unverifiedTransaction: return "取引の署名を検証できませんでした。"
            case .productionEnvironmentRejected: return "本番環境の取引は Sandbox UI から送信できません。"
            case .purchaseFailed: return "購入処理を完了できませんでした。"
            case .syncFailed: return "App Store との同期に失敗しました。"
            }
        }
        if let apiError = error as? KMAPIError {
            switch apiError {
            case .storeKitInvalidJWS: return "サーバーで取引署名を検証できませんでした。"
            case .storeKitEnvironmentNotAllowed: return "サーバーで許可されていない環境です。"
            case .storeKitUnsupportedOwnershipType: return "ファミリー共有の購入は対象外です。"
            case .storeKitUnknownProduct: return "サーバーに未登録の商品です。"
            case .notConfigured: return "サーバー側の課金設定が無効です。"
            case .nativeUnsupported: return KMNativeAuthPresentation.unsupportedDetail
            case .authenticationRequired, .nativeAuthenticationRequired: return "端末認証を確認できませんでした。"
            default: return "サーバーへの取引送信に失敗しました。"
            }
        }
        return "処理に失敗しました。"
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

    private func resolvedStoreKitService() -> any KMStoreKitServicing {
        if let injectedStoreKit { return injectedStoreKit }
        if let liveStoreKit { return liveStoreKit }
        let service = KMStoreKitService()
        liveStoreKit = service
        return service
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
