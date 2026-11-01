import Foundation
import Testing
@testable import KakeiMatchCore

// Synthetic categories and receipts only. IDs are opaque, as in a real ledger.
private let food = KMCategory(id: "cat-food", name: "食費")
private let eatingOut = KMCategory(id: "cat-eating-out", name: "外食")
private let daily = KMCategory(id: "cat-daily", name: "日用品")
private let salary = KMCategory(id: "cat-salary", name: "給与食品手当", isIncome: true)
private let categories = [food, eatingOut, daily, salary]
private let foodOnly: Set<String> = [food.id]

private func receipt(
    id: String = "receipt-1",
    status: KMReceipt.RegistrationStatus = .applied,
    categoryId: String = food.id,
    items: [KMReceiptItem]? = nil,
    adjustments: [KMReceiptAdjustment]? = nil,
    date: String = "2026-10-20",
    purchasedTime: String? = "18:30",
    taxAmountYen: Int? = 112
) -> KMReceipt {
    let instant = Date(timeIntervalSince1970: 1_800_000_000)
    return KMReceipt(
        id: id, createdAt: instant, updatedAt: instant,
        image: .init(blobId: "blob-1", contentType: "image/jpeg", sizeBytes: 3),
        aiSuggestion: .init(source: .jev, model: "synthetic-model"),
        confirmedValue: .init(merchant: "合成スーパー", purchasedDate: KMDate(rawValue: date), purchasedTime: purchasedTime,
                              totalAmountYen: 1234, categoryId: categoryId, accountId: "account-secret",
                              excludedFromSpending: false, memo: "合成メモ", taxAmountYen: taxAmountYen,
                              items: items, adjustments: adjustments),
        registration: .init(status: status, actualTransactionId: "actual-1", lastError: nil)
    )
}

private let mixedItems: [KMReceiptItem] = [
    .init(id: "item-milk", name: "合成牛乳", amountYen: 500, quantity: 2, unitPriceYen: 250, categoryId: food.id),
    .init(id: "item-soap", name: "合成洗剤", amountYen: 300, categoryId: daily.id),
    .init(id: "item-unknown", name: "合成不明品", amountYen: 100, categoryId: nil),
    .init(id: "item-bread", name: "合成パン", amountYen: 200, quantity: Decimal(string: "1.5"), categoryId: food.id),
]

private let mixedAdjustments: [KMReceiptAdjustment] = [
    .init(id: "adj-milk", label: "値引き", amountYen: -100, targetItemId: "item-milk"),
    .init(id: "adj-soap", label: "値引き", amountYen: -50, targetItemId: "item-soap"),
    .init(id: "adj-unknown", label: "値引き", amountYen: -10, targetItemId: "item-unknown"),
    .init(id: "adj-all", label: "クーポン", amountYen: -30, targetItemId: nil),
]

struct ReceiptExportFilterTests {
    @Test func defaultCategoriesAreFoodNamesOnlyExcludingEatingOutAndIncome() {
        #expect(KMReceiptExportFilter.defaultCategoryIds(categories) == [food.id])
        let grocery = KMCategory(id: "cat-grocery", name: "食料品")
        #expect(KMReceiptExportFilter.defaultCategoryIds([grocery, daily]) == [grocery.id])
        #expect(KMReceiptExportSettings().effectiveCategoryIds(categories) == foodOnly)
        #expect(KMReceiptExportSettings(categoryIds: [daily.id]).effectiveCategoryIds(categories) == [daily.id])
        #expect(KMReceiptExportSettings(categoryIds: []).effectiveCategoryIds(categories).isEmpty)
    }

    @Test func keepsOnlyFoodItemsAndDropsUncategorizedAndNonFood() throws {
        let value = try #require(KMReceiptExportFilter.exportable(
            receipt(items: mixedItems, adjustments: mixedAdjustments), categoryIds: foodOnly))
        #expect(value.items.map(\.id) == ["item-milk", "item-bread"])
        #expect(value.items.allSatisfy { $0.categoryId == food.id })
        // Adjustments tied to non-food or uncategorized items are dropped; whole-receipt ones stay.
        #expect(value.adjustments.map(\.id) == ["adj-milk", "adj-all"])
        // The original total is kept as-is: it is NOT the sum of the sent items.
        #expect(value.totalAmountYen == 1234)
        #expect(value.items.compactMap(\.amountYen).reduce(0, +) == 700)
    }

    @Test func receiptWithNoSelectedItemsIsNotSent() {
        let nonFood: [KMReceiptItem] = [
            .init(id: "item-soap", name: "合成洗剤", amountYen: 300, categoryId: daily.id),
            .init(id: "item-unknown", name: "合成不明品", amountYen: 100, categoryId: nil),
        ]
        // Even when the transaction category is food, item categories decide.
        #expect(KMReceiptExportFilter.exportable(receipt(categoryId: food.id, items: nonFood), categoryIds: foodOnly) == nil)
    }

    @Test func totalOnlyReceiptIsSentWithEmptyItemsOnlyForSelectedTransactionCategory() throws {
        let sent = try #require(KMReceiptExportFilter.exportable(
            receipt(categoryId: food.id, items: nil, adjustments: [mixedAdjustments[3]]), categoryIds: foodOnly))
        #expect(sent.items.isEmpty)
        #expect(sent.adjustments.map(\.id) == ["adj-all"])
        #expect(KMReceiptExportFilter.exportable(receipt(categoryId: food.id, items: []), categoryIds: foodOnly)?.items == [])
        #expect(KMReceiptExportFilter.exportable(receipt(categoryId: daily.id, items: nil), categoryIds: foodOnly) == nil)
    }

    @Test func onlyAppliedReceiptsWithConfirmedValueAreEligible() {
        for status in [KMReceipt.RegistrationStatus.pending, .processing, .failed, .deleted] {
            #expect(KMReceiptExportFilter.exportable(receipt(status: status, items: mixedItems), categoryIds: foodOnly) == nil)
        }
        var unconfirmed = receipt(items: mixedItems)
        unconfirmed.confirmedValue = nil
        #expect(KMReceiptExportFilter.exportable(unconfirmed, categoryIds: foodOnly) == nil)
    }
}

struct ReceiptExportPayloadTests {
    private func json(_ payload: KMReceiptExportPayload) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: payload.encoded()) as? [String: Any])
    }

    @Test func payloadMatchesWireContractAndOmitsPrivateFields() throws {
        let value = try #require(KMReceiptExportFilter.exportable(
            receipt(items: mixedItems, adjustments: mixedAdjustments), categoryIds: foodOnly))
        let payload = KMReceiptExportPayload(sentAt: Date(timeIntervalSince1970: 1_793_534_400),
                                             categories: categories, categoryIds: foodOnly, receipts: [value])
        let data = try payload.encoded()
        let text = String(decoding: data, as: UTF8.self)
        #expect(text == #"""
        {"filter":{"categories":[{"id":"cat-food","name":"食費"}],"categoryIds":["cat-food"]},"receipts":[{"adjustments":[{"amountYen":-100,"id":"adj-milk","label":"値引き","targetItemId":"item-milk"},{"amountYen":-30,"id":"adj-all","label":"クーポン"}],"categoryId":"cat-food","id":"receipt-1","items":[{"amountYen":500,"categoryId":"cat-food","id":"item-milk","name":"合成牛乳","quantity":2,"unitPriceYen":250},{"amountYen":200,"categoryId":"cat-food","id":"item-bread","name":"合成パン","quantity":1.5}],"merchant":"合成スーパー","purchasedDate":"2026-10-20","purchasedTime":"18:30","taxAmountYen":112,"totalAmountYen":1234}],"schemaVersion":1,"sentAt":"2026-11-01T12:00:00Z","source":"kakeimatch-ios"}
        """#)
        for forbidden in ["account-secret", "accountId", "合成メモ", "memo", "blob-1", "image", "synthetic-model",
                          "actual-1", "excludedFromSpending", "合成洗剤", "合成不明品", "cat-daily"] {
            #expect(!text.contains(forbidden), "payload must not contain \(forbidden)")
        }
    }

    @Test func missingOptionalValuesAreOmittedNotNull() throws {
        let items = [KMReceiptItem(id: "item-1", name: "合成卵", categoryId: food.id)]
        let value = try #require(KMReceiptExportFilter.exportable(
            receipt(items: items, purchasedTime: nil, taxAmountYen: nil), categoryIds: foodOnly))
        let payload = KMReceiptExportPayload(sentAt: Date(timeIntervalSince1970: 0), categories: categories,
                                             categoryIds: foodOnly, receipts: [value])
        let text = String(decoding: try payload.encoded(), as: UTF8.self)
        #expect(!text.contains("null"))
        let object = try json(payload)
        let sent = try #require((object["receipts"] as? [[String: Any]])?.first)
        #expect(sent["purchasedTime"] == nil)
        #expect(sent["taxAmountYen"] == nil)
        let item = try #require((sent["items"] as? [[String: Any]])?.first)
        #expect(Set(item.keys) == ["id", "name", "categoryId"])
    }
}

struct ReceiptExportPlanTests {
    @Test func unchangedReceiptsAreNotResent() throws {
        let receipts = [receipt(id: "r-b", items: mixedItems, date: "2026-10-21"), receipt(id: "r-a", items: mixedItems)]
        let first = try KMReceiptExportPlan.make(receipts: receipts, categoryIds: foodOnly, sentHashes: [:])
        #expect(first.pending.map(\.id) == ["r-a", "r-b"])
        let second = try KMReceiptExportPlan.make(receipts: receipts, categoryIds: foodOnly, sentHashes: first.hashes)
        #expect(second.pending.isEmpty)
        #expect(second.noLongerEligible.isEmpty)
    }

    @Test func editedContentIsResent() throws {
        let original = receipt(items: mixedItems)
        let sent = try KMReceiptExportPlan.make(receipts: [original], categoryIds: foodOnly, sentHashes: [:]).hashes
        var edited = original
        edited.confirmedValue?.merchant = "合成マーケット"
        #expect(try KMReceiptExportPlan.make(receipts: [edited], categoryIds: foodOnly, sentHashes: sent).pending.map(\.id) == ["receipt-1"])
        // A change only in fields that are never sent does not trigger a resend.
        var memoOnly = original
        memoOnly.confirmedValue?.memo = "別の合成メモ"
        memoOnly.confirmedValue?.accountId = "account-other"
        #expect(try KMReceiptExportPlan.make(receipts: [memoOnly], categoryIds: foodOnly, sentHashes: sent).pending.isEmpty)
    }

    @Test func categoryChangesMoveReceiptsInAndOutOfEligibility() throws {
        let uncategorized = [KMReceiptItem(id: "item-1", name: "合成野菜", amountYen: 300, categoryId: nil)]
        var value = receipt(items: uncategorized)
        // Not eligible yet: nothing to send.
        let before = try KMReceiptExportPlan.make(receipts: [value], categoryIds: foodOnly, sentHashes: [:])
        #expect(before.pending.isEmpty)

        // Later classified as food: becomes eligible and is sent.
        value.confirmedValue?.items?[0].categoryId = food.id
        let classified = try KMReceiptExportPlan.make(receipts: [value], categoryIds: foodOnly, sentHashes: [:])
        #expect(classified.pending.map(\.id) == ["receipt-1"])

        // A second food item gets recategorized: content changes, so the receipt is resent.
        value.confirmedValue?.items?.append(.init(id: "item-2", name: "合成果物", amountYen: 200, categoryId: food.id))
        let grown = try KMReceiptExportPlan.make(receipts: [value], categoryIds: foodOnly, sentHashes: classified.hashes)
        #expect(grown.pending.first?.items.map(\.id) == ["item-1", "item-2"])

        // Every food item moved to another category: no longer eligible; its sent hash is forgotten.
        value.confirmedValue?.items = value.confirmedValue?.items?.map { item in
            var item = item; item.categoryId = daily.id; return item
        }
        let removed = try KMReceiptExportPlan.make(receipts: [value], categoryIds: foodOnly, sentHashes: grown.hashes)
        #expect(removed.pending.isEmpty)
        #expect(removed.noLongerEligible == ["receipt-1"])

        // Selecting the other category instead makes it eligible again.
        let reselected = try KMReceiptExportPlan.make(receipts: [value], categoryIds: [daily.id], sentHashes: [:])
        #expect(reselected.pending.first?.items.map(\.categoryId) == [daily.id, daily.id])
    }
}

struct ReceiptExportEndpointTests {
    @Test func allowsHTTPSOriginWithPortAndFixesPath() throws {
        #expect(try KMReceiptExportEndpoint.importURL(baseURL: "https://example-host:8443").absoluteString
            == "https://example-host:8443/api/v1/receipts/import")
        #expect(try KMReceiptExportEndpoint.importURL(baseURL: " https://home.example.test/ ").absoluteString
            == "https://home.example.test/api/v1/receipts/import")
    }

    @Test func rejectsHTTPPathsQueriesAndCredentials() {
        for invalid in ["", "http://example-host:8443", "example-host:8443", "https://", "https://example-host/api",
                        "https://example-host?token=x", "https://example-host#x", "https://user:pass@example-host",
                        "ftp://example-host"] {
            #expect(!KMReceiptExportEndpoint.isValid(invalid), "\(invalid) must be rejected")
        }
        #expect(KMReceiptExportPresentation.endpointError("") == nil)
        #expect(KMReceiptExportPresentation.endpointError("http://example-host") != nil)
    }
}

struct ReceiptExportPresentationTests {
    private let at = Date(timeIntervalSince1970: 1_793_534_400) // 2026-11-01 21:00 Asia/Tokyo

    @Test func statusTextUsesTokyoTimeAndMarksFailuresWithoutColor() {
        #expect(KMReceiptExportPresentation.statusText(nil) == "まだ送信していません。")
        #expect(KMReceiptExportPresentation.statusText(.init(outcome: .succeeded, attemptedAt: at, sentCount: 3))
            == "11/1 21:00 3件を送信しました。")
        let auth = KMReceiptExportStatus(outcome: .authenticationFailed, attemptedAt: at, pendingCount: 2, httpStatus: 401)
        #expect(KMReceiptExportPresentation.statusText(auth)
            == "! 11/1 21:00 認証に失敗しました（HTTP 401）。トークンを確認してください。未送信の2件は次回送ります。")
        let network = KMReceiptExportStatus(outcome: .networkFailed, attemptedAt: at, sentCount: 50, pendingCount: 5)
        #expect(KMReceiptExportPresentation.statusText(network)
            == "! 11/1 21:00 50件を送信しました。送信先に接続できませんでした。未送信の5件は次回送ります。")
        #expect(KMReceiptExportPresentation.isFailure(auth))
        #expect(!KMReceiptExportPresentation.isFailure(.init(outcome: .nothingToSend, attemptedAt: at)))
    }

    @Test func settingsRowAppearsInLinkSectionWithOnOffValue() {
        let off = KMSettingsPresentation.sections(theme: .system, screenLockEnabled: false)
        let row = off.first { $0.title == "連携" }?.rows.first
        #expect(row?.title == "献立エージェント連携")
        #expect(row?.value == "オフ")
        #expect(row?.destination == .receiptExport)
        let on = KMSettingsPresentation.sections(theme: .system, screenLockEnabled: false, receiptExportEnabled: true)
        #expect(on.first { $0.title == "連携" }?.rows.first?.value == "オン")
    }
}

struct ReceiptExportStateStoreTests {
    @Test func userDefaultsStoreRoundTripsAndStartsDisabled() throws {
        let suite = "ReceiptExportStateStoreTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = KMUserDefaultsReceiptExportStateStore(defaults: defaults)
        #expect(try store.load() == KMReceiptExportState())
        #expect(try store.load().settings.isEnabled == false)
        var state = KMReceiptExportState()
        state.settings = .init(isEnabled: true, baseURL: "https://example-host:8443", categoryIds: [food.id])
        state.sentHashes = ["receipt-1": "hash"]
        state.lastStatus = .init(outcome: .succeeded, attemptedAt: Date(timeIntervalSince1970: 1_793_534_400), sentCount: 1)
        try store.save(state)
        #expect(try store.load() == state)
        // The bearer token is never part of this state.
        let raw = String(decoding: try #require(defaults.data(forKey: KMUserDefaultsReceiptExportStateStore.key)), as: UTF8.self)
        #expect(!raw.contains("token"))
    }
}
