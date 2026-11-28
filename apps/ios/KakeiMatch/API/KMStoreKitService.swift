import Foundation
import StoreKit

/// StoreKit product IDs and feature flag readers.
/// Product IDs match production even in Sandbox testing.
enum KMStoreKitConfiguration {
    static let proMonthlyProductID = "jp.kakeimatch.pro.monthly"
    static let productIDs: [String] = [proMonthlyProductID]

    /// Feature flag injected into Info.plist from `KM_STOREKIT_SANDBOX_UI`.
    /// Defaults to `false` (OFF) when absent or not explicitly `true`.
    static func isSandboxUIFlagEnabled(bundle: Bundle = .main) -> Bool {
        (bundle.object(forInfoDictionaryKey: "KMStoreKitSandboxUI") as? Bool) == true
    }
}

/// Fail-closed guard ensuring Sandbox UI and transaction submission never run
/// against App Store production transactions or builds.
enum KMStoreKitEnvironmentGuard {
    static func isAllowed(_ environment: AppStore.Environment) -> Bool {
        environment == .sandbox || environment == .xcode
    }
}

struct KMStoreKitProduct: Equatable, Sendable, Identifiable {
    let id: String
    let displayName: String
    let description: String
    let displayPrice: String
}

struct KMStoreKitVerifiedTransaction: Equatable, Sendable {
    let transactionID: UInt64
    let productID: String
    let jwsRepresentation: String
    let isSandboxOrXcode: Bool
}

enum KMStoreKitPurchaseOutcome: Equatable, Sendable {
    case purchased(KMStoreKitVerifiedTransaction)
    case pending
    case userCancelled
}

enum KMStoreKitError: Error, Equatable, Sendable {
    case productNotFound
    case unverifiedTransaction
    case productionEnvironmentRejected
    case purchaseFailed
    case syncFailed
}

/// Narrow StoreKit 2 boundary so models and tests do not depend directly on
/// live StoreKit APIs.
protocol KMStoreKitServicing: Sendable {
    func isSandboxEnvironment() async -> Bool
    func fetchProducts() async throws -> [KMStoreKitProduct]
    func purchase(productID: String) async throws -> KMStoreKitPurchaseOutcome
    func syncAndCollectEntitlements() async throws -> [KMStoreKitVerifiedTransaction]
    func currentEntitlements() async -> [KMStoreKitVerifiedTransaction]
    func finishTransaction(id: UInt64) async
    func startObservingUpdates(onTransaction: @escaping @Sendable (KMStoreKitVerifiedTransaction) async -> Void) async
    func stopObservingUpdates() async
}

/// StoreKit 2 client restricted to Sandbox and local Xcode StoreKit Testing.
actor KMStoreKitService: KMStoreKitServicing {
    private let productIDs: [String]
    private var cachedProducts: [String: Product] = [:]
    private var pendingTransactions: [UInt64: Transaction] = [:]
    private var updatesTask: Task<Void, Never>?

    init(productIDs: [String] = KMStoreKitConfiguration.productIDs) {
        self.productIDs = productIDs
    }

    deinit {
        updatesTask?.cancel()
    }

    func isSandboxEnvironment() async -> Bool {
        do {
            let verification = try await AppTransaction.shared
            guard case .verified(let appTransaction) = verification else {
                return false
            }
            return KMStoreKitEnvironmentGuard.isAllowed(appTransaction.environment)
        } catch {
            return false
        }
    }

    func fetchProducts() async throws -> [KMStoreKitProduct] {
        let products = try await Product.products(for: productIDs)
        var byID: [String: Product] = [:]
        for product in products {
            byID[product.id] = product
        }
        cachedProducts = byID
        return productIDs.compactMap { id in
            guard let product = byID[id] else { return nil }
            return KMStoreKitProduct(
                id: product.id,
                displayName: product.displayName,
                description: product.description,
                displayPrice: product.displayPrice
            )
        }
    }

    func purchase(productID: String) async throws -> KMStoreKitPurchaseOutcome {
        let product: Product
        if let cached = cachedProducts[productID] {
            product = cached
        } else {
            let loaded = try await Product.products(for: [productID])
            guard let first = loaded.first(where: { $0.id == productID }) else {
                throw KMStoreKitError.productNotFound
            }
            cachedProducts[productID] = first
            product = first
        }

        let result: Product.PurchaseResult
        do {
            result = try await product.purchase()
        } catch {
            throw KMStoreKitError.purchaseFailed
        }

        switch result {
        case .success(let verification):
            let verified = try verifiedSandboxTransaction(from: verification)
            return .purchased(verified)
        case .userCancelled:
            return .userCancelled
        case .pending:
            return .pending
        @unknown default:
            throw KMStoreKitError.purchaseFailed
        }
    }

    func syncAndCollectEntitlements() async throws -> [KMStoreKitVerifiedTransaction] {
        do {
            try await AppStore.sync()
        } catch {
            throw KMStoreKitError.syncFailed
        }
        return await currentEntitlements()
    }

    func currentEntitlements() async -> [KMStoreKitVerifiedTransaction] {
        var collected: [KMStoreKitVerifiedTransaction] = []
        for await verification in Transaction.currentEntitlements {
            guard let verified = try? verifiedSandboxTransaction(from: verification),
                  productIDs.contains(verified.productID) else {
                continue
            }
            collected.append(verified)
        }
        return collected
    }

    func finishTransaction(id: UInt64) async {
        guard let transaction = pendingTransactions.removeValue(forKey: id) else {
            return
        }
        await transaction.finish()
    }

    func startObservingUpdates(
        onTransaction: @escaping @Sendable (KMStoreKitVerifiedTransaction) async -> Void
    ) {
        updatesTask?.cancel()
        let allowedIDs = Set(productIDs)
        updatesTask = Task { [weak self] in
            for await verification in Transaction.updates {
                if Task.isCancelled { break }
                guard let self else { break }
                guard let verified = try? await self.verifiedSandboxTransaction(from: verification),
                      allowedIDs.contains(verified.productID) else {
                    continue
                }
                await onTransaction(verified)
            }
        }
    }

    func stopObservingUpdates() {
        updatesTask?.cancel()
        updatesTask = nil
    }

    private func verifiedSandboxTransaction(
        from verification: VerificationResult<Transaction>
    ) throws -> KMStoreKitVerifiedTransaction {
        guard case .verified(let transaction) = verification else {
            throw KMStoreKitError.unverifiedTransaction
        }
        guard KMStoreKitEnvironmentGuard.isAllowed(transaction.environment) else {
            throw KMStoreKitError.productionEnvironmentRejected
        }
        pendingTransactions[transaction.id] = transaction
        return KMStoreKitVerifiedTransaction(
            transactionID: transaction.id,
            productID: transaction.productID,
            jwsRepresentation: verification.jwsRepresentation,
            isSandboxOrXcode: true
        )
    }
}
