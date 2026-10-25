import Foundation

/// Device-local repository facade. Each write uses a disposable domain working copy and publishes only
/// after a SQLite transaction succeeds. The in-memory adapter remains available for previews/fixtures.
@MainActor final class KMSQLiteStore: TransactionRepository, AccountRepository, CategoryRepository, PayeeRepository,
    ReceiptRepository, StatementRepository, ReconciliationRepository, BudgetRepository, RecurringRepository,
    PayrollRepository, CategoryLearningRepository, SettingsRepository {
    struct ProfilePointer: Codable { var current: UUID; var previous: UUID? }
    let directory: URL
    private var busy = false
    private var pointerURL: URL { directory.appendingPathComponent("active.json") }
    static func openDefault() throws -> KMSQLiteStore {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return try KMSQLiteStore(directory: base.appendingPathComponent("KakeiMatch", isDirectory: true))
    }
    init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: pointerURL.path) {
            let id = UUID()
            let target = profileDirectory(id)
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
            do {
                _ = try KMStoreDatabase(url: target.appendingPathComponent("household.sqlite"))
                try publish(ProfilePointer(current: id, previous: nil))
            } catch { try cleanup(target, after: error) }
        }
        _ = try database().load()
    }
    func profile() throws -> ProfilePointer { try KMJSON.decoder().decode(ProfilePointer.self, from: Data(contentsOf: pointerURL)) }
    private func profileDirectory(_ id: UUID) -> URL { directory.appendingPathComponent(id.uuidString, isDirectory: true) }
    private func publish(_ pointer: ProfilePointer) throws {
        try KMJSON.encoder().encode(pointer).write(to: pointerURL, options: .atomic)
    }
    private func database() throws -> KMStoreDatabase {
        let path = profileDirectory(try profile().current).appendingPathComponent("household.sqlite")
        guard FileManager.default.fileExists(atPath: path.path) else { throw KMDataError.notFound("有効な家計簿がありません。保存済みデータを削除しないでください。") }
        return try KMStoreDatabase(url: path)
    }
    private func access<T>(_ writing: Bool = false, _ action: (KMInMemoryStore) async throws -> T) async throws -> T {
        guard !busy else { throw KMDataError.invalidData("家計データを処理中です。完了後に再試行してください。") }
        busy = true; defer { busy = false }
        let db = try database(), working = try db.load()
        let value = try await action(working)
        if writing { try db.save(working) }
        return value
    }
    /// No merging: validate into a new profile, verify persisted bytes, then atomically replace one pointer.
    /// Both the old profile and its credentials-independent household remain available for undo.
    func importBackup(from url: URL) async throws {
        guard !busy else { throw KMDataError.invalidData("家計データを処理中です。") }
        busy = true; defer { busy = false }
        let backup = try KMPortableBackup.read(url: url)
        let old = try profile(), id = UUID(), target = profileDirectory(id)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
        do {
            let working = try KMActualImport.project(backup: backup, staging: target)
            // Appearance is device-local, not imported household data.
            working.settingsValue.theme = try database().load().settingsValue.theme
            let db = try KMStoreDatabase(url: target.appendingPathComponent("household.sqlite"))
            try db.saveArtifacts(backup.artifacts)
            try db.save(working)
            try db.preserve("actual-budget.zip", data: backup.actualZIP)
            try db.preserve("local-data.json", data: backup.localJSON)
            try db.preserve("manifest.json", data: backup.manifestJSON)
            // Full object and raw-byte readback before publication; hashes are verified by the reader too.
            let readback = try db.load()
            guard try fingerprint(working) == fingerprint(readback) else { throw KMDataError.invalidData("復元した記録の読み戻しに失敗しました。") }
            for artifact in backup.artifacts {
                guard try db.original(artifact.metadata.id) == artifact.data else { throw KMDataError.invalidData("復元した原本の読み戻しに失敗しました。") }
            }
            try publish(ProfilePointer(current: id, previous: old.current))
        } catch { try cleanup(target, after: error) }
    }
    func returnToPreviousProfile() throws {
        guard !busy else { throw KMDataError.invalidData("家計データを処理中です。") }
        let value = try profile()
        guard let previous = value.previous else { throw KMDataError.notFound("変更前の家計簿がありません。") }
        let path = profileDirectory(previous).appendingPathComponent("household.sqlite")
        guard FileManager.default.fileExists(atPath: path.path) else { throw KMDataError.notFound("変更前の家計簿が見つかりません。") }
        let previousDB = try KMStoreDatabase(url: path), previousStore = try previousDB.load()
        let theme = try database().load().settingsValue.theme
        if previousStore.settingsValue.theme != theme {
            previousStore.settingsValue.theme = theme
            try previousDB.save(previousStore)
        }
        try publish(ProfilePointer(current: previous, previous: value.current))
    }
    /// CSVs and images are accessible by portable blob ID, never by an archive-supplied filesystem path.
    func originalArtifact(id: String) throws -> Data? { try database().original(id) }
    /// Read-only import provenance for later service projections; NOT the current edited household/export.
    func importedRecords() throws -> [KMPortableRecord] {
        let db = try database()
        guard let manifest = try db.provenance("manifest.json"), let local = try db.provenance("local-data.json") else { return [] }
        return try KMBackupSchema.validate(manifest: manifest, local: local).1
    }
    private func cleanup(_ target: URL, after error: Error) throws -> Never {
        do { try FileManager.default.removeItem(at: target) }
        catch { throw KMDataError.invalidData("復元に失敗しました。元の家計簿は保持されていますが、一時保存先の削除にも失敗しました。") }
        throw error
    }
    private func fingerprint(_ store: KMInMemoryStore) throws -> Data {
        // Covers every imported projection. Lossless original records remain in provenance.
        struct Snapshot: Encodable {
            var transactions: [KMTransaction]; var accounts: [KMAccount]; var categories: [KMCategory]; var groups: [KMCategoryGroup]
            var receipts: [KMReceipt]; var statements: [KMStatementTransaction]; var imports: [KMLocalRecord<KMStatementImport>]
            var runs: [KMReconciliationRun]; var resolutions: [KMReconciliationResolution]; var payees: [KMPayee]
            var budget: KMMonthlyBudgetSettings; var nativeBudgets: [String: [String: Int]]; var payroll: [KMPayrollRecord]
            var suspected: [KMSuspectedStatement]; var overrides: [KMCategoryRuleOverride]; var settings: KMAppSettings
        }
        let encoder = KMJSON.encoder(); encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(Snapshot(transactions: store.transactionValues, accounts: store.accountValues, categories: store.categoryValues,
            groups: store.groupValues, receipts: store.receiptValues, statements: store.statementValues, imports: store.importValues,
            runs: store.runValues, resolutions: store.resolutionValues, payees: store.payeeValues, budget: store.monthlySettings,
            nativeBudgets: store.nativeBudgets, payroll: store.payrollValues, suspected: store.suspectedValues, overrides: store.ruleOverrides, settings: store.settingsValue))
    }

    func transactions(matching query: KMTransactionQuery) async throws -> [KMTransaction] { try await access { try await $0.transactions(matching: query) } }
    func transaction(id: String) async throws -> KMTransaction? { try await access { try await $0.transaction(id: id) } }
    func recordDays(matching query: KMTransactionQuery) async throws -> [KMRecordDay] { try await access { try await $0.recordDays(matching: query) } }
    func home(month: KMYearMonth) async throws -> KMHomeSnapshot { try await access { try await $0.home(month: month) } }
    func saveManual(_ input: KMManualTransactionInput, id: String? = nil) async throws -> KMTransaction { try await access(true) { try await $0.saveManual(input, id: id) } }
    func saveTransfer(_ input: KMTransferInput, id: String? = nil) async throws -> KMTransaction { try await access(true) { try await $0.saveTransfer(input, id: id) } }
    func setSpendingExclusion(id: String, excluded: Bool) async throws { try await access(true) { try await $0.setSpendingExclusion(id: id, excluded: excluded) } }
    func deleteTransaction(id: String) async throws { try await access(true) { try await $0.deleteTransaction(id: id) } }
    func accounts(includeClosed: Bool = true) async throws -> [KMAccount] { try await access { try await $0.accounts(includeClosed: includeClosed) } }
    func saveAccount(_ account: KMAccount) async throws { try await access(true) { try await $0.saveAccount(account) } }
    func deleteAccount(id: String) async throws { try await access(true) { try await $0.deleteAccount(id: id) } }
    func categories(includeHidden: Bool = true) async throws -> [KMCategory] { try await access { try await $0.categories(includeHidden: includeHidden) } }
    func categoryGroups() async throws -> [KMCategoryGroup] { try await access { try await $0.categoryGroups() } }
    func saveCategory(_ category: KMCategory) async throws { try await access(true) { try await $0.saveCategory(category) } }
    func deleteCategory(id: String) async throws { try await access(true) { try await $0.deleteCategory(id: id) } }
    func payees() async throws -> [KMPayee] { try await access { try await $0.payees() } }
    func receipts() async throws -> [KMReceipt] { try await access { try await $0.receipts() } }
    func receipt(id: String) async throws -> KMReceipt? { try await access { try await $0.receipt(id: id) } }
    func saveReceipt(_ receipt: KMReceipt) async throws { try await access(true) { try await $0.saveReceipt(receipt) } }
    func receiptImage(blobId: String) async throws -> Data? { try await access { try await $0.receiptImage(blobId: blobId) } }
    func deleteReceipt(id: String) async throws { try await access(true) { try await $0.deleteReceipt(id: id) } }
    func statementImports() async throws -> [KMLocalRecord<KMStatementImport>] { try await access { try await $0.statementImports() } }
    func statementTransactions() async throws -> [KMStatementTransaction] { try await access { try await $0.statementTransactions() } }
    func latestRun() async throws -> KMReconciliationRun? { try await access { try await $0.latestRun() } }
    func resolutions() async throws -> [KMReconciliationResolution] { try await access { try await $0.resolutions() } }
    func saveResolution(_ resolution: KMReconciliationResolution) async throws { try await access(true) { try await $0.saveResolution(resolution) } }
    func suspectedStatements() async throws -> [KMSuspectedStatement] { try await access { try await $0.suspectedStatements() } }
    func setSuspected(statementId: String, markedAt: Date?) async throws { try await access(true) { try await $0.setSuspected(statementId: statementId, markedAt: markedAt) } }
    func budgetSummary(month: KMYearMonth) async throws -> KMMonthlyBudgetSummary { try await access { try await $0.budgetSummary(month: month) } }
    func budgetSettings() async throws -> KMMonthlyBudgetSettings { try await access { try await $0.budgetSettings() } }
    func saveBudgetSettings(_ settings: KMMonthlyBudgetSettings) async throws { try await access(true) { try await $0.saveBudgetSettings(settings) } }
    func recurringTransactions() async throws -> [KMRecurringTransaction] { try await access { try await $0.recurringTransactions() } }
    func saveRecurring(_ value: KMRecurringTransaction) async throws { try await access(true) { try await $0.saveRecurring(value) } }
    func deleteRecurring(id: String) async throws { try await access(true) { try await $0.deleteRecurring(id: id) } }
    func payrollRecords() async throws -> [KMPayrollRecord] { try await access { try await $0.payrollRecords() } }
    func savePayrollRecord(_ record: KMPayrollRecord) async throws { try await access(true) { try await $0.savePayrollRecord(record) } }
    func categoryRules() async throws -> [KMCategoryLearningRule] { try await access { try await $0.categoryRules() } }
    func setCategoryRuleOverride(_ value: KMCategoryRuleOverride) async throws { try await access(true) { try await $0.setCategoryRuleOverride(value) } }
    func resetCategoryRuleOverride(targetType: KMCategoryRuleStats.TargetType, normalizedName: String) async throws { try await access(true) { try await $0.resetCategoryRuleOverride(targetType: targetType, normalizedName: normalizedName) } }
    func resetCategoryRuleOverrides() async throws { try await access(true) { try await $0.resetCategoryRuleOverrides() } }
    func settings() async throws -> KMAppSettings { try await access { try await $0.settings() } }
    func saveSettings(_ settings: KMAppSettings) async throws { try await access(true) { try await $0.saveSettings(settings) } }
}
