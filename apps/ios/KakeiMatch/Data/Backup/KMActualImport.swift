import Foundation
import ZIPFoundation

/// Read-only adapter for Actual API 26.9.0 exports. The native store never edits Actual's internal SQL.
@MainActor enum KMActualImport {
    static let maxExpanded = 500 * 1024 * 1024
    static let lastKnownMigration = 1_787_013_118_115

    static func project(backup: KMPortableContents, staging: URL) throws -> KMInMemoryStore {
        let zipURL = staging.appendingPathComponent("actual.zip")
        try backup.actualZIP.write(to: zipURL)
        let archive = try Archive(url: zipURL, accessMode: .read)
        let entries = Array(archive)
        guard entries.count <= KMPortableBackup.maxEntries else { throw KMPortableBackup.invalid() }
        var seen = Set<String>(), total: UInt64 = 0
        for entry in entries {
            let path = entry.path
            guard !path.contains("\0"), !path.contains("\\"), !path.hasPrefix("/"),
                  path.range(of: #"^[a-zA-Z]:"#, options: .regularExpression) == nil,
                  !path.split(separator: "/", omittingEmptySubsequences: false).contains(".."),
                  seen.insert(path.lowercased()).inserted, entry.type != .symlink,
                  entry.uncompressedSize <= maxExpanded else { throw KMPortableBackup.invalid() }
            total += entry.uncompressedSize
            guard total <= maxExpanded else { throw KMPortableBackup.invalid() }
        }
        let dbDirs = Set(entries.filter { $0.path == "db.sqlite" || $0.path.hasSuffix("/db.sqlite") }.map { String($0.path.dropLast(9)) })
        let metaDirs = Set(entries.filter { $0.path == "metadata.json" || $0.path.hasSuffix("/metadata.json") }.map { String($0.path.dropLast(13)) })
        let shared = dbDirs.intersection(metaDirs)
        guard let prefix = shared.contains("") ? "" : (shared.count == 1 ? shared.first : nil),
              let dbEntry = entries.first(where: { $0.path == prefix + "db.sqlite" && $0.type == .file }),
              let metaEntry = entries.first(where: { $0.path == prefix + "metadata.json" && $0.type == .file }),
              metaEntry.uncompressedSize <= KMPortableBackup.maxManifest else { throw KMPortableBackup.invalid() }
        let dbURL = staging.appendingPathComponent("actual-source.sqlite"), metaURL = staging.appendingPathComponent("actual-metadata.json")
        try extract(dbEntry, archive: archive, to: dbURL)
        try extract(metaEntry, archive: archive, to: metaURL)
        guard let metadata = try JSONSerialization.jsonObject(with: Data(contentsOf: metaURL)) as? [String: Any],
              let budgetId = metadata["id"] as? String, !budgetId.isEmpty, budgetId.count <= 128,
              metadata["budgetName"] is String else { throw KMDataError.invalidData("家計簿のmetadataが不正です。") }
        let store = try readActual(url: dbURL, budgetId: budgetId)
        try apply(records: backup.records, to: store, budgetId: budgetId)
        store.imageValues = Dictionary(uniqueKeysWithValues: backup.artifacts.map { ($0.metadata.id, $0.data) })
        // Extracted files are only inputs. Native state and lossless ZIP/JSON provenance live in household.sqlite.
        try FileManager.default.removeItem(at: dbURL); try FileManager.default.removeItem(at: metaURL); try FileManager.default.removeItem(at: zipURL)
        return store
    }
    static func legacyBalanceEntries(actualZIP: Data) throws -> [KMBalanceEntry] {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let manifest = KMBackupManifest(backupFormatVersion: 1, localDataSchemaVersion: 2, exportedAt: Date(), entries: [], rawArtifacts: [], missingRawArtifacts: [])
        let projected = try project(backup: .init(manifest: manifest, manifestJSON: Data(), localJSON: Data(), actualZIP: actualZIP, records: [], artifacts: []), staging: directory)
        return projected.masterWriteState.balanceEntries
    }
    private static func extract(_ entry: Entry, archive: Archive, to url: URL) throws {
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw KMPortableBackup.invalid() }
        let output = try FileHandle(forWritingTo: url)
        var count: UInt64 = 0
        do {
            let checksum = try archive.extract(entry, bufferSize: 1024 * 1024) { bytes in
                count += UInt64(bytes.count)
                guard count <= entry.uncompressedSize, count <= maxExpanded else { throw KMPortableBackup.invalid() }
                try output.write(contentsOf: bytes)
            }
            try output.synchronize(); try output.close()
            guard count == entry.uncompressedSize, checksum == entry.checksum else { throw KMPortableBackup.invalid() }
        } catch {
            try output.close()
            throw error
        }
    }
    private static func readActual(url: URL, budgetId: String) throws -> KMInMemoryStore {
        let db = try KMSQLite(url: url, readOnly: true)
        guard try db.rows("PRAGMA integrity_check").first?.string("integrity_check") == "ok" else { throw KMPortableBackup.invalid() }
        let required = ["__migrations__", "accounts", "categories", "category_groups", "transactions", "payees", "category_mapping", "payee_mapping", "zero_budgets", "reflect_budgets", "schedules", "schedules_next_date", "rules", "preferences"]
        let tables = Set(try db.rows("SELECT name FROM sqlite_master WHERE type='table'").compactMap { $0.string("name") })
        struct Migrations: Decodable { var apiVersion: String; var ids: [Int] }
        guard let migrationURL = Bundle.main.url(forResource: "actual-migrations", withExtension: "json") else { throw KMPortableBackup.invalid() }
        let supported = try JSONDecoder().decode(Migrations.self, from: Data(contentsOf: migrationURL))
        let applied = try db.rows("SELECT id FROM __migrations__ ORDER BY id").map { row -> Int in
            guard let id = row.int("id") else { throw KMPortableBackup.invalid() }; return id
        }
        guard Set(required).isSubset(of: tables), supported.apiVersion == "26.9.0", supported.ids.last == lastKnownMigration,
              !applied.isEmpty, applied.count <= supported.ids.count, applied == Array(supported.ids.prefix(applied.count)) else {
            throw KMDataError.unsupported("この家計簿のActual DB版は未対応です。元のPWAでバックアップを保持してください。")
        }
        // KakeiMatch's portable contract is integer yen. An explicitly non-JPY Actual budget is not compatible.
        // Missing currency is expected for PWA-created budgets (the synthetic PWA export has no preference rows).
        let currency = try db.rows("SELECT value FROM preferences WHERE id='defaultCurrencyCode'").first?.string("value")
        guard currency == nil || currency == "" || currency == "JPY" else { throw KMDataError.unsupported("円以外の通貨を設定した家計簿には対応していません。") }
        let budgetType = try db.rows("SELECT value FROM preferences WHERE id='budgetType'").first?.string("value") ?? "envelope"
        guard budgetType == "envelope" || budgetType == "tracking" else { throw KMDataError.unsupported("未対応の予算方式です。") }
        let accountRows = try db.rows("SELECT id,name,closed,offbudget FROM accounts WHERE tombstone=0 ORDER BY sort_order,id")
        let accounts = try accountRows.map { row in KMAccount(id: try row.required("id"), name: try row.required("name"), closed: row.int("closed") == 1, offbudget: row.int("offbudget") == 1) }
        let groupRows = try db.rows("SELECT id,name,is_income,hidden FROM category_groups WHERE tombstone=0 ORDER BY sort_order,id")
        var groups = try groupRows.map { row in KMCategoryGroup(id: try row.required("id"), name: try row.required("name"), isIncome: row.int("is_income") == 1, hidden: row.int("hidden") == 1) }
        let categoryRows = try db.rows("SELECT id,name,is_income,hidden,cat_group FROM categories WHERE tombstone=0 ORDER BY sort_order,id")
        let categories = try categoryRows.map { row in
            let groupId = row.string("cat_group")
            return KMCategory(id: try row.required("id"), name: try row.required("name"), isIncome: row.int("is_income") == 1,
                hidden: row.int("hidden") == 1,
                groupName: groups.first { $0.id == groupId }?.name ?? "", groupId: groupId)
        }
        for index in groups.indices { groups[index].categoryIds = categories.filter { $0.groupId == groups[index].id }.map(\.id) }
        let payees = try db.rows("SELECT id,name,transfer_acct FROM payees WHERE tombstone=0 ORDER BY id").map { row in
            KMPayee(id: try row.required("id"), name: row.string("name") ?? "", transferAccountId: row.string("transfer_acct"))
        }
        // Same mappings as loot-core's v_transactions_internal: IDs may have been merged in Actual.
        let rows = try db.rows("""
            SELECT t.id,t.acct,t.amount,t.date,t.notes,t.financial_id,t.isParent,t.isChild,t.parent_id,
                   t.transferred_id,t.cleared,t.starting_balance_flag,t.error,
                   cm.transferId AS category,pm.targetId AS payee
            FROM transactions t
            LEFT JOIN category_mapping cm ON cm.id=t.category
            LEFT JOIN payee_mapping pm ON pm.id=t.description
            WHERE t.tombstone=0 AND t.date IS NOT NULL AND t.acct IS NOT NULL
            ORDER BY t.date,t.id
            """)
        let store = KMInMemoryStore(accounts: accounts, categories: categories, groups: groups, budgetId: budgetId)
        store.payeeValues = payees
        let byId = try Dictionary(uniqueKeysWithValues: rows.map { (try $0.required("id"), $0) })
        for row in rows where row.int("isChild") != 1 {
            let id = try row.required("id"), accountId = try row.required("acct"), amount = try row.yen("amount")
            guard store.accountValues.contains(where: { $0.id == accountId }) else { throw KMPortableBackup.invalid() }
            let date = try actualDate(row.int("date"))
            // Actual includes opening balances/error rows in balances but not the monthly dashboard/search.
            if row.int("starting_balance_flag") == 1 || !(row.string("error") ?? "").isEmpty {
                store.masterWriteState.balanceEntries.append(.init(id: id, accountId: accountId, date: date, amountYen: amount))
                continue
            }
            let category = categories.first { $0.id == row.string("category") }
            let transfer = row.string("transferred_id")
            let kind: KMTransactionKind = transfer != nil ? .transfer : amount < 0 ? .expense : amount > 0 || category?.isIncome == true ? .income : .expense
            var value = KMTransaction(id: id, date: date, amountYen: amount, kind: kind,
                payeeName: payees.first { $0.id == row.string("payee") }?.name, categoryName: category?.name, accountId: accountId,
                cleared: row.int("cleared") == 1, categoryId: category?.id, memo: row.string("notes"), importedId: row.string("financial_id"),
                isSplit: row.int("isParent") == 1, transferAccountId: transfer.flatMap { byId[$0]?.string("acct") }, transferId: transfer,
                reconciled: row.int("reconciled") == 1, payeeId: row.string("payee"))
            if let transfer {
                guard let peer = byId[transfer], peer.string("transferred_id") == id,
                      peer.string("acct") != accountId, try peer.yen("amount") == -amount, peer.int("isChild") != 1,
                      row.int("isParent") != 1, peer.int("isParent") != 1 else { throw KMPortableBackup.invalid() }
            }
            if value.isSplit == true {
                let children = rows.filter { $0.int("isChild") == 1 && $0.string("parent_id") == id }
                guard !children.isEmpty else { throw KMPortableBackup.invalid() }
                value.splits = try children.map { child in
                    guard child.string("acct") == accountId, try actualDate(child.int("date")) == date,
                          child.int("isParent") != 1, child.string("transferred_id") == nil,
                          (child.string("error") ?? "").isEmpty else { throw KMPortableBackup.invalid() }
                    return KMTransactionSplit(id: try child.required("id"), categoryId: categories.first { $0.id == child.string("category") }?.id,
                        amountYen: try child.yen("amount"), memo: child.string("notes"), payeeName: payees.first { $0.id == child.string("payee") }?.name,
                        cleared: child.int("cleared") == 1, reconciled: child.int("reconciled") == 1, payeeId: child.string("payee"))
                }
                guard try value.splits!.reduce(0, { try KMYen.add($0, $1.amountYen) }) == amount else { throw KMPortableBackup.invalid() }
            }
            store.transactionValues.append(value)
        }
        for child in rows where child.int("isChild") == 1 {
            guard let parent = child.string("parent_id"), byId[parent]?.int("isParent") == 1 else { throw KMPortableBackup.invalid() }
        }
        // Native budget amounts remain separate from KakeiMatch overrides (same preference as the PWA).
        let budgets = budgetType == "tracking" ? try db.rows("SELECT month,category,amount FROM reflect_budgets") : try db.rows("SELECT month,category,amount FROM zero_budgets")
        for row in budgets {
            guard let month = row.int("month"), let category = row.string("category") else { throw KMPortableBackup.invalid() }
            let key = try KMYearMonth(String(format: "%04d-%02d", month / 100, month % 100)).rawValue
            store.nativeBudgets[key, default: [:]][category] = try row.yen("amount")
        }
        try KMScheduleImport.project(db: db, into: store, at: Date())
        return store
    }
    static func actualDate(_ value: Int?) throws -> KMDate {
        guard let value else { throw KMPortableBackup.invalid() }
        return try KMDate(String(format: "%04d-%02d-%02d", value / 10000, value / 100 % 100, value % 100))
    }
    /// Shared by portable import and the native v1 → v2 migration. Inputs have passed the strict portable validator.
    static func serviceState(records: [KMPortableRecord]) throws -> KMServiceState {
        var result = KMServiceState()
        var reconciliation = KMLocalReconciliation(statements: [], imports: [], transactions: [], accounts: [], categories: [])
        for record in records {
            let object = try record.object()
            if record.kind == .merchantMapping, object["merchant"] != nil, object["aliasMerchant"] != nil {
                reconciliation.aliases.append(try record.decode(KMReconciliationAlias.self))
            }
            if record.kind == .appSettings, record.id.hasPrefix("settings:reconciliation-manual:"), let id = object["statementId"] as? String {
                reconciliation.manualStatementIds.insert(id)
            }
            guard record.kind == .correctionAudit else { continue }
            switch object["targetType"] as? String {
            case "category-learning": result.observations.append(try record.decode(KMCategoryLearningObservation.self))
            case "reconciliation-undo": reconciliation.undoHistory.append(try record.decode(KMReconciliationUndo.self))
            case "recurring-catch-up":
                struct Audit: Decodable {
                    struct Occurrence: Decodable { var date: KMDate; var importedId: String; var status: String }
                    var operation: String; var scheduleId: String; var occurrences: [Occurrence]; var createdAt: Date
                }
                let audit = try record.decode(Audit.self)
                // PWA consumes every date reserved by a create audit, even after undo/deletion.
                // Delete audits must not overwrite the original reservation.
                for row in audit.occurrences where audit.operation == "create" {
                    result.occurrences.removeAll { $0.scheduleId == audit.scheduleId && $0.date == row.date }
                    result.occurrences.append(.init(scheduleId: audit.scheduleId, date: row.date, importedId: row.importedId, processedAt: audit.createdAt))
                }
            default:
                if object["statementId"] != nil, object["receiptId"] != nil, object["runId"] != nil {
                    reconciliation.rejections.append(try record.decode(KMReconciliationPairRejection.self))
                }
            }
        }
        // A TS fingerprint cannot be used as Swift's prepared snapshot. Require a new run for review.
        result.reconciliation = reconciliation
        return result
    }
    private static func apply(records: [KMPortableRecord], to store: KMInMemoryStore, budgetId: String) throws {
        var state = try serviceState(records: records)
        // Schedules were projected from Actual before portable records ran. Keep their consumed dates
        // without overriding the PWA catch-up audits that describe the same day.
        for occurrence in store.serviceState.occurrences where !state.occurrences.contains(where: {
            $0.scheduleId == occurrence.scheduleId && $0.date == occurrence.date
        }) { state.occurrences.append(occurrence) }
        store.serviceState = state
        for record in records {
            switch record.kind {
            case .receiptMetadata: store.receiptValues.append(try record.decode(KMReceipt.self))
            case .statementImport: store.importValues.append(.init(id: record.id, kind: .statementImport, value: try record.decode(KMStatementImport.self), updatedAt: record.updatedAt))
            case .statementTransaction: store.statementValues.append(try record.decode(KMStatementTransaction.self))
            case .reconciliationRun: store.runValues.append(try record.decode(KMReconciliationRun.self))
            case .reconciliationResolution: store.resolutionValues.append(try record.decode(KMReconciliationResolution.self))
            case .payrollRecord: store.payrollValues.append(try record.decode(KMPayrollRecord.self))
            case .accountMetadata:
                struct Metadata: Decodable { var budgetId: String; var accountId: String; var accountType: KMAccountType; var statementProvider: KMStatementProvider? }
                let value = try record.decode(Metadata.self)
                guard value.budgetId == budgetId, let index = store.accountValues.firstIndex(where: { $0.id == value.accountId }) else { throw KMPortableBackup.invalid() }
                store.accountValues[index].accountType = value.accountType; store.accountValues[index].statementProvider = value.statementProvider
            case .appSettings:
                if record.id.hasPrefix("settings:monthly-budgets:") { store.monthlySettings = try record.decode(KMMonthlyBudgetSettings.self).validated(for: budgetId) }
                if record.id.hasPrefix("settings:spending-exclusion:") {
                    let value = try record.object()
                    guard value["budgetId"] as? String == budgetId else { throw KMPortableBackup.invalid() }
                    if let index = store.transactionValues.firstIndex(where: { $0.id == value["transactionId"] as? String }) { store.transactionValues[index].excludedFromSpending = true }
                }
                if record.id.hasPrefix("settings:reconciliation-suspected:") { store.suspectedValues.append(try record.decode(KMSuspectedStatement.self)) }
                if record.id.hasPrefix("category-rule-override:") { store.ruleOverrides.append(try record.decode(KMCategoryRuleOverride.self)) }
                if record.id == "settings:backup" {
                    struct Backup: Decodable { var lastExportAt: Date }; store.settingsValue.lastExportAt = try record.decode(Backup.self).lastExportAt
                }
                if record.id == "settings:moneyforward-import" {
                    try KMMoneyForwardProjection.project(record, into: store)
                }
            // Every known record remains verbatim in provenance, including drafts, mappings and audit logs.
            // These are service-owned inputs, not new ledger transactions or runnable rules.
            default: break
            }
        }
        let transactionIds = Set(store.transactionValues.map(\.id)), accountIds = Set(store.accountValues.map(\.id))
        let importIds = Set(store.importValues.map(\.id))
        for receipt in store.receiptValues where receipt.registration.status == .applied {
            guard let transactionId = receipt.registration.actualTransactionId, transactionIds.contains(transactionId),
                  let confirmed = receipt.confirmedValue, accountIds.contains(confirmed.accountId) else { throw KMPortableBackup.invalid() }
        }
        for statement in store.statementValues { guard importIds.contains(statement.importId) else { throw KMPortableBackup.invalid() } }
    }
}
