import CryptoKit
import Foundation

// Receipt export to a user-configured home endpoint (the "献立エージェント" inventory app).
// Wire contract: POST {baseURL}/api/v1/receipts/import, schemaVersion 1.
// The shape is platform-neutral so a future PWA sender can produce identical JSON.
//
// Optional values are always omitted from the JSON (never `null`). Decimal quantities are
// JSON numbers. `totalAmountYen` is the original receipt total, not the sum of the sent
// items: a receipt with non-food items still reports the whole purchase total, so the
// receiver must not use it for inventory amounts.

/// One applied receipt reduced to the food items that may leave the device.
/// Never carries the image, account/payment information, memo or AI metadata.
struct KMReceiptExportReceipt: Codable, Equatable, Sendable, Identifiable {
    struct Item: Codable, Equatable, Sendable {
        var id: String
        var name: String
        var amountYen: Int?
        var quantity: Decimal?
        var unitPriceYen: Int?
        var categoryId: String
    }

    struct Adjustment: Codable, Equatable, Sendable {
        var id: String
        var label: String
        var amountYen: Int
        /// Nil for a whole-receipt adjustment. Otherwise always one of the sent item IDs.
        var targetItemId: String?
    }

    var id: String
    var merchant: String
    var purchasedDate: KMDate
    var purchasedTime: String?
    var totalAmountYen: Int
    var taxAmountYen: Int?
    var categoryId: String
    var items: [Item]
    var adjustments: [Adjustment]
}

struct KMReceiptExportPayload: Encodable, Equatable, Sendable {
    struct Category: Encodable, Equatable, Sendable {
        var id: String
        var name: String
    }

    struct Filter: Encodable, Equatable, Sendable {
        /// Opaque category IDs used to choose items, sorted.
        var categoryIds: [String]
        /// Names for the same IDs so the receiver can tell e.g. 食費 from 外食 without a lookup.
        var categories: [Category]
    }

    static let schemaVersion = 1
    static let source = "kakeimatch-ios"

    var schemaVersion = Self.schemaVersion
    var source = Self.source
    /// UTC instant formatted as `yyyy-MM-ddTHH:mm:ssZ`.
    var sentAt: String
    var filter: Filter
    var receipts: [KMReceiptExportReceipt]

    init(sentAt: Date, categories: [KMCategory], categoryIds: Set<String>, receipts: [KMReceiptExportReceipt]) {
        self.sentAt = Self.timestamp(sentAt)
        let sortedIds = categoryIds.sorted()
        let names = Dictionary(categories.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        filter = Filter(categoryIds: sortedIds,
                        categories: sortedIds.compactMap { id in names[id].map { Category(id: id, name: $0) } })
        self.receipts = receipts
    }

    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    func encoded() throws -> Data { try Self.encoder().encode(self) }
}

/// Pure selection rules. No storage, network or clock access.
enum KMReceiptExportFilter {
    /// Name fragments of the default "food" categories. 外食/カフェ are deliberately excluded:
    /// they are not groceries, and the user can still opt them in on the settings page.
    static let defaultCategoryWords = ["食費", "食料", "食品"]

    static func defaultCategoryIds(_ categories: [KMCategory]) -> [String] {
        categories.filter { category in
            !category.isIncome && defaultCategoryWords.contains(where: category.name.contains)
        }.map(\.id)
    }

    /// Returns nil when nothing of the receipt may be sent.
    /// - Only `applied` receipts with a confirmed value are considered.
    /// - With items: keep items whose category is selected; uncategorized items never leave the device.
    ///   A receipt with no selected items is not sent.
    /// - Without items (total-only record): sent with `items: []` only when the transaction category is selected.
    /// - Adjustments: keep whole-receipt ones and those targeting a kept item.
    static func exportable(_ receipt: KMReceipt, categoryIds: Set<String>) -> KMReceiptExportReceipt? {
        guard receipt.registration.status == .applied, let value = receipt.confirmedValue else { return nil }
        let sourceItems = value.items ?? []
        let items: [KMReceiptExportReceipt.Item]
        if sourceItems.isEmpty {
            guard categoryIds.contains(value.categoryId) else { return nil }
            items = []
        } else {
            items = sourceItems.compactMap { item in
                guard let categoryId = item.categoryId, categoryIds.contains(categoryId) else { return nil }
                return .init(id: item.id, name: item.name, amountYen: item.amountYen, quantity: item.quantity,
                             unitPriceYen: item.unitPriceYen, categoryId: categoryId)
            }
            guard !items.isEmpty else { return nil }
        }
        let keptItemIds = Set(items.map(\.id))
        let adjustments = (value.adjustments ?? []).compactMap { adjustment -> KMReceiptExportReceipt.Adjustment? in
            if let target = adjustment.targetItemId, !keptItemIds.contains(target) { return nil }
            return .init(id: adjustment.id, label: adjustment.label, amountYen: adjustment.amountYen,
                         targetItemId: adjustment.targetItemId)
        }
        return .init(id: receipt.id, merchant: value.merchant, purchasedDate: value.purchasedDate,
                     purchasedTime: value.purchasedTime, totalAmountYen: value.totalAmountYen,
                     taxAmountYen: value.taxAmountYen, categoryId: value.categoryId, items: items,
                     adjustments: adjustments)
    }

    /// SHA-256 of the filtered, key-sorted JSON. Any change to sent content, including an item
    /// moving in or out of the selected categories, changes the hash.
    static func contentHash(_ receipt: KMReceiptExportReceipt) throws -> String {
        let data = try KMReceiptExportPayload.encoder().encode(receipt)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// Difference between the current receipts and what was already accepted by the receiver.
struct KMReceiptExportPlan: Equatable, Sendable {
    /// New or changed receipts, ordered by purchase date then ID.
    var pending: [KMReceiptExportReceipt]
    /// Content hash for every pending receipt, recorded only after the receiver accepts it.
    var hashes: [String: String]
    /// Previously sent receipts that are no longer eligible (deleted, unapplied, or every food item
    /// recategorized). Withdrawal is not propagated to the receiver; their hashes are forgotten so a
    /// later return to eligibility is sent again.
    var noLongerEligible: [String]

    static func make(receipts: [KMReceipt], categoryIds: Set<String>, sentHashes: [String: String]) throws -> Self {
        var pending: [KMReceiptExportReceipt] = []
        var hashes: [String: String] = [:]
        var eligible = Set<String>()
        for receipt in receipts {
            guard let exportable = KMReceiptExportFilter.exportable(receipt, categoryIds: categoryIds) else { continue }
            eligible.insert(exportable.id)
            let hash = try KMReceiptExportFilter.contentHash(exportable)
            guard sentHashes[exportable.id] != hash else { continue }
            pending.append(exportable)
            hashes[exportable.id] = hash
        }
        pending.sort { ($0.purchasedDate, $0.id) < ($1.purchasedDate, $1.id) }
        let removed = sentHashes.keys.filter { !eligible.contains($0) }.sorted()
        return .init(pending: pending, hashes: hashes, noLongerEligible: removed)
    }
}

enum KMReceiptExportError: Error, Equatable, Sendable {
    case invalidEndpoint
}

/// Endpoint rules for the user's own receiver. Separate from the Worker API configuration:
/// a port is allowed (e.g. a tailnet host on :8443), but only HTTPS, with no path, query,
/// fragment or userinfo in the configured origin.
enum KMReceiptExportEndpoint {
    static let path = "/api/v1/receipts/import"

    static func importURL(baseURL: String) throws -> URL {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/" else { throw KMReceiptExportError.invalidEndpoint }
        if let port = components.port, !(1...65535).contains(port) { throw KMReceiptExportError.invalidEndpoint }
        var result = URLComponents()
        result.scheme = "https"
        result.host = host
        result.port = components.port
        result.path = path
        guard let url = result.url else { throw KMReceiptExportError.invalidEndpoint }
        return url
    }

    static func isValid(_ baseURL: String) -> Bool { (try? importURL(baseURL: baseURL)) != nil }
}

/// User choices. The bearer token is not here: it lives in the Keychain only.
struct KMReceiptExportSettings: Codable, Equatable, Sendable {
    var isEnabled = false
    var baseURL = ""
    /// Nil until the user changes the selection; then the food defaults are resolved at send time.
    var categoryIds: [String]? = nil

    func effectiveCategoryIds(_ categories: [KMCategory]) -> Set<String> {
        Set(categoryIds ?? KMReceiptExportFilter.defaultCategoryIds(categories))
    }
}

struct KMReceiptExportStatus: Codable, Equatable, Sendable {
    enum Outcome: String, Codable, Equatable, Sendable {
        case succeeded, nothingToSend, notConfigured, noCategories, readFailed, stateSaveFailed
        case authenticationFailed, networkFailed, serverFailed
    }

    var outcome: Outcome
    var attemptedAt: Date
    /// Receipts accepted by the receiver in this attempt (may be > 0 when a later batch failed).
    var sentCount = 0
    /// Receipts still waiting for the next attempt.
    var pendingCount = 0
    var httpStatus: Int? = nil
}

/// Device-only integration state. Not household data: not part of backups or restores.
struct KMReceiptExportState: Codable, Equatable, Sendable {
    var settings = KMReceiptExportSettings()
    /// Receipt ID -> content hash last accepted by the receiver.
    var sentHashes: [String: String] = [:]
    var lastStatus: KMReceiptExportStatus? = nil
}

protocol KMReceiptExportStateStore {
    func load() throws -> KMReceiptExportState
    func save(_ state: KMReceiptExportState) throws
}

struct KMUserDefaultsReceiptExportStateStore: KMReceiptExportStateStore {
    static let key = "kakeimatch.receipt-export.state"
    let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func load() throws -> KMReceiptExportState {
        guard let data = defaults.data(forKey: Self.key) else { return KMReceiptExportState() }
        return try KMJSON.decoder().decode(KMReceiptExportState.self, from: data)
    }

    func save(_ state: KMReceiptExportState) throws {
        defaults.set(try KMJSON.encoder().encode(state), forKey: Self.key)
    }
}

/// Screen copy. Status text starts with "!" on failure so state is not conveyed by color alone.
enum KMReceiptExportPresentation {
    static let title = "献立エージェント連携"
    static let description = "オンにすると、登録済みレシートのうち対象カテゴリの品目だけを、設定した送信先へ送ります。画像・支払元・メモは送りません。"

    static func rowValue(isEnabled: Bool) -> String { isEnabled ? "オン" : "オフ" }

    static func endpointError(_ baseURL: String) -> String? {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !KMReceiptExportEndpoint.isValid(trimmed) else { return nil }
        return "https:// で始まるURLを、パスを付けずに入力してください（例: https://example-host:8443）。"
    }

    static func statusText(_ status: KMReceiptExportStatus?) -> String {
        guard let status else { return "まだ送信していません。" }
        let time = timeLabel(status.attemptedAt)
        let sentPrefix = status.sentCount > 0 ? "\(status.sentCount)件を送信しました。" : ""
        let retry = status.pendingCount > 0 ? "未送信の\(status.pendingCount)件は次回送ります。" : ""
        let code = status.httpStatus.map { String($0) } ?? "不明"
        switch status.outcome {
        case .succeeded: return "\(time) \(status.sentCount)件を送信しました。"
        case .nothingToSend: return "\(time) 新しく送るレシートはありません。"
        case .notConfigured: return "! 送信先URLとトークンを設定してください。"
        case .noCategories: return "! 送信するカテゴリを1つ以上選んでください。"
        case .readFailed: return "! \(time) 端末内のレシートまたは連携設定を読み込めませんでした。"
        case .stateSaveFailed:
            return "! \(time) \(sentPrefix)送信結果を端末に保存できませんでした。次回、同じレシートを再送することがあります。"
        case .authenticationFailed:
            return "! \(time) \(sentPrefix)認証に失敗しました（HTTP \(code)）。トークンを確認してください。\(retry)"
        case .networkFailed:
            return "! \(time) \(sentPrefix)送信先に接続できませんでした。\(retry)"
        case .serverFailed:
            return "! \(time) \(sentPrefix)送信先がエラーを返しました（HTTP \(code)）。\(retry)"
        }
    }

    static func isFailure(_ status: KMReceiptExportStatus?) -> Bool {
        guard let status else { return false }
        return status.outcome != .succeeded && status.outcome != .nothingToSend
    }

    /// `M/d HH:mm` in Asia/Tokyo, independent of the device time zone.
    static func timeLabel(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = KMDate.calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Tokyo")
        formatter.dateFormat = "M/d HH:mm"
        return formatter.string(from: date)
    }
}
