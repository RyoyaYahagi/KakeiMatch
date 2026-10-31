import Foundation

/// PWA local-ui.ts reconciliationState/homeAttentionItems + home-attention.ts.
/// No repository access or View state: preserves source ordering within each priority.
struct KMHomeAttentionItem: Identifiable, Equatable, Sendable {
    var id: String
    var merchant: String
    var amountYen: Int
    var severity: KMHomeAttentionSeverity
    var reason: String
}

/// Screen status is mapped from this in HomeView; Data-layer aggregation stays SwiftUI-free.
enum KMHomeAttentionSeverity: String, Equatable, Sendable {
    case danger, warning, missing
}

struct KMHomeAttention: Equatable, Sendable {
    var count: Int
    var matchedCount: Int
    var showsImportHint: Bool
    var items: [KMHomeAttentionItem]

    static func make(run: KMReconciliationRun?, resolutions: [KMReconciliationResolution],
                     suspected: [KMSuspectedStatement], statements: [KMStatementTransaction]) -> Self {
        // PWA's null counts return the import hint before rendering matches or failures.
        guard let run else { return Self(count: 0, matchedCount: 0, showsImportHint: true, items: []) }
        let byId = Dictionary(uniqueKeysWithValues: statements.map { ($0.id, $0) })
        let decidedIds = Set(resolutions.map(\.statementId))
        let suspectedIds = Set(suspected.map(\.statementId))
        let pending = run.statementResults.filter {
            $0.status != .matched && !decidedIds.contains($0.statementTransactionId) && !suspectedIds.contains($0.statementTransactionId)
        }
        let failed = resolutions.filter { $0.status != .applied }
        var items: [KMHomeAttentionItem] = []
        for decision in failed {
            let row = byId[decision.statementId]
            items.append(.init(id: "failed.\(decision.id)", merchant: row?.merchant ?? "保存済みの照合",
                               amountYen: row?.amountYen ?? decision.statementAmountYen,
                               severity: .danger, reason: "反映できませんでした"))
        }
        for flag in suspected {
            guard let row = byId[flag.statementId] else { continue }
            items.append(.init(id: "suspected.\(row.id)", merchant: row.merchant, amountYen: row.amountYen,
                               severity: .warning, reason: "不正利用？として確認待ち"))
        }
        for result in pending where result.status == .needsReview {
            guard let row = byId[result.statementTransactionId] else { continue }
            let candidates = run.candidates.filter { $0.statementTransactionId == row.id }
            let reason: String
            if candidates.count > 1 { reason = "候補が\(candidates.count)件あります" }
            else if let candidate = candidates.first, candidate.amountDeltaYen != 0 {
                reason = "金額が\(KMAmountFormatter.yen(candidate.amountDeltaYen))違います"
            } else if let candidate = candidates.first, candidate.dateDistanceDays != 0 {
                reason = "日付が\(candidate.dateDistanceDays)日ずれています"
            } else { reason = "内容を確認してください" }
            items.append(.init(id: row.id, merchant: row.merchant, amountYen: row.amountYen, severity: .warning, reason: reason))
        }
        for result in pending where result.status != .needsReview {
            guard let row = byId[result.statementTransactionId] else { continue }
            items.append(.init(id: row.id, merchant: row.merchant, amountYen: row.amountYen,
                               severity: .missing, reason: "記録が見つかりません"))
        }
        return Self(count: pending.count + failed.count + suspected.count,
                    matchedCount: resolutions.filter { $0.resolution == .sameExpense && $0.status == .applied && $0.undoRequestedAt == nil }.count,
                    showsImportHint: false, items: Array(items.prefix(3)))
    }
}

/// Presentation-only day scale; totals remain integer yen from repositories.
struct KMHomeBudgetScale: Equatable, Sendable {
    var dayCount: Int
    var filledDayCount: Int
    var elapsedDayCount: Int
    var paceDifferenceYen: Int?
    var isOverBudget: Bool

    static func make(summary: KMMonthlyBudgetSummary, today: KMDate) -> Self {
        let days = summary.yearMonth.daysInMonth
        let elapsed: Int
        if summary.yearMonth < today.yearMonth { elapsed = days }
        else if summary.yearMonth > today.yearMonth { elapsed = 0 }
        else { elapsed = Int(today.rawValue.suffix(2)) ?? 0 }
        let over = summary.remainingYen < 0
        let filled = summary.budgetYen > 0
            ? min(days, max(0, rounded((KMJSNumber(summary.spentYen) / KMJSNumber(summary.budgetYen) * KMJSNumber(days)).decimalApproximation))) : 0
        let gap: Int? = summary.yearMonth == today.yearMonth && !over && summary.budgetYen > 0
            ? summary.spentYen - rounded((KMJSNumber(summary.budgetYen) * KMJSNumber(elapsed) / KMJSNumber(days)).decimalApproximation) : nil
        return Self(dayCount: days, filledDayCount: over ? days : filled, elapsedDayCount: elapsed,
                    paceDifferenceYen: gap, isOverBudget: over)
    }

    private static func rounded(_ value: Decimal) -> Int {
        var value = value
        var result = Decimal()
        NSDecimalRound(&result, &value, 0, .plain)
        return NSDecimalNumber(decimal: result).intValue
    }
}

struct KMHomeCategorySlice: Equatable, Sendable {
    var name: String
    var amountYen: Int
    /// nil is PWA tone-rest (other-soft), not the foreground of tone-other.
    var tone: KMCategoryTone?
    var share: Decimal
    var percentage: String
}

/// PWA local-monthly-dashboard.ts: positive amounts sorted stably, unique top-three
/// tones, then the remainder. Refunds affect legend percentages, not bar widths.
enum KMHomeCategoryBreakdown {
    static func make(_ summary: KMMonthlySummary) -> [KMHomeCategorySlice] {
        guard summary.expenseYen != 0 else { return [] }
        let positive = summary.categories.enumerated().filter { $0.element.amountYen > 0 }.sorted {
            $0.element.amountYen == $1.element.amountYen ? $0.offset < $1.offset : $0.element.amountYen > $1.element.amountYen
        }.map(\.element)
        let total = positive.reduce(Decimal(0)) { $0 + Decimal($1.amountYen) }
        var used: Set<KMCategoryTone> = []
        var slices: [KMHomeCategorySlice] = positive.prefix(3).map { category in
            let preferred = KMCategoryTone.visual(name: category.categoryName, id: category.categoryId).tone
            let tone = used.contains(preferred) ? KMCategoryTone.allCases.first { $0 != .other && !used.contains($0) }! : preferred
            used.insert(tone)
            return .init(name: category.categoryName, amountYen: category.amountYen, tone: tone,
                         share: Decimal(category.amountYen) / total,
                         percentage: percentage(category.amountYen, total: summary.expenseYen))
        }
        let rest = positive.dropFirst(3).reduce(0) { $0 + $1.amountYen }
        if rest > 0 {
            slices.append(.init(name: "その他", amountYen: rest, tone: nil, share: Decimal(rest) / total,
                                percentage: percentage(rest, total: summary.expenseYen)))
        }
        return slices
    }

    static func percentage(_ amount: Int, total: Int) -> String {
        guard total != 0 else { return "0.0%" }
        // Preserve JS's operation order and binary64 result before toFixed(1).
        // KMJSNumber simulates that arithmetic with integers; yen never pass through Double.
        var tenths = (KMJSNumber(amount) / KMJSNumber(total) * KMJSNumber(100)).decimalApproximation * 10
        var rounded = Decimal()
        NSDecimalRound(&rounded, &tenths, 0, .plain)
        let value = NSDecimalNumber(decimal: rounded).intValue
        let negative = (amount < 0) != (total < 0)
        return "\(negative ? "-" : "")\(abs(value) / 10).\(abs(value) % 10)%"
    }
}

/// One row of the expanded "all categories" list; order follows the monthly summary.
struct KMHomeCategoryRow: Equatable, Sendable {
    var name: String
    var amountYen: Int
    var percentage: String
}

/// Every value Home renders after the repository's one read: monthly totals, budget,
/// recent rows, attention counts/rows, category breakdown and the budget day scale.
struct KMHomeDashboard: Equatable, Sendable {
    var snapshot: KMHomeSnapshot
    var attention: KMHomeAttention
    var categorySlices: [KMHomeCategorySlice]
    var categoryRows: [KMHomeCategoryRow]
    var budgetScale: KMHomeBudgetScale
}

enum KMHomeAggregation {
    static func make(snapshot: KMHomeSnapshot, run: KMReconciliationRun?,
                     resolutions: [KMReconciliationResolution], suspected: [KMSuspectedStatement],
                     statements: [KMStatementTransaction], today: KMDate) -> KMHomeDashboard {
        KMHomeDashboard(snapshot: snapshot,
                        attention: KMHomeAttention.make(run: run, resolutions: resolutions, suspected: suspected, statements: statements),
                        categorySlices: KMHomeCategoryBreakdown.make(snapshot.summary),
                        categoryRows: snapshot.summary.categories.map {
                            KMHomeCategoryRow(name: $0.categoryName, amountYen: $0.amountYen,
                                              percentage: KMHomeCategoryBreakdown.percentage($0.amountYen, total: snapshot.summary.expenseYen))
                        },
                        budgetScale: KMHomeBudgetScale.make(summary: snapshot.budget, today: today))
    }
}
