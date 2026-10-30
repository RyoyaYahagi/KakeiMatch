import Foundation
import Observation

@MainActor @Observable
final class KMRecurringModel {
    private(set) var schedules: [KMRecurringTransaction] = []
    private(set) var accounts: [KMAccount] = []
    private(set) var categories: [KMCategory] = []
    private(set) var generations: [KMRecurringGeneration] = []
    private(set) var isLoading = true
    private(set) var isLoadingHistory = false
    private(set) var isSaving = false
    var error: String?
    var message: String?
    var saved = false
    private(set) var catchUpPrompt: KMRecurringCatchUpPlan?
    private var pendingSchedule: KMRecurringTransaction?
    private var retryableCatchUp: (scheduleId: String, dates: [KMDate])?

    var canRetryCatchUp: Bool { retryableCatchUp != nil }

    func load(_ repositories: KMRepositories?) async {
        guard let repositories else {
            error = "定期登録を読み込めませんでした。アプリを開き直してください。"
            isLoading = false
            return
        }
        do {
            let today = KMDate(instant: repositories.referenceDate)
            // Preserve the existing household-open behavior: automatically process due dates.
            try await repositories.recurring.runRecurring(through: today, at: repositories.referenceDate)
            try await reload(repositories)
            error = nil
        } catch { self.error = "定期登録を読み込めませんでした。\(error.localizedDescription)" }
        isLoading = false
    }

    func save(name: String, kind: KMRecurringTransaction.Kind, amount: String, categoryId: String, accountId: String,
              frequency: KMRecurringTransaction.Frequency, startDate: String, postsTransaction: Bool,
              editing: KMRecurringTransaction?, repositories: KMRepositories?) async {
        guard let repositories else { error = "定期登録を保存できませんでした。アプリを開き直してください。"; return }
        guard let yen = Int(amount), let date = try? KMDate(startDate) else { error = "金額と開始日を確認してください。"; return }
        isSaving = true
        error = nil
        message = nil
        saved = false
        retryableCatchUp = nil
        let value = KMRecurringTransaction(id: editing?.id ?? UUID().uuidString, name: name, kind: kind, amountYen: yen,
            categoryId: categoryId, accountId: accountId, frequency: frequency, startDate: date,
            postsTransaction: postsTransaction, nextDate: editing?.nextDate, completed: editing?.completed ?? false, editable: editing?.editable ?? true)
        do {
            let through = KMDate(instant: repositories.referenceDate)
            let plan = try await repositories.recurring.previewRecurringCatchUp(value, through: through)
            if plan.dates.count > 1 {
                pendingSchedule = value
                catchUpPrompt = plan
                message = "過去分を確認してください。"
                isSaving = false
                return
            }
            await persist(value, dates: plan.dates, repositories: repositories)
        } catch { self.error = "定期登録を保存できませんでした。\(error.localizedDescription)" }
        isSaving = false
    }

    func chooseCatchUp(currentMonthOnly: Bool, repositories: KMRepositories?) async {
        guard let repositories, let value = pendingSchedule, let plan = catchUpPrompt else { return }
        let today = KMDate(instant: repositories.referenceDate)
        let dates = currentMonthOnly
            ? KMRecurringScheduleService.currentMonthDates(in: plan, month: today.yearMonth)
            : plan.dates
        catchUpPrompt = nil
        pendingSchedule = nil
        isSaving = true
        message = "保存しています。"
        await persist(value, dates: dates, repositories: repositories)
        isSaving = false
    }

    func cancelCatchUpPrompt() {
        // The cover's binding can report a dismissal after a choice already closed it.
        guard catchUpPrompt != nil else { return }
        catchUpPrompt = nil
        pendingSchedule = nil
        message = "保存をキャンセルしました。"
    }

    func retryCatchUp(repositories: KMRepositories?) async {
        guard let repositories, let pending = retryableCatchUp else { return }
        isSaving = true
        error = nil
        do {
            let today = KMDate(instant: repositories.referenceDate)
            try await repositories.recurring.catchUpRecurring(id: pending.scheduleId, dates: pending.dates,
                through: today, at: repositories.referenceDate)
            retryableCatchUp = nil
            saved = true
            message = "過去分を記録しました。"
            try await reload(repositories)
        } catch { self.error = "過去分の記録を再試行できませんでした。\(error.localizedDescription)" }
        isSaving = false
    }

    func loadGenerations(scheduleId: String, repositories: KMRepositories?) async {
        guard let repositories else { error = "生成履歴を読み込めませんでした。アプリを開き直してください。"; return }
        isLoadingHistory = true
        do { generations = try await repositories.recurring.recurringGenerations(scheduleId: scheduleId) }
        catch { self.error = "生成履歴を読み込めませんでした。\(error.localizedDescription)" }
        isLoadingHistory = false
    }

    func undoGeneration(id: String, scheduleId: String, repositories: KMRepositories?) async {
        guard let repositories else { error = "過去分を取り消せませんでした。アプリを開き直してください。"; return }
        let timestamp = repositories.referenceDate
        do {
            try await repositories.recurring.undoRecurringGeneration(id: id, dates: nil, at: timestamp)
            await loadGenerations(scheduleId: scheduleId, repositories: repositories)
            let retained = generations.first(where: { $0.id == id })?.occurrences.filter { $0.status == .retained }.count ?? 0
            message = retained > 0
                ? "過去分を取り消しました。編集済みの\(retained)件は残しました。"
                : "今回の過去分を取り消しました。"
            error = nil
        } catch { self.error = "過去分を取り消せませんでした。\(error.localizedDescription)" }
    }

    func deleteOccurrences(id: String, dates: [KMDate], scheduleId: String, repositories: KMRepositories?) async {
        guard let repositories else { error = "選択した記録を削除できませんでした。アプリを開き直してください。"; return }
        do {
            try await repositories.recurring.undoRecurringGeneration(id: id, dates: dates, at: repositories.referenceDate)
            await loadGenerations(scheduleId: scheduleId, repositories: repositories)
            message = "選択した記録を削除しました。"
            error = nil
        } catch { self.error = "選択した記録を削除できませんでした。\(error.localizedDescription)" }
    }

    func delete(_ schedule: KMRecurringTransaction, repositories: KMRepositories?) async {
        guard let repositories else { error = "定期登録を削除できませんでした。アプリを開き直してください。"; return }
        do { try await repositories.recurring.deleteRecurring(id: schedule.id); await load(repositories) }
        catch { self.error = "定期登録を削除できませんでした。\(error.localizedDescription)" }
    }

    private func persist(_ value: KMRecurringTransaction, dates: [KMDate], repositories: KMRepositories) async {
        do {
            try await repositories.recurring.saveRecurringForCatchUp(value, at: repositories.referenceDate)
            if !dates.isEmpty {
                let today = KMDate(instant: repositories.referenceDate)
                do {
                    try await repositories.recurring.catchUpRecurring(id: value.id, dates: dates, through: today,
                        at: repositories.referenceDate)
                } catch {
                    retryableCatchUp = (value.id, dates)
                    self.error = "定期登録は保存しましたが、過去分の記録が保留中です。\(error.localizedDescription)"
                    try? await reload(repositories)
                    return
                }
            }
            retryableCatchUp = nil
            saved = true
            message = "定期登録を保存しました。"
            error = nil
            try await reload(repositories)
        } catch { self.error = "定期登録を保存できませんでした。\(error.localizedDescription)" }
    }

    private func reload(_ repositories: KMRepositories) async throws {
        let today = KMDate(instant: repositories.referenceDate)
        schedules = try await repositories.recurring.recurringTransactions()
        accounts = try await repositories.accounts.accounts(asOf: today, includeClosed: false)
        categories = try await repositories.categories.categories(includeHidden: false)
    }
}
