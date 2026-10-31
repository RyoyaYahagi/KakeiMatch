import Foundation

/// Projects the PWA's durable MoneyForward journal (`settings:moneyforward-import`) into the native
/// `master-writes` history. The original record stays in provenance.
///
/// Undo must only remove rows that this batch actually created. A projected row therefore carries a
/// transaction only when the PWA snapshot, the row's imported ID, and the projected ledger row all
/// agree. Duplicate/excluded rows and missing or edited targets stay without a deletion target, so
/// `undoMoneyForward` cannot remove an unrelated transaction.
@MainActor enum KMMoneyForwardProjection {
    static func project(_ record: KMPortableRecord, into store: KMInMemoryStore) throws {
        let settings = try record.decode(Settings.self)
        guard settings.version == 1 else { throw invalid() }
        let rules = try mappings(settings.rules)
        // PWA restore rebinds batches to the restored budget; the record's old budget ID is not a boundary.
        store.masterWriteState.moneyForwardRules.categories.merge(rules.categories) { _, new in new }
        store.masterWriteState.moneyForwardRules.accounts.merge(rules.accounts) { _, new in new }
        var seen = Set(store.masterWriteState.moneyForward.map(\.id))
        for batch in settings.batches {
            // planned/processing/undoing describe an unfinished PWA write. Projecting them as a
            // completed native batch would offer an undo for rows whose PWA state is still moving.
            guard ["completed", "partial", "undo-partial", "undone"].contains(batch.status) else { continue }
            guard !batch.id.isEmpty, batch.id.utf16.count <= 128, seen.insert(batch.id).inserted else { continue }
            let rows = try batch.rows.compactMap { item -> KMMoneyForwardBatch.Row? in
                let choice = try recordChoice(item.recordChoice)
                switch item.status {
                case "created":
                    var transaction: KMTransaction?
                    if let snapshot = item.transactionSnapshot?.first,
                       snapshot.importedId == nil || snapshot.importedId == item.importedId,
                       let current = store.transactionValues.first(where: { $0.id == snapshot.id }),
                       current.importedId == item.importedId {
                        transaction = current
                    }
                    return .init(row: item.row, importedId: item.importedId, status: .created,
                        recordChoice: choice, transaction: transaction)
                case "duplicate": return .init(row: item.row, importedId: item.importedId, status: .duplicate, recordChoice: choice, transaction: nil)
                case "excluded": return .init(row: item.row, importedId: item.importedId, status: .excluded, recordChoice: choice, transaction: nil)
                case "undone": return .init(row: item.row, importedId: item.importedId, status: .undone, recordChoice: choice, transaction: nil)
                // pending/importing/failed/undoing have no stable native outcome.
                default: return nil
                }
            }
            store.masterWriteState.moneyForward.append(.init(id: batch.id, createdAt: batch.createdAt, updatedAt: batch.updatedAt,
                status: batch.status == "undone" ? .undone : .completed, mappings: try mappings(batch.mappings), rows: rows))
        }
    }

    private struct Settings: Decodable {
        var version: Int
        var rules: Rules
        var batches: [Batch]
    }
    private struct Rules: Decodable {
        var categories: [String: CategoryChoice]
        var accounts: [String: AccountChoice]
    }
    private struct CategoryChoice: Decodable {
        var kind: String
        var categoryId: String?
        var name: String?
    }
    private struct AccountChoice: Decodable {
        var kind: String
        var accountId: String?
        var name: String?
    }
    private struct Batch: Decodable {
        var id: String
        var budgetId: String
        var createdAt: Date
        var updatedAt: Date
        var status: String
        var mappings: Rules
        var rows: [Row]
    }
    private struct Row: Decodable {
        var row: KMMoneyForwardRow
        var importedId: String
        var status: String
        var recordChoice: RecordChoice?
        var transactionSnapshot: [Snapshot]?
        var error: String?
    }
    private struct RecordChoice: Decodable {
        var kind: String
        var transactionId: String?
    }
    private struct Snapshot: Decodable {
        var id: String
        var importedId: String?
        enum CodingKeys: String, CodingKey { case id; case importedId = "imported_id" }
    }

    private static func mappings(_ value: Rules) throws -> KMMoneyForwardMappings {
        var result = KMMoneyForwardMappings()
        for (key, choice) in value.categories {
            switch choice.kind {
            case "existing": guard let id = choice.categoryId, !id.isEmpty else { throw invalid() }; result.categories[key] = .existing(id: id)
            case "new": guard let name = choice.name, !name.isEmpty else { throw invalid() }; result.categories[key] = .new(name: name)
            case "unclassified": result.categories[key] = .unclassified
            case "exclude": result.categories[key] = .exclude
            case "unresolved": result.categories[key] = .unresolved
            default: throw invalid()
            }
        }
        for (source, choice) in value.accounts {
            switch choice.kind {
            case "existing": guard let id = choice.accountId, !id.isEmpty else { throw invalid() }; result.accounts[source] = .existing(id: id)
            case "new": guard let name = choice.name, !name.isEmpty else { throw invalid() }; result.accounts[source] = .new(name: name)
            case "unset": result.accounts[source] = .unset
            default: throw invalid()
            }
        }
        return result
    }
    private static func recordChoice(_ value: RecordChoice?) throws -> KMMoneyForwardRecordChoice? {
        guard let value else { return nil }
        switch value.kind {
        case "separate": return .separate
        case "keep": guard let id = value.transactionId, !id.isEmpty else { throw invalid() }; return .keep(transactionId: id)
        default: throw invalid()
        }
    }
    private static func invalid() -> KMDataError {
        KMDataError.invalidData("Money Forwardの移行履歴を読み取れません。元のPWAのデータは変更されていません。")
    }
}
