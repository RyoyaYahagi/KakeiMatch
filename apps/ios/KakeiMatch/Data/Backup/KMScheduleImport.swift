import Foundation

/// Projects active Actual schedules that the PWA can create and edit into native recurring rows.
///
/// PWA-created schedules use the basic rule shape (payee/account/date/amount conditions plus a
/// `link-schedule` action and a `set category` action). Anything else is rejected instead of being
/// guessed: silently dropping an active schedule, or posting from a rule the app cannot edit, would
/// change the household. Consumed dates are projected as well, so `runRecurring` after the import
/// cannot generate a second row for an occurrence the PWA already posted.
@MainActor enum KMScheduleImport {
    static func project(db: KMSQLite, into store: KMInMemoryStore, at timestamp: Date) throws {
        let schedules = try db.rows("""
            SELECT s.id AS id, s.name AS name, s.rule AS rule, s.posts_transaction AS posts_transaction,
                   s.completed AS completed,
                   r.stage AS stage, r.conditions_op AS conditions_op, r.tombstone AS rule_tombstone,
                   r.conditions AS conditions, r.actions AS actions,
                   CASE WHEN nd.local_next_date_ts = nd.base_next_date_ts THEN nd.local_next_date ELSE nd.base_next_date END AS next_date
            FROM schedules s
            LEFT JOIN rules r ON r.id = s.rule
            LEFT JOIN schedules_next_date nd ON nd.schedule_id = s.id
            WHERE s.tombstone = 0
            ORDER BY s.id
            """)
        // A schedule can post a row without an imported ID (Actual's schedule service) or with the
        // PWA catch-up ID (`kakeimatch:schedule:<id>:<date>`). Both mean the date is already consumed.
        let posted = try db.rows("SELECT date, schedule, financial_id FROM transactions WHERE tombstone = 0 AND date IS NOT NULL")
        // The native backup encodes dates with millisecond precision. Keep the stored value stable
        // across the import readback instead of failing the whole profile switch on sub-ms precision.
        let processedAt = Date(timeIntervalSince1970: (timestamp.timeIntervalSince1970 * 1000).rounded(.down) / 1000)
        var ids = Set<String>(), names = Set<String>()
        for row in schedules {
            // Completed schedules cannot generate again; their posted transactions are already projected.
            guard row.int("completed") != 1 else { continue }
            let id = try row.required("id")
            guard id.utf16.count <= 128, ids.insert(id).inserted else { throw rejected() }
            guard let rawName = row.string("name") else { throw rejected() }
            let name = KMJSString.trim(rawName)
            guard !name.isEmpty, name.utf16.count <= 200, names.insert(name).inserted else { throw rejected() }
            guard row.string("stage") == nil, (row.string("conditions_op") ?? "and") == "and",
                  row.int("rule_tombstone") != 1, let conditionsJSON = row.string("conditions"), let actionsJSON = row.string("actions") else { throw rejected() }
            let conditions = try objectArray(conditionsJSON), actions = try objectArray(actionsJSON)
            let byField = Dictionary(conditions.compactMap { condition -> (String, [String: Any])? in
                guard let field = condition["field"] as? String else { return nil }
                return (field, condition)
            }, uniquingKeysWith: { first, _ in first })
            guard conditions.count == 4, byField.count == 4,
                  let payee = byField["payee"], payee["op"] as? String == "is", payee["value"] is String,
                  let account = byField["account"], account["op"] as? String == "is",
                  let accountId = account["value"] as? String,
                  let date = byField["date"], date["op"] as? String == "isapprox",
                  let dateValue = date["value"] as? [String: Any],
                  let amount = byField["amount"], amount["op"] as? String == "is",
                  let amountNumber = amount["value"] as? NSNumber,
                  CFGetTypeID(amountNumber) != CFBooleanGetTypeID() else { throw rejected() }
            let amountDouble = amountNumber.doubleValue
            guard amountDouble.isFinite, amountDouble.rounded() == amountDouble,
                  let amountYen = Int(exactly: amountDouble), amountYen != 0 else { throw rejected() }
            _ = try KMYen.checked(amountYen)
            guard Set(dateValue.keys).isSubset(of: ["frequency", "interval", "start", "endMode"]) else { throw rejected() }
            guard let frequencyRaw = dateValue["frequency"] as? String else { throw rejected() }
            guard let frequency = KMRecurringTransaction.Frequency(rawValue: frequencyRaw) else { throw rejected() }
            guard let startRaw = dateValue["start"] as? String else { throw rejected() }
            guard let startDate = try? KMDate(startRaw) else { throw rejected() }
            if let interval = dateValue["interval"] {
                guard let number = interval as? NSNumber,
                      number.doubleValue == 1, number.intValue == 1 else { throw rejected() }
            }
            if let endMode = dateValue["endMode"] {
                guard let value = endMode as? String, value == "never" else { throw rejected() }
            }
            var categoryId: String?, linked = false
            for action in actions {
                guard let op = action["op"] as? String else { throw rejected() }
                switch op {
                case "link-schedule":
                    guard action["value"] as? String == id else { throw rejected() }
                    linked = true
                case "set":
                    guard let field = action["field"] as? String else { throw rejected() }
                    if field == "category" {
                        guard categoryId == nil, let value = action["value"] as? String, !value.isEmpty else { throw rejected() }
                        categoryId = value
                    } else if field == "notes" {
                        guard action["value"] is String else { throw rejected() }
                    } else { throw rejected() }
                case "prepend-notes", "append-notes": break
                default: throw rejected()
                }
            }
            guard linked, let categoryId,
                  let category = store.categoryValues.first(where: { $0.id == categoryId }),
                  !category.hidden, category.isIncome == (amountYen > 0),
                  let accountValue = store.accountValues.first(where: { $0.id == accountId }), !accountValue.closed else { throw rejected() }
            let input = KMRecurringScheduleInput(name: name, kind: amountYen > 0 ? .income : .expense, amountYen: abs(amountYen),
                categoryId: categoryId, accountId: accountId, frequency: frequency, startDate: startDate,
                postsTransaction: row.int("posts_transaction") == 1)
            let prefix = "kakeimatch:schedule:\(id):"
            var consumed: [KMDate: String] = [:]
            for transaction in posted {
                let financialId = transaction.string("financial_id")
                guard transaction.string("schedule") == id || (financialId?.hasPrefix(prefix) ?? false),
                      let dateRepr = transaction.int("date") else { continue }
                let day = try KMActualImport.actualDate(dateRepr)
                // Keep the schedule's stable ID even when Actual posted the row without one.
                if let financialId, financialId.hasPrefix(prefix) { consumed[day] = financialId }
                else { consumed[day] = KMRecurringScheduleService.importedId(scheduleId: id, date: day) }
            }
            var nextDate: KMDate?
            if let value = row.int("next_date") { nextDate = try KMActualImport.actualDate(value) }
            // Actual keeps next_date at the next unposted occurrence. A stale value (for example after
            // a PWA catch-up that did not advance it) must not make the native run recreate a posted day.
            if let latest = consumed.keys.max(), nextDate.map({ $0 <= latest }) ?? true {
                nextDate = dayAfter(latest).flatMap { KMRecurringScheduleService.nextOccurrence(input: input, onOrAfter: $0) }
            }
            if nextDate == nil {
                // No usable Actual next date: start at the next occurrence instead of replaying history.
                nextDate = KMRecurringScheduleService.nextOccurrence(input: input, onOrAfter: KMDate(instant: timestamp))
            }
            store.recurringValues.append(.init(id: id, name: name, kind: input.kind, amountYen: input.amountYen,
                categoryId: categoryId, accountId: accountId, frequency: frequency, startDate: startDate,
                postsTransaction: input.postsTransaction, nextDate: nextDate, completed: false, editable: true))
            for (day, importedId) in consumed.sorted(by: { $0.key < $1.key }) {
                store.serviceState.occurrences.append(.init(scheduleId: id, date: day, importedId: importedId, processedAt: processedAt))
            }
        }
    }

    private static func objectArray(_ json: String) throws -> [[String: Any]] {
        guard let data = json.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data),
              let array = value as? [[String: Any]] else { throw rejected() }
        return array
    }
    private static func rejected() -> KMDataError {
        KMDataError.unsupported("定期登録の形式が未対応です。元のPWAのデータは変更されていません。")
    }
    private static func dayAfter(_ date: KMDate) -> KMDate? {
        let parts = date.rawValue.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var components = DateComponents()
        components.year = parts[0]; components.month = parts[1]; components.day = parts[2]
        guard let start = KMDate.calendar.date(from: components),
              let shifted = KMDate.calendar.date(byAdding: .day, value: 1, to: start) else { return nil }
        let result = KMDate.calendar.dateComponents([.year, .month, .day], from: shifted)
        guard let year = result.year, (1...9999).contains(year), let month = result.month, let day = result.day else { return nil }
        return try? KMDate(String(format: "%04d-%02d-%02d", year, month, day))
    }
}
