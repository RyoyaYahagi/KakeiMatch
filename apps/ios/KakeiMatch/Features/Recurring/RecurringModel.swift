import Foundation
import Observation

@MainActor @Observable
final class KMRecurringModel {
    private(set) var schedules: [KMRecurringTransaction] = []
    private(set) var accounts: [KMAccount] = []
    private(set) var categories: [KMCategory] = []
    private(set) var isLoading = true
    private(set) var isSaving = false
    var error: String?
    var saved = false

    func load(_ repositories: KMRepositories?) async {
        guard let repositories else { error = "定期登録を読み込めませんでした。アプリを開き直してください。"; isLoading = false; return }
        do {
            let today = KMDate(instant: repositories.referenceDate)
            try await repositories.recurring.runRecurring(through: today, at: repositories.referenceDate)
            schedules = try await repositories.recurring.recurringTransactions()
            accounts = try await repositories.accounts.accounts(asOf: today, includeClosed: false)
            categories = try await repositories.categories.categories(includeHidden: false)
            error = nil
        } catch { self.error = "定期登録を読み込めませんでした。\(error.localizedDescription)" }
        isLoading = false
    }

    func save(name: String, kind: KMRecurringTransaction.Kind, amount: String, categoryId: String, accountId: String,
              frequency: KMRecurringTransaction.Frequency, startDate: String, postsTransaction: Bool,
              editing: KMRecurringTransaction?, repositories: KMRepositories?) async {
        guard let repositories else { error = "定期登録を保存できませんでした。アプリを開き直してください。"; return }
        guard let yen = Int(amount), let date = try? KMDate(startDate) else { error = "金額と開始日を確認してください。"; return }
        isSaving = true; error = nil; saved = false
        let value = KMRecurringTransaction(id: editing?.id ?? UUID().uuidString, name: name, kind: kind, amountYen: yen,
            categoryId: categoryId, accountId: accountId, frequency: frequency, startDate: date,
            postsTransaction: postsTransaction, nextDate: editing?.nextDate, completed: editing?.completed ?? false, editable: editing?.editable ?? true)
        do {
            try await repositories.recurring.saveRecurring(value, at: repositories.referenceDate)
            saved = true
            await load(repositories)
        } catch { self.error = "定期登録を保存できませんでした。\(error.localizedDescription)" }
        isSaving = false
    }

    func delete(_ schedule: KMRecurringTransaction, repositories: KMRepositories?) async {
        guard let repositories else { error = "定期登録を削除できませんでした。アプリを開き直してください。"; return }
        do { try await repositories.recurring.deleteRecurring(id: schedule.id); await load(repositories) }
        catch { self.error = "定期登録を削除できませんでした。\(error.localizedDescription)" }
    }
}
