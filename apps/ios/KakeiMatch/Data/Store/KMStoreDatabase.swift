import Foundation

/// Native schema v2. Collection rows are domain snapshots, not Actual's CRDT tables.
/// Original portable records and artifacts are retained losslessly, independently of projections.
@MainActor final class KMStoreDatabase {
    let sql: KMSQLite
    private var loadedRevision: Int?
    init(url: URL) throws {
        sql = try KMSQLite(url: url)
        let version = try sql.rows("PRAGMA user_version").first?.int("user_version") ?? -1
        guard (0...2).contains(version) else { throw KMDataError.unsupported("このアプリより新しい端末DBです。データを削除せずアプリを更新してください。") }
        // Only configure writable journaling after the future-version guard has passed.
        try sql.execute("PRAGMA journal_mode=DELETE"); try sql.execute("PRAGMA synchronous=FULL")
        if version == 0 {
            guard try sql.rows("SELECT name FROM sqlite_master WHERE type='table'").isEmpty else { throw KMDataError.invalidData("端末DBの構造を確認できません。") }
            try sql.transaction {
                try sql.execute("CREATE TABLE objects (collection TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL, json BLOB NOT NULL, PRIMARY KEY(collection,id))")
                try sql.execute("CREATE TABLE artifacts (id TEXT PRIMARY KEY NOT NULL, metadata BLOB NOT NULL, payload BLOB NOT NULL)")
                try sql.execute("CREATE TABLE provenance (id TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL)")
                try sql.execute("CREATE TABLE control (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)")
                try sql.execute("INSERT INTO control VALUES(1,0)")
                try sql.execute("PRAGMA user_version=2")
            }
            try save(KMInMemoryStore(budgetId: UUID().uuidString))
        }
        // Refuse malformed existing layouts; never create missing tables in an existing version.
        _ = try sql.rows("SELECT collection,id,ordinal,json FROM objects LIMIT 0")
        _ = try sql.rows("SELECT id,metadata,payload FROM artifacts LIMIT 0")
        _ = try sql.rows("SELECT id,payload FROM provenance LIMIT 0")
        _ = try revision()
        if version == 1 {
            try sql.transaction {
                // v1 already persisted runs/decisions, but not service inputs. Recover lossless
                // imported histories from provenance; do not invent a valid prepared run snapshot.
                var state = KMServiceState()
                if let manifest = try provenance("manifest.json"), let local = try provenance("local-data.json") {
                    let records = try KMBackupSchema.validate(manifest: manifest, local: local).1
                    state = try KMActualImport.serviceState(records: records)
                }
                try put("service-state", [state])
                let current = try revision()
                guard current < Int.max else { throw KMDataError.invalidData("端末DBの世代番号が上限です。") }
                try sql.execute("UPDATE control SET revision=? WHERE id=1", [.integer(current + 1)])
                try sql.execute("PRAGMA user_version=2")
            }
        }
    }
    private func values<T: Decodable>(_ collection: String, _: T.Type) throws -> [T] {
        try sql.rows("SELECT json FROM objects WHERE collection=? ORDER BY ordinal", [.text(collection)]).map {
            guard let data = $0.data("json") else { throw KMDataError.invalidData("端末DBの記録が不正です。") }
            return try KMJSON.decoder().decode(T.self, from: data)
        }
    }
    private func singleton<T: Decodable>(_ collection: String, _: T.Type) throws -> T {
        let rows = try values(collection, T.self)
        guard rows.count == 1, let value = rows.first else { throw KMDataError.invalidData("端末DBの設定が欠けています。") }; return value
    }
    private func revision() throws -> Int {
        guard let value = try sql.rows("SELECT revision FROM control WHERE id=1").first?.int("revision"), value >= 0 else { throw KMDataError.invalidData("端末DBの世代番号が不正です。") }; return value
    }
    func load() throws -> KMInMemoryStore { try sql.transaction { try loadSnapshot() } }
    private func loadSnapshot() throws -> KMInMemoryStore {
        // Read all collections at one revision; compare again inside the eventual write transaction.
        loadedRevision = try revision()
        let settings = try singleton("monthly-settings", KMMonthlyBudgetSettings.self)
        let store = KMInMemoryStore(transactions: try values("transactions", KMTransaction.self), accounts: try values("accounts", KMAccount.self),
            categories: try values("categories", KMCategory.self), groups: try values("groups", KMCategoryGroup.self),
            receipts: try values("receipts", KMReceipt.self), budgetId: settings.budgetId)
        store.payeeValues = try values("payees", KMPayee.self)
        store.importValues = try values("imports", KMLocalRecord<KMStatementImport>.self)
        store.statementValues = try values("statements", KMStatementTransaction.self)
        store.runValues = try values("runs", KMReconciliationRun.self)
        store.resolutionValues = try values("resolutions", KMReconciliationResolution.self)
        store.suspectedValues = try values("suspected", KMSuspectedStatement.self)
        store.recurringValues = try values("recurring", KMRecurringTransaction.self)
        store.payrollValues = try values("payroll", KMPayrollRecord.self)
        store.ruleValues = try values("rules", KMCategoryLearningRule.self)
        store.ruleOverrides = try values("rule-overrides", KMCategoryRuleOverride.self)
        store.serviceState = try singleton("service-state", KMServiceState.self)
        store.settingsValue = try singleton("settings", KMAppSettings.self)
        store.monthlySettings = settings
        store.nativeBudgets = try singleton("native-budgets", [String: [String: Int]].self)
        for row in try sql.rows("SELECT id,payload FROM artifacts") {
            store.imageValues[try row.required("id")] = row.data("payload")
        }
        return store
    }
    private func put<T: Encodable>(_ collection: String, _ values: [T]) throws {
        for (index, value) in values.enumerated() {
            try sql.execute("INSERT INTO objects(collection,id,ordinal,json) VALUES(?,?,?,?)",
                [.text(collection), .text(String(index)), .integer(index), .blob(try KMJSON.encoder().encode(value))])
        }
    }
    /// Commit the entire multi-repository change or nothing. No published in-memory mutation precedes COMMIT.
    func save(_ store: KMInMemoryStore) throws {
        var nextRevision = 0
        try sql.transaction {
            let current = try revision()
            guard loadedRevision == nil || loadedRevision == current else { throw KMDataError.invalidData("別の操作で家計簿が更新されました。再読み込みしてから保存してください。") }
            guard current < Int.max else { throw KMDataError.invalidData("端末DBの世代番号が上限です。") }
            nextRevision = current + 1
            try sql.execute("UPDATE control SET revision=? WHERE id=1", [.integer(nextRevision)])
            try sql.execute("DELETE FROM objects")
            try put("transactions", store.transactionValues); try put("accounts", store.accountValues)
            try put("categories", store.categoryValues); try put("groups", store.groupValues); try put("payees", store.payeeValues)
            try put("receipts", store.receiptValues); try put("imports", store.importValues); try put("statements", store.statementValues)
            try put("runs", store.runValues); try put("resolutions", store.resolutionValues); try put("suspected", store.suspectedValues)
            try put("recurring", store.recurringValues); try put("payroll", store.payrollValues)
            try put("rules", store.ruleValues); try put("rule-overrides", store.ruleOverrides)
            try put("service-state", [store.serviceState])
            try put("settings", [store.settingsValue]); try put("monthly-settings", [store.monthlySettings]); try put("native-budgets", [store.nativeBudgets])
            // Draft deletion also removes its image in the same transaction; imported CSVs remain intact.
            for row in try sql.rows("SELECT id FROM artifacts") {
                let id = try row.required("id")
                if store.imageValues[id] == nil { try sql.execute("DELETE FROM artifacts WHERE id=?", [.text(id)]) }
            }
        }
        loadedRevision = nextRevision
    }
    func saveArtifacts(_ artifacts: [KMBackupArtifact]) throws {
        try sql.transaction {
            for artifact in artifacts {
                try sql.execute("INSERT OR REPLACE INTO artifacts(id,metadata,payload) VALUES(?,?,?)", [.text(artifact.metadata.id),
                    .blob(try KMJSON.encoder().encode(artifact.metadata)), .blob(artifact.data)])
            }
        }
    }
    func backupArtifacts() throws -> [KMBackupArtifact] {
        try sql.rows("SELECT metadata,payload FROM artifacts ORDER BY id").map {
            guard let metadata = $0.data("metadata"), let payload = $0.data("payload") else {
                throw KMDataError.invalidData("端末DBの原本が不正です。")
            }
            return KMBackupArtifact(metadata: try KMJSON.decoder().decode(KMBackupManifest.Raw.self, from: metadata), data: payload)
        }
    }
    func preserve(_ id: String, data: Data) throws {
        try sql.execute("INSERT INTO provenance(id,payload) VALUES(?,?)", [.text(id), .blob(data)])
    }
    func provenance(_ id: String) throws -> Data? {
        try sql.rows("SELECT payload FROM provenance WHERE id=?", [.text(id)]).first?.data("payload")
    }
    func original(_ id: String) throws -> Data? {
        try sql.rows("SELECT payload FROM artifacts WHERE id=?", [.text(id)]).first?.data("payload")
    }
    func artifacts() throws -> [(String, Data)] {
        try sql.rows("SELECT id,payload FROM artifacts ORDER BY id").map {
            guard let payload = $0.data("payload") else { throw KMDataError.invalidData("端末DBの原本が不正です。") }
            return (try $0.required("id"), payload)
        }
    }
    func snapshot(to url: URL) throws {
        guard !FileManager.default.fileExists(atPath: url.path) else { throw KMPortableBackup.invalid() }
        try sql.execute("VACUUM INTO ?", [.text(url.path)])
    }
}
