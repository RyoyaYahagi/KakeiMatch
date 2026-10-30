import Foundation

@MainActor extension KMInMemoryStore {
    func saveRecurring(_ value: KMRecurringTransaction) async throws { try await saveRecurring(value, at: Date()) }
    func saveRecurring(_ value: KMRecurringTransaction, at timestamp: Date) async throws {
        try await saveRecurring(value, at: timestamp, runDueOccurrences: true)
    }
    func saveRecurringForCatchUp(_ value: KMRecurringTransaction, at timestamp: Date) async throws {
        try await saveRecurring(value, at: timestamp, runDueOccurrences: false)
    }
    private func saveRecurring(_ value: KMRecurringTransaction, at timestamp: Date, runDueOccurrences: Bool) async throws {
        try await withLedgerCopy { working in
            let input = try KMRecurringScheduleService.validatedInput(working.recurringInput(value))
            try KMRecurringScheduleService.validateMastersAndUniqueness(input: input, editingId: value.id,
                categories: working.categoryValues, accounts: working.accountValues, schedules: working.recurringValues)
            try working.validCategory(input.categoryId, income: input.kind == .income)
            guard !value.id.isEmpty, value.id.utf16.count <= 128,
                  working.recurringValues.first(where: { $0.id == value.id })?.editable != false else {
                throw KMDataError.invalidData("この定期登録は編集できません。")
            }
            let editing = working.recurringValues.contains { $0.id == value.id }
            var saved = value; saved.name = input.name; saved.completed = false; saved.editable = true
            if let index = working.recurringValues.firstIndex(where: { $0.id == value.id }) { working.recurringValues[index] = saved }
            else { working.recurringValues.append(saved) }
            working.masterWriteState.scheduleAudits.append(.init(targetType: .schedule, operationId: UUID().uuidString,
                operation: editing ? .update : .create, scheduleId: value.id, input: input, status: .applied, createdAt: timestamp, appliedAt: timestamp))
            if runDueOccurrences {
                try await working.runRecurring(through: KMDate(instant: timestamp), at: timestamp)
            } else {
                working.updateRecurringNextDate(scheduleId: value.id, through: KMDate(instant: timestamp))
            }
        }
    }

    func previewRecurringCatchUp(_ value: KMRecurringTransaction, through: KMDate) async throws -> KMRecurringCatchUpPlan {
        let input = try KMRecurringScheduleService.validatedInput(recurringInput(value))
        try KMRecurringScheduleService.validateMastersAndUniqueness(input: input, editingId: value.id,
            categories: categoryValues, accounts: accountValues, schedules: recurringValues)
        try validCategory(input.categoryId, income: input.kind == .income)
        guard !value.id.isEmpty, value.id.utf16.count <= 128,
              recurringValues.first(where: { $0.id == value.id })?.editable != false else {
            throw KMDataError.invalidData("この定期登録は編集できません。")
        }
        return try KMRecurringScheduleService.preview(input: input, scheduleId: value.id, through: through,
            auditedDates: Set(serviceState.occurrences.filter { $0.scheduleId == value.id }.map(\.date)),
            importedIds: Set(transactionValues.compactMap(\.importedId)))
    }
    func deleteRecurring(id: String) async throws {
        guard recurringValues.contains(where: { $0.id == id }) else { throw KMDataError.notFound("定期登録が見つかりません。") }
        let timestamp = Date()
        recurringValues.removeAll { $0.id == id }
        masterWriteState.scheduleAudits.append(.init(targetType: .schedule, operationId: UUID().uuidString, operation: .delete,
            scheduleId: id, input: nil, status: .applied, createdAt: timestamp, appliedAt: timestamp))
        // Past ledger rows, consumed dates, and generation histories deliberately remain.
    }
    func catchUpRecurring(id: String, dates: [KMDate], through: KMDate, at timestamp: Date) async throws {
        try await withLedgerCopy { working in
            guard let schedule = working.recurringValues.first(where: { $0.id == id }), schedule.editable else { throw KMDataError.invalidData("実行できる定期登録を選んでください。") }
            let input = working.recurringInput(schedule)
            try KMRecurringScheduleService.validateMastersAndUniqueness(input: input, editingId: id,
                categories: working.categoryValues, accounts: working.accountValues, schedules: working.recurringValues)
            try working.validCategory(input.categoryId, income: input.kind == .income)
            let actualThrough = min(through, KMDate(instant: timestamp))
            let imported = Set(working.transactionValues.compactMap(\.importedId))
            let consumed = Set(working.serviceState.occurrences.filter { $0.scheduleId == id }.map(\.date)).union(
                dates.filter { imported.contains(KMRecurringScheduleService.importedId(scheduleId: id, date: $0)) })
            let selected = try KMRecurringScheduleService.selectedOccurrences(dates, input: input, through: actualThrough, alreadyConsumed: consumed)
            for chunk in KMRecurringScheduleService.batches(selected) {
                var occurrences: [KMRecurringGeneration.Occurrence] = []
                for date in chunk {
                    let importedId = KMRecurringScheduleService.importedId(scheduleId: id, date: date)
                    // Explicit add, never fuzzy-match an independent same-day manual transaction (#291).
                    let row = try await working.saveManual(.init(kind: input.kind == .expense ? .expense : .income, amountYen: input.amountYen,
                        date: date, payeeName: input.name, categoryId: input.categoryId, accountId: input.accountId, importedId: importedId))
                    occurrences.append(.init(date: date, transaction: row, status: .created))
                    working.serviceState.occurrences.append(.init(scheduleId: id, date: date, importedId: importedId, processedAt: timestamp))
                }
                working.masterWriteState.catchUps.append(.init(id: UUID().uuidString, scheduleId: id, input: input, occurrences: occurrences, createdAt: timestamp))
            }
        }
    }
    func recurringGenerations(scheduleId: String) async throws -> [KMRecurringGeneration] {
        masterWriteState.catchUps.filter { $0.scheduleId == scheduleId }.sorted { $0.createdAt > $1.createdAt }
    }
    func undoRecurringGeneration(id: String, dates: [KMDate]? = nil, at timestamp: Date) async throws {
        try await withLedgerCopy { working in
            guard let index = working.masterWriteState.catchUps.firstIndex(where: { $0.id == id }) else { throw KMDataError.notFound("定期登録の生成履歴が見つかりません。") }
            let audit = working.masterWriteState.catchUps[index]
            if let dates {
                guard !dates.isEmpty, Set(dates).count == dates.count,
                      dates.allSatisfy({ date in audit.occurrences.contains { $0.date == date && $0.status == .created } }) else { throw KMDataError.invalidData("削除する生成履歴を確認してください。") }
                // Selective deletion rejects edited rows before changing anything.
                for row in audit.occurrences where dates.contains(row.date) {
                    guard let current = working.transactionValues.first(where: { $0.id == row.transaction.id }),
                          working.sameGeneratedLedgerRow(current, row.transaction) else { throw KMDataError.invalidData("一部の取引が編集されています。未編集分を選び直してください。") }
                }
            } else if audit.undoneAt != nil { throw KMDataError.invalidData("この生成履歴は取り消し済みです。") }
            for i in audit.occurrences.indices {
                let saved = audit.occurrences[i]
                guard saved.status == .created, dates == nil || dates!.contains(saved.date) else { continue }
                let current = working.transactionValues.first { $0.id == saved.transaction.id }
                if current == nil { working.masterWriteState.catchUps[index].occurrences[i].status = .deleted }
                else if !working.sameGeneratedLedgerRow(current!, saved.transaction) { working.masterWriteState.catchUps[index].occurrences[i].status = .retained }
                else {
                    _ = try await working.deleteTransaction(id: saved.transaction.id, expected: [current!], at: timestamp)
                    working.masterWriteState.catchUps[index].occurrences[i].status = .deleted
                }
            }
            if dates == nil { working.masterWriteState.catchUps[index].undoneAt = timestamp }
            // Consumed dates are never removed, including deleted and retained occurrences.
        }
    }
    /// PWA compares NativeTransactionSnapshot, not display names or local exclusion metadata.
    private func sameGeneratedLedgerRow(_ current: KMTransaction, _ saved: KMTransaction) -> Bool {
        var row = current
        row.categoryName = saved.categoryName
        if row.payeeId != nil && row.payeeId == saved.payeeId { row.payeeName = saved.payeeName }
        row.excludedFromSpending = saved.excludedFromSpending
        return row == saved
    }
    /// Call on opening the household/recurring screen. No background timer or Cloud dependency.
    func runRecurring(through: KMDate, at timestamp: Date) async throws {
        try await withLedgerCopy { working in
            let today = min(through, KMDate(instant: timestamp))
            for schedule in working.recurringValues where !schedule.completed && schedule.editable {
                let input = working.recurringInput(schedule)
                if schedule.postsTransaction {
                    let missing = KMRecurringScheduleService.automaticOccurrences(input: input, scheduleId: schedule.id, through: today,
                        nextDate: schedule.nextDate,
                        auditedDates: Set(working.serviceState.occurrences.filter { $0.scheduleId == schedule.id }.map(\.date)),
                        importedIds: Set(working.transactionValues.compactMap(\.importedId)))
                    if !missing.isEmpty { try await working.catchUpRecurring(id: schedule.id, dates: missing, through: today, at: timestamp) }
                }
                working.updateRecurringNextDate(scheduleId: schedule.id, through: today)
            }
        }
    }

    private func updateRecurringNextDate(scheduleId: String, through today: KMDate) {
        guard let index = recurringValues.firstIndex(where: { $0.id == scheduleId }) else { return }
        let input = recurringInput(recurringValues[index])
        // Actual keeps today's already-posted occurrence as next_date until tomorrow.
        recurringValues[index].nextDate = KMRecurringScheduleService.nextOccurrence(input: input, onOrAfter: today)
    }
}
