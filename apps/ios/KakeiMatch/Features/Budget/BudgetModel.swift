import Foundation
import Observation

@MainActor @Observable
final class KMBudgetModel {
    private(set) var summary: KMMonthlyBudgetSummary?
    private(set) var settings: KMMonthlyBudgetSettings?
    private(set) var defaultPlan: KMMonthlyBudgetPlan?
    private(set) var month: KMYearMonth
    private(set) var isLoading = true
    private(set) var isSaving = false
    var mode: Mode
    var error: String?
    var saved = false
    enum Mode: Equatable { case `default`, monthly }

    init(month: KMYearMonth, mode: Mode) { self.month = month; self.mode = mode }

    func load(_ repositories: KMRepositories?) async {
        guard let repositories else { error = "予算を読み込めませんでした。アプリを開き直してください。"; isLoading = false; return }
        do {
            settings = try await repositories.budgets.budgetSettings()
            summary = try await repositories.budgets.budgetSummary(month: month)
            defaultPlan = try KMMonthlyBudgetService.defaultPlan(settings: settings!)
            error = nil
        } catch { self.error = "予算を読み込めませんでした。\(error.localizedDescription)" }
        isLoading = false
    }

    func selectMode(_ mode: Mode, repositories: KMRepositories?) async {
        self.mode = mode; saved = false; error = nil
        await load(repositories)
    }

    func shiftMonth(_ offset: Int, repositories: KMRepositories?) async {
        month = month.shifted(by: offset); saved = false
        await load(repositories)
    }

    func save(total: String, breakdown: Bool, allocations: [String: String], repositories: KMRepositories?) async {
        guard let repositories, let settings, let summary else { error = "予算を保存できませんでした。アプリを開き直してください。"; return }
        isSaving = true; error = nil
        do {
            let totalYen = try KMBudgetPresentation.parseYen(total, label: "全体予算")
            var amounts: [String: Int] = [:]
            var sum = 0
            if breakdown {
                for category in summary.categories {
                    let raw = allocations[category.categoryId] ?? "0"
                    let amount = raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : try KMBudgetPresentation.parseYen(raw, label: "カテゴリ別予算")
                    amounts[category.categoryId] = amount
                    sum = try KMYen.add(sum, amount)
                }
                guard sum == totalYen else { throw KMDataError.invalidData("カテゴリ別予算の合計（\(KMAmountFormatter.yen(sum))）を全体予算（\(KMAmountFormatter.yen(totalYen))）と一致させてください。") }
            }
            let updated: KMMonthlyBudgetSettings
            switch mode {
            case .default: updated = try settings.applyingDefaultPlan(totalYen: totalYen, breakdownEnabled: breakdown, allocations: amounts)
            case .monthly: updated = try settings.applyingMonthlyPlan(yearMonth: month, totalYen: totalYen, breakdownEnabled: breakdown, allocations: amounts)
            }
            try await repositories.budgets.saveBudgetSettings(updated)
            saved = true
            await load(repositories)
        } catch { self.error = error.localizedDescription }
        isSaving = false
    }

    func reset(repositories: KMRepositories?) async {
        guard let repositories, let settings, let summary else { return }
        isSaving = true; error = nil
        do {
            let updated: KMMonthlyBudgetSettings
            switch mode {
            case .default: updated = try settings.clearingDefaultPlan()
            case .monthly: updated = try settings.resettingMonthlyPlan(yearMonth: month, categoryIds: summary.categories.map(\.categoryId))
            }
            try await repositories.budgets.saveBudgetSettings(updated)
            saved = true
            await load(repositories)
        } catch let saveError { error = saveError.localizedDescription }
        isSaving = false
    }
}
