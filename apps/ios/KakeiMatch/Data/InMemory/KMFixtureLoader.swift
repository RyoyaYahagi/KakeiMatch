import Foundation

// TS: test/fixtures/ios-migration/fixture.json (PR #279), a screen seed, not a .kmb payload.
struct KMMigrationFixture: Decodable, Sendable {
    struct Account: Decodable, Sendable { var name: String; var type: KMAccountType; var provider: KMStatementProvider? }
    struct Transaction: Decodable, Sendable {
        var date: KMDate; var payee: String; var amountYen: Int; var category: String; var account: String; var type: KMTransactionKind
    }
    struct Item: Decodable, Sendable { var name: String; var amountYen: Int }
    struct Receipt: Decodable, Sendable {
        var merchant: String; var date: KMDate; var time: String; var totalYen: Int; var taxYen: Int; var items: [Item]
    }
    struct Statement: Decodable, Sendable { var date: String; var merchant: String; var amountYen: Int }
    struct Payroll: Decodable, Sendable {
        var employerName: String; var period: String; var grossPayYen: Int; var deductionsYen: Int; var netPayYen: Int
    }
    var version: Int
    var timezone: String
    var now: Date
    var accounts: [Account]
    var categories: [String]
    var incomeCategory: String
    var transactions: [Transaction]
    var budgetYen: Int
    var warningBudgetYen: Int
    var searchKeyword: String
    var payroll: Payroll
    var receipt: Receipt
    var statement: [Statement]
}

@MainActor enum KMFixtureLoader {
    enum Scenario: String, CaseIterable, Sendable {
        case migration, populated, empty, budgetWarning = "budget-warning", receipt, receiptApplied = "receipt-applied", reconciliation, payroll
    }
    static func document(bundle: Bundle = .main) throws -> KMMigrationFixture {
        let value = try KMJSON.decoder().decode(KMMigrationFixture.self, from: resource("migration", bundle: bundle))
        guard value.version == 1, value.timezone == "Asia/Tokyo" else { throw KMDataError.invalidData("未対応のfixture形式です。") }
        return value
    }
    static func load(named name: String, bundle: Bundle = .main) throws -> KMRepositories {
        guard let scenario = Scenario(rawValue: name) else { throw KMDataError.invalidData("fixture名が不正です: \(name)") }
        let fixture = try document(bundle: bundle)
        let store = try makeStore(fixture, scenario: scenario)
        if scenario == .reconciliation {
            var service = KMLocalReconciliation(statements: store.statementValues, imports: store.importValues,
                transactions: store.transactionValues, accounts: store.accountValues, categories: store.categoryValues)
            let run = try service.run(id: "fixture-run", at: fixture.now)
            store.runValues = [run]; store.resolutionValues = service.resolutions
            store.transactionValues = service.transactions; store.reconciliationState = service
        }
        return KMRepositories(inMemory: store, referenceDate: fixture.now, fixtureName: name)
    }
    static func launch(arguments: [String] = ProcessInfo.processInfo.arguments, bundle: Bundle = .main) throws -> KMRepositories {
        #if DEBUG
        if let index = arguments.firstIndex(of: "-UITestFixture") {
            guard arguments.indices.contains(index + 1) else { throw KMDataError.invalidData("-UITestFixture の名前がありません。") }
            return try load(named: arguments[index + 1], bundle: bundle)
        }
        #endif
        return try KMRepositories(persistent: KMSQLiteStore.openDefault())
    }
    private static func resource(_ name: String, bundle: Bundle) throws -> Data {
        guard let url = bundle.url(forResource: name, withExtension: "json") else { throw KMDataError.notFound("fixture \(name).json がありません。") }
        return try Data(contentsOf: url)
    }
    static func makeStore(_ fixture: KMMigrationFixture, scenario: Scenario) throws -> KMInMemoryStore {
        guard fixture.version == 1, fixture.timezone == "Asia/Tokyo" else { throw KMDataError.invalidData("未対応のfixture形式です。") }
        guard scenario != .empty else { return KMInMemoryStore() }
        let accounts = fixture.accounts.enumerated().map { index, value in
            KMAccount(id: "fixture-account-\(index)", name: value.name, accountType: value.type, statementProvider: value.provider)
        }
        // PWA seeds all basic categories on first use; fixture.categories lists only categories used by its transactions.
        let basic = ["食費", "外食", "日用品", "衣服・美容", "交通", "医療・健康", "家電・デジタル", "趣味・娯楽", "AI・ソフトウェア", "通信", "教育・学習", "交際費", "住居", "水道・光熱", "その他"]
        var names = basic
        for name in fixture.categories where !names.contains(name) { names.append(name) }
        names.append(fixture.incomeCategory)
        guard Set(names).count == names.count, Set(accounts.map(\.name)).count == accounts.count else { throw KMDataError.invalidData("fixtureの名前が重複しています。") }
        let categories = names.enumerated().map { index, name in
            KMCategory(id: "fixture-category-\(index)", name: name, isIncome: name == fixture.incomeCategory,
                groupName: name == fixture.incomeCategory ? "収入" : "支出", groupId: name == fixture.incomeCategory ? "fixture-income" : "fixture-expenses")
        }
        let groups = [KMCategoryGroup(id: "fixture-expenses", name: "支出", categoryIds: categories.filter { !$0.isIncome }.map(\.id)),
                      KMCategoryGroup(id: "fixture-income", name: "収入", isIncome: true, categoryIds: categories.filter(\.isIncome).map(\.id))]
        var transactions = try fixture.transactions.enumerated().map { index, value -> KMTransaction in
            guard value.type != .transfer, value.amountYen > 0,
                  let account = accounts.first(where: { $0.name == value.account }), let category = categories.first(where: { $0.name == value.category }) else {
                throw KMDataError.invalidData("fixtureの取引の対応が不正です。")
            }
            _ = try KMYen.checked(value.amountYen)
            return KMTransaction(id: String(format: "fixture-transaction-%03d", index), date: value.date,
                amountYen: value.type == .expense ? -value.amountYen : value.amountYen, kind: value.type,
                payeeName: value.payee, categoryName: category.name, accountId: account.id, categoryId: category.id,
                importedId: "fixture-manual-\(index)", isSplit: false)
        }
        // 登録済みレシートの編集導線を合成状態で固定する。金額と内訳はfixture.receiptと同じ。
        let appliedReceiptAccount = accounts.first { $0.accountType == .creditCard } ?? accounts[0]
        let appliedReceiptCategories = fixture.receipt.items.map { item in
            categories.first { $0.name == (item.name == "台所用洗剤" ? "日用品" : "食費") }!
        }
        if scenario == .receiptApplied {
            let foodTotal = zip(fixture.receipt.items, appliedReceiptCategories).filter { $0.1.name == "食費" }.reduce(0) { $0 + $1.0.amountYen }
            let householdTotal = fixture.receipt.totalYen - foodTotal
            transactions.append(KMTransaction(id: "fixture-transaction-receipt", date: fixture.receipt.date,
                amountYen: -fixture.receipt.totalYen, kind: .expense, payeeName: fixture.receipt.merchant,
                categoryName: nil, accountId: appliedReceiptAccount.id, importedId: "kakeimatch:fixture-receipt-applied",
                isSplit: true, splits: [
                    .init(id: "fixture-receipt-split-food", categoryId: categories.first { $0.name == "食費" }!.id, amountYen: -foodTotal),
                    .init(id: "fixture-receipt-split-household", categoryId: categories.first { $0.name == "日用品" }!.id, amountYen: -householdTotal),
                ]))
        }
        let store = KMInMemoryStore(transactions: transactions, accounts: accounts, categories: categories, groups: groups)
        store.monthlySettings = try store.monthlySettings.applyingDefaultPlan(
            totalYen: scenario == .budgetWarning ? fixture.warningBudgetYen : fixture.budgetYen, breakdownEnabled: false, allocations: [:])
        if scenario == .receipt {
            let extraction = KMReceiptExtraction(documentKind: .receipt, merchant: fixture.receipt.merchant,
                purchasedDate: fixture.receipt.date, purchasedTime: fixture.receipt.time, totalAmountYen: fixture.receipt.totalYen,
                taxAmountYen: fixture.receipt.taxYen, items: fixture.receipt.items.map { .init(name: $0.name, amountYen: $0.amountYen) },
                warnings: [])
            store.receiptValues = [KMReceipt(id: "fixture-receipt", createdAt: fixture.now, updatedAt: fixture.now, extraction: extraction,
                itemCategories: fixture.receipt.items.map { item in categories.first { $0.name == (item.name == "台所用洗剤" ? "日用品" : "食費") }?.id },
                aiSuggestion: .init(source: .unclassified), registration: .init(status: .pending))]
        }
        if scenario == .receiptApplied {
            let items = fixture.receipt.items.enumerated().map { index, item in
                KMReceiptItem(id: "receipt-item:fixture-receipt-applied:\(index)", name: item.name,
                    amountYen: item.amountYen, categoryId: appliedReceiptCategories[index].id)
            }
            let value = KMConfirmedReceipt(merchant: fixture.receipt.merchant, purchasedDate: fixture.receipt.date,
                purchasedTime: fixture.receipt.time, totalAmountYen: fixture.receipt.totalYen,
                categoryId: appliedReceiptCategories[0].id, accountId: appliedReceiptAccount.id,
                excludedFromSpending: false, memo: nil, taxAmountYen: fixture.receipt.taxYen, items: items, adjustments: nil)
            let imageData = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAABQAAAAeCAIAAACjcKk8AAAAHklEQVR4nGM4cekO2YhhVPOo5lHNo5pHNY9qHs6aAZw4xNzPmEv+AAAAAElFTkSuQmCC")!
            store.imageValues["fixture-receipt-image"] = imageData
            store.receiptValues = [KMReceipt(id: "fixture-receipt-applied", createdAt: fixture.now, updatedAt: fixture.now,
                image: .init(blobId: "fixture-receipt-image", contentType: "image/png", sizeBytes: imageData.count),
                extraction: nil, aiFlowId: nil, itemCategories: appliedReceiptCategories.map(\.id), reviewedWarnings: nil,
                classificationAttempt: nil, aiSuggestion: .init(source: .unclassified), confirmedValue: value,
                registration: .init(status: .applied, actualTransactionId: "fixture-transaction-receipt"))]
        }
        if scenario == .reconciliation {
            let importId = "fixture-statement-import"
            store.importValues = [KMLocalRecord(id: importId, kind: .statementImport,
                value: KMStatementImport(provider: .paypayCard, fileHash: String(repeating: "0", count: 64), encoding: "utf-8",
                    headerSignature: "synthetic fixture (not a CSV source)", totalRows: fixture.statement.count, excludedRows: 0, duplicateRowsInFile: 0, createdAt: fixture.now), updatedAt: fixture.now)]
            store.statementValues = try fixture.statement.enumerated().map { index, value in
                KMStatementTransaction(id: "fixture-statement-\(index)", importId: importId, provider: .paypayCard, kind: .purchase,
                    usedDate: try KMDate(value.date.replacingOccurrences(of: "/", with: "-")), merchant: value.merchant,
                    amountYen: value.amountYen, sourceFingerprint: "synthetic-statement-\(index)", duplicateOrdinal: 0)
            }
        }
        if scenario == .payroll {
            let value = fixture.payroll
            let incomeCategory = categories.first { $0.isIncome }!.id
            let bankAccount = accounts.first { $0.accountType == .bank }!.id
            store.payrollValues = [KMPayrollRecord(id: "11111111-1111-4111-8111-111111111113", status: .pending,
                confirmed: .init(documentKind: .paySlip, employerName: value.employerName, paymentDate: KMDate(instant: fixture.now),
                    payPeriod: value.period, payType: .salary, grossPayYen: value.grossPayYen, netPayYen: value.netPayYen,
                    deductions: .init(totalYen: value.deductionsYen), allowances: [], warnings: []),
                categoryId: incomeCategory, accountId: bankAccount,
                extractionModel: "synthetic-fixture", promptVersion: "fixture-v1", createdAt: fixture.now, updatedAt: fixture.now),
                // 登録済みの収入記録に結び付いた内訳。記録詳細の表示を合成状態で固定する。
                KMPayrollRecord(id: "11111111-1111-4111-8111-111111111112", actualTransactionId: "fixture-transaction-006", status: .applied,
                    confirmed: .init(documentKind: .paySlip, employerName: "みどり製作所（テスト専用）",
                        paymentDate: KMDate(rawValue: "2026-10-10"), payPeriod: "2026年9月", payType: .salary,
                        grossPayYen: 310_000, netPayYen: 248_000,
                        deductions: .init(incomeTaxYen: 8_000, residentTaxYen: 10_000, healthInsuranceYen: 15_000,
                            pensionYen: 27_000, employmentInsuranceYen: 2_000, otherYen: nil, totalYen: 62_000),
                        allowances: [.init(name: "通勤手当", amountYen: 10_000), .init(name: "住宅手当", amountYen: nil)],
                        warnings: []),
                    categoryId: incomeCategory, accountId: bankAccount,
                    extractionModel: "synthetic-fixture", promptVersion: "fixture-v1", createdAt: fixture.now, updatedAt: fixture.now)]
        }
        return store
    }
}
