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
        let file = try Data(contentsOf: url, options: [.mappedIfSafe])
        let magic = Data(file.prefix(8))
        if magic == KMNativeBackup.magic {
            let backup = try KMNativeBackup.read(url: url)
            try importNativeBackup(backup)
            return
        }
        guard magic == Data("KMATCHB1".utf8) else { throw KMPortableBackup.invalid() }
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
            guard try fingerprint(working) == fingerprint(readback), working.serviceState == readback.serviceState else { throw KMDataError.invalidData("復元した記録の読み戻しに失敗しました。") }
            for artifact in backup.artifacts {
                guard try db.original(artifact.metadata.id) == artifact.data else { throw KMDataError.invalidData("復元した原本の読み戻しに失敗しました。") }
            }
            try publish(ProfilePointer(current: id, previous: old.current))
        } catch { try cleanup(target, after: error) }
    }
    /// Creates a complete native-only backup in a temporary .kmib file and returns its URL.
    /// Export time means generation completed; the caller still owns saving/sharing the file.
    func exportNativeBackup() async throws -> URL {
        guard !busy else { throw KMDataError.invalidData("家計データを処理中です。") }
        busy = true; defer { busy = false }
        let timestamp = Date()
        let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: tempDirectory) }
        let snapshotURL = tempDirectory.appendingPathComponent("snapshot.sqlite")
        try database().snapshot(to: snapshotURL)
        let snapshot = try Data(contentsOf: snapshotURL, options: [.mappedIfSafe])
        let artifacts = try KMStoreDatabase(url: snapshotURL).artifacts()
        let archive = try KMNativeBackup.package(database: snapshot, artifacts: artifacts, exportedAt: timestamp)
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("KakeiMatch-\(UUID().uuidString).kmib")
        try archive.write(to: output, options: .atomic)
        do {
            let current = try database().load()
            current.settingsValue.lastExportAt = timestamp
            try database().save(current)
        } catch {
            try FileManager.default.removeItem(at: output)
            throw error
        }
        return output
    }

    private func importNativeBackup(_ backup: KMNativeBackupContents) throws {
        let old = try profile(), id = UUID(), target = profileDirectory(id)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
        do {
            let databaseURL = target.appendingPathComponent("household.sqlite")
            try backup.database.write(to: databaseURL, options: [.atomic])
            let incoming = try KMStoreDatabase(url: databaseURL)
            let imported = try incoming.load()
            let preservedArtifacts = try incoming.backupArtifacts()
            let currentStore = try database().load()
            imported.settingsValue.theme = currentStore.settingsValue.theme
            try incoming.save(imported)
            // Saving the device-local theme prunes removed receipt images; retain CSV originals too.
            try incoming.saveArtifacts(preservedArtifacts)
            let actualArtifacts = try incoming.artifacts()
            guard actualArtifacts.count == backup.artifacts.count else {
                throw KMDataError.invalidData("バックアップ内の原本件数とSQLiteの原本件数が一致しません。")
            }
            let expected = Dictionary(uniqueKeysWithValues: actualArtifacts.map { ($0.0, $0.1) })
            for (path, bytes) in backup.artifacts {
                guard let encoded = path.split(separator: "/").last,
                      let artifactId = Self.decodeArtifactPath(String(encoded)), expected[artifactId] == bytes else {
                    throw KMDataError.invalidData("バックアップ内の原本とSQLiteの原本を照合できません。")
                }
            }
            let reopened = try KMStoreDatabase(url: databaseURL)
            let verified = try reopened.load()
            guard try fingerprint(imported) == fingerprint(verified) else { throw KMDataError.invalidData("復元した記録の読み戻しに失敗しました。") }
            try publish(ProfilePointer(current: id, previous: old.current))
        } catch { try cleanup(target, after: error) }
    }
    private static func decodeArtifactPath(_ component: String) -> String? {
        guard component.count.isMultiple(of: 2) else { return nil }
        var bytes: [UInt8] = []
        var index = component.startIndex
        while index < component.endIndex {
            let next = component.index(index, offsetBy: 2)
            guard let byte = UInt8(component[index..<next], radix: 16) else { return nil }
            bytes.append(byte); index = next
        }
        return String(data: Data(bytes), encoding: .utf8)
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
            var recurring: [KMRecurringTransaction]; var rules: [KMCategoryLearningRule]
            var suspected: [KMSuspectedStatement]; var overrides: [KMCategoryRuleOverride]; var settings: KMAppSettings
            var ledgerWrites: KMLedgerWriteState; var serviceState: KMServiceState; var masterWrites: KMMasterWriteState
        }
        let encoder = KMJSON.encoder(); encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(Snapshot(transactions: store.transactionValues, accounts: store.accountValues, categories: store.categoryValues,
            groups: store.groupValues, receipts: store.receiptValues, statements: store.statementValues, imports: store.importValues,
            runs: store.runValues, resolutions: store.resolutionValues, payees: store.payeeValues, budget: store.monthlySettings,
            nativeBudgets: store.nativeBudgets, payroll: store.payrollValues, recurring: store.recurringValues, rules: store.ruleValues,
            suspected: store.suspectedValues, overrides: store.ruleOverrides, settings: store.settingsValue,
            ledgerWrites: store.ledgerWriteState, serviceState: store.serviceState, masterWrites: store.masterWriteState))
    }

    func transactions(matching query: KMTransactionQuery) async throws -> [KMTransaction] { try await access { try await $0.transactions(matching: query) } }
    func transaction(id: String) async throws -> KMTransaction? { try await access { try await $0.transaction(id: id) } }
    func recordDays(matching query: KMTransactionQuery) async throws -> [KMRecordDay] { try await access { try await $0.recordDays(matching: query) } }
    func home(month: KMYearMonth) async throws -> KMHomeSnapshot { try await access { try await $0.home(month: month) } }
    func homeDashboard(month: KMYearMonth, today: KMDate) async throws -> KMHomeDashboard {
        try await access { try await $0.homeDashboard(month: month, today: today) }
    }
    func saveManual(_ input: KMManualTransactionInput, id: String? = nil) async throws -> KMTransaction { try await access(true) { try await $0.saveManual(input, id: id) } }
    func saveTransfer(_ input: KMTransferInput, id: String? = nil) async throws -> KMTransaction { try await access(true) { try await $0.saveTransfer(input, id: id) } }
    func setSpendingExclusion(id: String, excluded: Bool) async throws { try await access(true) { try await $0.setSpendingExclusion(id: id, excluded: excluded) } }
    func deleteTransaction(id: String) async throws { try await access(true) { try await $0.deleteTransaction(id: id) } }
    func deleteTransaction(id: String, expected: [KMTransaction]?, at timestamp: Date) async throws -> KMTransactionDeletion {
        try await access(true) { try await $0.deleteTransaction(id: id, expected: expected, at: timestamp) }
    }
    func transactionDeletions() async throws -> [KMTransactionDeletion] { try await access { try await $0.transactionDeletions() } }
    func undoTransactionDeletion(id: String, at timestamp: Date) async throws {
        try await access(true) { try await $0.undoTransactionDeletion(id: id, at: timestamp) }
    }
    func registerReceipt(id: String, at timestamp: Date) async throws -> KMReceipt {
        try await access(true) { try await $0.registerReceipt(id: id, at: timestamp) }
    }
    func editReceipt(id: String, value: KMConfirmedReceipt, expectedUpdatedAt: Date, at timestamp: Date) async throws -> KMReceipt {
        try await access(true) { try await $0.editReceipt(id: id, value: value, expectedUpdatedAt: expectedUpdatedAt, at: timestamp) }
    }
    func importExternalTransaction(_ input: KMExternalTransactionInput) async throws -> KMExternalTransactionResult {
        try await access(true) { try await $0.importExternalTransaction(input) }
    }
    func accounts(asOf date: KMDate, includeClosed: Bool = true) async throws -> [KMAccount] {
        try await access { try await $0.accounts(asOf: date, includeClosed: includeClosed) }
    }
    func createAccount(_ account: KMAccount, startingBalanceYen: Int = 0, startingDate: KMDate) async throws {
        try await access(true) { try await $0.createAccount(account, startingBalanceYen: startingBalanceYen, startingDate: startingDate) }
    }
    func accounts(includeClosed: Bool = true) async throws -> [KMAccount] { try await access { try await $0.accounts(includeClosed: includeClosed) } }
    func saveAccount(_ account: KMAccount) async throws { try await access(true) { try await $0.saveAccount(account) } }
    func deleteAccount(id: String) async throws { try await access(true) { try await $0.deleteAccount(id: id) } }
    func categories(includeHidden: Bool = true) async throws -> [KMCategory] { try await access { try await $0.categories(includeHidden: includeHidden) } }
    func categoryGroups() async throws -> [KMCategoryGroup] { try await access { try await $0.categoryGroups() } }
    func saveCategory(_ category: KMCategory) async throws { try await access(true) { try await $0.saveCategory(category) } }
    func deleteCategory(id: String) async throws { try await access(true) { try await $0.deleteCategory(id: id) } }
    func saveCategoryGroup(_ group: KMCategoryGroup) async throws { try await access(true) { try await $0.saveCategoryGroup(group) } }
    func deleteCategoryGroup(id: String) async throws { try await access(true) { try await $0.deleteCategoryGroup(id: id) } }
    func reorderCategoryGroups(ids: [String]) async throws { try await access(true) { try await $0.reorderCategoryGroups(ids: ids) } }
    func reorderCategories(groupId: String, ids: [String]) async throws { try await access(true) { try await $0.reorderCategories(groupId: groupId, ids: ids) } }
    func payees() async throws -> [KMPayee] { try await access { try await $0.payees() } }
    func receipts() async throws -> [KMReceipt] { try await access { try await $0.receipts() } }
    func receipt(id: String) async throws -> KMReceipt? { try await access { try await $0.receipt(id: id) } }
    func saveReceipt(_ receipt: KMReceipt) async throws { try await access(true) { try await $0.saveReceipt(receipt) } }
    func receiptImage(blobId: String) async throws -> Data? { try await access { try await $0.receiptImage(blobId: blobId) } }
    func deleteReceipt(id: String) async throws { try await access(true) { try await $0.deleteReceipt(id: id) } }
    func statementImports() async throws -> [KMLocalRecord<KMStatementImport>] { try await access { try await $0.statementImports() } }
    func statementTransactions() async throws -> [KMStatementTransaction] { try await access { try await $0.statementTransactions() } }
    func importStatement(data: Data, provider: KMStatementProvider, at timestamp: Date) async throws -> KMStatementImportResult {
        try await access(true) { try await $0.importStatement(data: data, provider: provider, at: timestamp) }
    }
    func previewMoneyForward(rows: [KMMoneyForwardRow], mappings: KMMoneyForwardMappings, choices: [String: KMMoneyForwardRecordChoice] = [:], at timestamp: Date) async throws -> [KMMoneyForwardPreview] {
        try await access { try await $0.previewMoneyForward(rows: rows, mappings: mappings, choices: choices, at: timestamp) }
    }
    func importMoneyForward(id: String, rows: [KMMoneyForwardRow], mappings: KMMoneyForwardMappings, choices: [String: KMMoneyForwardRecordChoice] = [:], rememberMappings: Bool = true, at timestamp: Date) async throws -> KMMoneyForwardBatch {
        try await access(true) { try await $0.importMoneyForward(id: id, rows: rows, mappings: mappings, choices: choices, rememberMappings: rememberMappings, at: timestamp) }
    }
    func moneyForwardHistory() async throws -> [KMMoneyForwardBatch] { try await access { try await $0.moneyForwardHistory() } }
    func moneyForwardRules() async throws -> KMMoneyForwardMappings { try await access { try await $0.moneyForwardRules() } }
    func undoMoneyForward(id: String, at timestamp: Date) async throws { try await access(true) { try await $0.undoMoneyForward(id: id, at: timestamp) } }
    func latestRun() async throws -> KMReconciliationRun? { try await access { try await $0.latestRun() } }
    func runReconciliation(id: String, at timestamp: Date) async throws -> KMReconciliationRun { try await access(true) { try await $0.runReconciliation(id: id, at: timestamp) } }
    func confirmSameExpense(runId: String, statementId: String, receiptId: String, at timestamp: Date) async throws -> KMReconciliationResolution { try await access(true) { try await $0.confirmSameExpense(runId: runId, statementId: statementId, receiptId: receiptId, at: timestamp) } }
    func rejectCandidate(runId: String, statementId: String, receiptId: String) async throws { try await access(true) { try await $0.rejectCandidate(runId: runId, statementId: statementId, receiptId: receiptId) } }
    func ignoreStatement(runId: String, statementId: String, at timestamp: Date) async throws -> KMReconciliationResolution { try await access(true) { try await $0.ignoreStatement(runId: runId, statementId: statementId, at: timestamp) } }
    func registerStatement(runId: String, statementId: String, categoryId: String?, destinationAccountId: String?, excludedFromSpending: Bool?, newAccountId: String, at timestamp: Date) async throws -> KMReconciliationResolution { try await access(true) { try await $0.registerStatement(runId: runId, statementId: statementId, categoryId: categoryId, destinationAccountId: destinationAccountId, excludedFromSpending: excludedFromSpending, newAccountId: newAccountId, at: timestamp) } }
    func retryResolution(id: String, at timestamp: Date) async throws { try await access(true) { try await $0.retryResolution(id: id, at: timestamp) } }
    func undoSameExpense(id: String, at timestamp: Date) async throws { try await access(true) { try await $0.undoSameExpense(id: id, at: timestamp) } }
    func resolutions() async throws -> [KMReconciliationResolution] { try await access { try await $0.resolutions() } }
    func saveResolution(_ resolution: KMReconciliationResolution) async throws { try await access(true) { try await $0.saveResolution(resolution) } }
    func suspectedStatements() async throws -> [KMSuspectedStatement] { try await access { try await $0.suspectedStatements() } }
    func setSuspected(statementId: String, markedAt: Date?) async throws { try await access(true) { try await $0.setSuspected(statementId: statementId, markedAt: markedAt) } }
    func budgetSummary(month: KMYearMonth) async throws -> KMMonthlyBudgetSummary { try await access { try await $0.budgetSummary(month: month) } }
    func budgetSettings() async throws -> KMMonthlyBudgetSettings { try await access { try await $0.budgetSettings() } }
    func saveBudgetSettings(_ settings: KMMonthlyBudgetSettings) async throws { try await access(true) { try await $0.saveBudgetSettings(settings) } }
    func recurringTransactions() async throws -> [KMRecurringTransaction] { try await access { try await $0.recurringTransactions() } }
    func previewRecurringCatchUp(_ value: KMRecurringTransaction, through: KMDate) async throws -> KMRecurringCatchUpPlan { try await access { try await $0.previewRecurringCatchUp(value, through: through) } }
    func saveRecurring(_ value: KMRecurringTransaction) async throws { try await access(true) { try await $0.saveRecurring(value) } }
    func saveRecurring(_ value: KMRecurringTransaction, at timestamp: Date) async throws { try await access(true) { try await $0.saveRecurring(value, at: timestamp) } }
    func saveRecurringForCatchUp(_ value: KMRecurringTransaction, at timestamp: Date) async throws { try await access(true) { try await $0.saveRecurringForCatchUp(value, at: timestamp) } }
    func recurringGenerations(scheduleId: String) async throws -> [KMRecurringGeneration] { try await access { try await $0.recurringGenerations(scheduleId: scheduleId) } }
    func undoRecurringGeneration(id: String, dates: [KMDate]? = nil, at timestamp: Date) async throws { try await access(true) { try await $0.undoRecurringGeneration(id: id, dates: dates, at: timestamp) } }
    func runRecurring(through: KMDate, at timestamp: Date) async throws { try await access(true) { try await $0.runRecurring(through: through, at: timestamp) } }
    func deleteRecurring(id: String) async throws { try await access(true) { try await $0.deleteRecurring(id: id) } }
    func payrollRecords() async throws -> [KMPayrollRecord] { try await access { try await $0.payrollRecords() } }
    func savePayrollRecord(_ record: KMPayrollRecord) async throws { try await access(true) { try await $0.savePayrollRecord(record) } }
    func registerPayrollRecord(_ record: KMPayrollRecord, income: KMManualTransactionInput) async throws -> KMPayrollRecord {
        try await access(true) { try await $0.registerPayrollRecord(record, income: income) }
    }
    func categoryObservations() async throws -> [KMCategoryLearningObservation] { try await access { try await $0.categoryObservations() } }
    func saveCategoryObservation(_ value: KMCategoryLearningObservation) async throws { try await access(true) { try await $0.saveCategoryObservation(value) } }
    func recurringOccurrences(scheduleId: String) async throws -> [KMRecurringProcessedOccurrence] { try await access { try await $0.recurringOccurrences(scheduleId: scheduleId) } }
    func catchUpRecurring(id: String, dates: [KMDate], through: KMDate, at timestamp: Date) async throws { try await access(true) { try await $0.catchUpRecurring(id: id, dates: dates, through: through, at: timestamp) } }
    func categoryRules() async throws -> [KMCategoryLearningRule] { try await access { try await $0.categoryRules() } }
    func setCategoryRuleOverride(_ value: KMCategoryRuleOverride) async throws { try await access(true) { try await $0.setCategoryRuleOverride(value) } }
    func resetCategoryRuleOverride(targetType: KMCategoryRuleStats.TargetType, normalizedName: String) async throws { try await access(true) { try await $0.resetCategoryRuleOverride(targetType: targetType, normalizedName: normalizedName) } }
    func resetCategoryRuleOverrides() async throws { try await access(true) { try await $0.resetCategoryRuleOverrides() } }
    func settings() async throws -> KMAppSettings { try await access { try await $0.settings() } }
    func saveSettings(_ settings: KMAppSettings) async throws { try await access(true) { try await $0.saveSettings(settings) } }
}
