import SwiftUI

private struct KMHomeAttentionItem: Identifiable {
    var id: String
    var merchant: String
    var amountYen: Int
    var status: KMStatus
    var reason: String
}

/// Presentation-only day scale from the budget summary; monetary totals come from repositories.
struct KMHomeBudgetScale: Equatable {
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
        var filledRatio = (summary.usageRatio ?? 0) * Decimal(days)
        var roundedFilled = Decimal()
        NSDecimalRound(&roundedFilled, &filledRatio, 0, .plain)
        let filled = over ? days : min(days, max(0, NSDecimalNumber(decimal: roundedFilled).intValue))
        var paceTarget = Decimal(summary.budgetYen) * Decimal(elapsed) / Decimal(days)
        var roundedPaceTarget = Decimal()
        NSDecimalRound(&roundedPaceTarget, &paceTarget, 0, .plain)
        let gap: Int? = summary.yearMonth == today.yearMonth && !over && summary.budgetYen > 0
            ? summary.spentYen - NSDecimalNumber(decimal: roundedPaceTarget).intValue : nil
        return Self(dayCount: days, filledDayCount: filled, elapsedDayCount: elapsed,
                    paceDifferenceYen: gap, isOverBudget: over)
    }
}

struct HomeView: View {
    @Environment(\.repositories) private var repositories
    @State private var snapshot: KMHomeSnapshot?
    @State private var attentionItems: [KMHomeAttentionItem] = []
    @State private var attentionCount = 0
    @State private var matchedCount = 0
    @State private var hasImportedStatements = false
    @State private var accounts: [String: String] = [:]
    @State private var selectedMonth: KMYearMonth?
    @State private var budgetExpanded = false
    @State private var errorMessage: String?
    var onNavigate: (KMTab) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space4) {
            if let month = selectedMonth {
                monthSelector(month)
            }
            if let errorMessage {
                Text(errorMessage).font(KMTypography.text).foregroundStyle(KMColor.danger)
                    .accessibilityIdentifier("home.error")
            } else if let snapshot {
                totals(snapshot.summary)
                budget(snapshot.budget)
                attentionSection
                categoryBreakdown(snapshot.summary)
                recentRecords(snapshot.recentRecords)
            } else {
                ProgressView().tint(KMColor.primary).frame(maxWidth: .infinity).padding(.vertical, KMSpacing.space8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, KMSpacing.space2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.screen")
        .task(id: selectedMonth?.rawValue) { await load() }
    }

    private func monthSelector(_ month: KMYearMonth) -> some View {
        HStack {
            Button { selectMonth(month.shifted(by: -1)) } label: { KMIcon(name: "chevronLeft").frame(width: 44, height: 44) }
                .accessibilityLabel("前月へ").accessibilityIdentifier("home.month.previous")
            Spacer()
            Text(String(format: "%d年%d月", month.year, month.month)).font(KMTypography.body(18, weight: .bold)).foregroundStyle(KMColor.text)
                .accessibilityIdentifier("home.month.label")
            Spacer()
            Button { selectMonth(month.shifted(by: 1)) } label: { KMIcon(name: "chevronRight").frame(width: 44, height: 44) }
                .accessibilityLabel("翌月へ").accessibilityIdentifier("home.month.next")
        }
        .buttonStyle(.plain).foregroundStyle(KMColor.text)
        .frame(height: KMLayout.minimumHit)
        .overlay(alignment: .bottom) {
            if let repositories, month != KMDate(instant: repositories.referenceDate).yearMonth {
                Button("当月へ戻る") { selectMonth(KMDate(instant: repositories.referenceDate).yearMonth) }
                    .font(KMTypography.note).foregroundStyle(KMColor.primary).offset(y: 22)
                    .accessibilityIdentifier("home.month.current")
            }
        }
        .padding(.bottom, 4)
    }

    private func selectMonth(_ month: KMYearMonth) { selectedMonth = month }

    private func totals(_ summary: KMMonthlySummary) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            VStack(alignment: .leading, spacing: 0) {
                Text(summary.yearMonth == currentMonth ? "今月の支出" : "支出")
                    .font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
                KMAmount(yen: -summary.expenseYen, size: 40)
                    .font(KMTypography.number(40, weight: .bold))
                    .accessibilityIdentifier("home.monthly.expense")
            }
            HStack(spacing: 0) {
                totalCell(title: "収入", amount: summary.incomeYen, color: KMColor.income, showsPositiveSign: false)
                totalCell(title: "収支", amount: summary.balanceYen, color: KMColor.text, showsPositiveSign: true)
                    .padding(.leading, KMSpacing.space3)
                    .overlay(alignment: .leading) { Rectangle().fill(KMColor.border).frame(width: 1) }
            }
            .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
            .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
        }
    }

    private func totalCell(title: String, amount: Int, color: Color, showsPositiveSign: Bool) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space1) {
            Text(title).font(KMTypography.note).foregroundStyle(KMColor.muted)
            Text("\(amount > 0 && showsPositiveSign ? "+" : amount < 0 ? "−" : "")\(KMAmountFormatter.yen(amount))")
                .font(KMTypography.number(17, weight: .semibold)).foregroundStyle(color)
                .lineLimit(1).minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, KMSpacing.space2)
    }

    private func budget(_ summary: KMMonthlyBudgetSummary) -> some View {
        Group {
            if summary.budgetConfigured {
                let scale = KMHomeBudgetScale.make(summary: summary, today: today)
                VStack(alignment: .leading, spacing: KMSpacing.space2) {
                    Button { budgetExpanded.toggle() } label: {
                        VStack(alignment: .leading, spacing: KMSpacing.space2) {
                            HStack {
                                Text("予算 \(KMAmountFormatter.yen(summary.budgetYen))")
                                Spacer()
                                Text(summary.remainingYen < 0 ? "超過 \(KMAmountFormatter.yen(-summary.remainingYen))" : "残り \(KMAmountFormatter.yen(summary.remainingYen))")
                                    .foregroundStyle(summary.remainingYen < 0 ? KMColor.danger : KMColor.muted)
                                KMIcon(name: "chevronRight").rotationEffect(.degrees(budgetExpanded ? 90 : 0))
                                    .foregroundStyle(KMColor.muted)
                            }
                            .font(KMTypography.number(14, weight: .medium))
                            .accessibilityLabel("\(summary.yearMonth.month)月の予算 \(KMAmountFormatter.yen(summary.budgetYen))、使用額 \(KMAmountFormatter.yen(summary.spentYen))、\(summary.remainingYen < 0 ? "超過" : "残り") \(KMAmountFormatter.yen(abs(summary.remainingYen)))")
                            if summary.budgetYen > 0 {
                                GeometryReader { geometry in
                                    ZStack(alignment: .leading) {
                                        HStack(spacing: 2) {
                                            ForEach(1...scale.dayCount, id: \.self) { day in
                                                RoundedRectangle(cornerRadius: 2)
                                                    .fill(tickColor(day: day, scale: scale))
                                                    .frame(width: tickWidth(in: geometry.size.width, days: scale.dayCount), height: 26)
                                            }
                                        }
                                        if scale.elapsedDayCount > 0 && scale.elapsedDayCount < scale.dayCount {
                                            Rectangle().fill(KMColor.text).frame(width: 2, height: 36)
                                                .offset(x: geometry.size.width * CGFloat(scale.elapsedDayCount) / CGFloat(scale.dayCount) - 1)
                                        }
                                    }
                                }
                                .frame(height: 36)
                                .accessibilityHidden(true)
                                if let gap = scale.paceDifferenceYen {
                                    HStack(spacing: 4) {
                                        Text("1日")
                                        Spacer(minLength: 0)
                                        Text("今日\(scale.elapsedDayCount)日 · \(paceText(gap))").lineLimit(1).minimumScaleFactor(0.75)
                                        Spacer(minLength: 0)
                                        Text("\(scale.dayCount)日")
                                    }.font(KMTypography.body(12)).foregroundStyle(KMColor.muted)
                                }
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("home.budget")
                    if budgetExpanded { budgetDetails(summary) }
                }
            } else {
                HStack {
                    Text("予算").foregroundStyle(KMColor.muted)
                    Spacer()
                    Button("予算を設定する") { onNavigate(.settings) }
                        .font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
                        .frame(minHeight: KMLayout.minimumHit)
                        .accessibilityIdentifier("home.budget.setup")
                }
                .font(KMTypography.body(14))
            }
        }
        .padding(.vertical, KMSpacing.space2)
        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private func budgetDetails(_ summary: KMMonthlyBudgetSummary) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text("\(summary.overallBudgetConfigured ? "全体予算" : "予算対象カテゴリの合計")：\(KMAmountFormatter.yen(summary.spentYen)) / \(KMAmountFormatter.yen(summary.budgetYen))")
                .font(KMTypography.note).foregroundStyle(KMColor.muted)
            if summary.breakdownEnabled {
                ForEach(summary.categories.filter { $0.budgetYen != nil }) { category in
                    HStack {
                        Text(category.categoryName).lineLimit(1)
                        Spacer()
                        Text("\(KMAmountFormatter.yen(category.spentYen)) / \(KMAmountFormatter.yen(category.budgetYen ?? 0))")
                            .font(KMTypography.number(12)).foregroundStyle(KMColor.muted)
                    }.font(KMTypography.note)
                }
            } else {
                Text("カテゴリ別の内訳は設定していません。")
                    .font(KMTypography.note).foregroundStyle(KMColor.muted)
            }
            Button("この月の予算を変更") { onNavigate(.settings) }
                .font(KMTypography.body(14, weight: .medium)).foregroundStyle(KMColor.primary)
                .frame(minHeight: KMLayout.minimumHit, alignment: .leading)
        }
        .padding(.top, KMSpacing.space2)
    }

    private func tickColor(day: Int, scale: KMHomeBudgetScale) -> Color {
        if scale.isOverBudget { return KMColor.danger }
        guard day <= scale.filledDayCount else { return KMColor.sunken }
        return day <= scale.elapsedDayCount ? KMColor.primary : KMColor.warning
    }

    private func tickWidth(in width: CGFloat, days: Int) -> CGFloat {
        max(0, (width - CGFloat(max(0, days - 1) * 2)) / CGFloat(days))
    }

    private func paceText(_ gap: Int) -> String {
        guard gap != 0 else { return "目安どおり" }
        return "目安より \(KMAmountFormatter.yen(abs(gap))) \(gap > 0 ? "多め" : "少なめ")"
    }

    private var attentionSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            if attentionCount > 0 {
                VStack(spacing: 0) {
                    HStack {
                        Text("確認すること").font(KMTypography.body(16, weight: .bold)).foregroundStyle(KMColor.text)
                            .accessibilityAddTraits(.isHeader)
                        Text("\(attentionCount)").font(KMTypography.number(13, weight: .bold))
                            .foregroundStyle(KMColor.warning).padding(.horizontal, 8).padding(.vertical, 4)
                            .background(KMColor.warningSoft, in: Capsule())
                            .accessibilityLabel("\(attentionCount)件")
                        Spacer()
                        Button("照合へ") { onNavigate(.reconciliation) }
                            .font(KMTypography.body(14, weight: .medium)).foregroundStyle(KMColor.primary)
                            .accessibilityIdentifier("home.attention.open")
                    }
                    .padding(.bottom, KMSpacing.space2)
                    ForEach(Array(attentionItems.prefix(3))) { item in
                        Button { onNavigate(.reconciliation) } label: {
                            HStack(spacing: KMSpacing.space3) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.merchant).font(KMTypography.body(15, weight: .medium)).foregroundStyle(KMColor.text).lineLimit(1)
                                    KMStatusLabel(status: item.status, message: item.reason)
                                }
                                Spacer(minLength: KMSpacing.space2)
                                KMAmount(yen: item.amountYen, size: 15)
                            }
                            .padding(.vertical, KMSpacing.space2)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
                        .accessibilityIdentifier("home.attention.row.\(item.id)")
                    }
                }
                .padding(KMSpacing.space4)
                .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.xl))
                .overlay(RoundedRectangle(cornerRadius: KMRadius.xl).stroke(KMColor.border, lineWidth: 1))
            } else if !hasImportedStatements {
                Button { onNavigate(.reconciliation) } label: {
                    HStack {
                        Text("明細を取り込んで自動で照合する")
                        Spacer()
                        KMIcon(name: "chevronRight")
                    }
                    .font(KMTypography.body(16, weight: .medium)).foregroundStyle(KMColor.primary)
                    .frame(minHeight: 56)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("home.statement-import-hint")
            }
            if matchedCount > 0 {
                HStack(spacing: KMSpacing.space3) {
                    KMCompletedStamp()
                    Text("\(matchedCount)件 は一致しています")
                        .font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
                }
                .frame(minHeight: 44, alignment: .leading)
                .accessibilityIdentifier("home.matched")
            }
        }
    }

    private func categoryBreakdown(_ summary: KMMonthlySummary) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            Text("支出の内訳").font(KMTypography.heading).foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader)
            categoryContent(summary)
            allCategories(summary)
        }
        .padding(.vertical, KMSpacing.space4)
        .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    @ViewBuilder private func categoryContent(_ summary: KMMonthlySummary) -> some View {
        if summary.expenseYen == 0 {
            Text("この月の支出はありません。")
                .font(KMTypography.body(15)).foregroundStyle(KMColor.muted)
        } else {
            let positive = summary.categories.filter { $0.amountYen > 0 }
            let top = Array(positive.prefix(3))
            let remainder = positive.dropFirst(3).reduce(0) { $0 + $1.amountYen }
            if top.isEmpty {
                Text("この月は返金・調整だけです。").font(KMTypography.body(15)).foregroundStyle(KMColor.muted)
            } else {
                categoryChart(categories: top, remainder: remainder,
                              positiveTotal: positive.reduce(0) { $0 + $1.amountYen }, expenseTotal: summary.expenseYen)
            }
        }
    }

    private func categoryChart(categories: [KMMonthlyCategory], remainder: Int, positiveTotal: Int, expenseTotal: Int) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            GeometryReader { geometry in
                let sliceCount = categories.count + (remainder > 0 ? 1 : 0)
                let availableWidth = max(0, geometry.size.width - CGFloat(max(0, sliceCount - 1) * 2))
                HStack(spacing: 2) {
                    ForEach(Array(categories.enumerated()), id: \.offset) { _, category in
                        let width = availableWidth * CGFloat(category.amountYen) / CGFloat(positiveTotal)
                        Rectangle().fill(KMCategoryTone.visual(name: category.categoryName, id: category.categoryId).tone.foreground)
                            .frame(width: width)
                    }
                    if remainder > 0 {
                        let width = availableWidth * CGFloat(remainder) / CGFloat(positiveTotal)
                        Rectangle().fill(KMColor.cOther).frame(width: width)
                    }
                }
            }
            .frame(height: 12).clipShape(Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("支出の内訳：" + categories.map { "\($0.categoryName) \(percentage($0.amountYen, total: expenseTotal))" }.joined(separator: "、"))
            categoryLegends(categories: categories, remainder: remainder, expenseTotal: expenseTotal)
        }
    }

    private func categoryLegends(categories: [KMMonthlyCategory], remainder: Int, expenseTotal: Int) -> some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: KMSpacing.space2) {
            ForEach(Array(categories.enumerated()), id: \.offset) { _, category in
                let tone = KMCategoryTone.visual(name: category.categoryName, id: category.categoryId).tone.foreground
                categoryLegend(name: category.categoryName, amount: category.amountYen, total: expenseTotal, tone: tone)
            }
            if remainder > 0 {
                categoryLegend(name: "その他", amount: remainder, total: expenseTotal, tone: KMColor.cOther)
            }
        }
    }

    private func allCategories(_ summary: KMMonthlySummary) -> some View {
        DisclosureGroup("すべてのカテゴリ") {
            VStack(alignment: .leading, spacing: KMSpacing.space2) {
                ForEach(Array(summary.categories.enumerated()), id: \.offset) { _, category in
                    HStack {
                        Text(category.categoryName).lineLimit(1)
                        Spacer()
                        let sign = category.amountYen < 0 ? "−" : ""
                        let amount = KMAmountFormatter.yen(category.amountYen)
                        Text("\(sign)\(amount) · \(percentage(category.amountYen, total: summary.expenseYen))")
                            .font(KMTypography.number(12))
                    }
                    .font(KMTypography.note).foregroundStyle(KMColor.text)
                }
            }.padding(.top, KMSpacing.space2)
        }
        .font(KMTypography.body(15, weight: .medium)).tint(KMColor.primary)
        .accessibilityIdentifier("home.categories.all")
    }

    private func categoryLegend(name: String, amount: Int, total: Int, tone: Color) -> some View {
        HStack(spacing: KMSpacing.space2) {
            Circle().fill(tone).frame(width: 10, height: 10)
            Text(name).lineLimit(1).font(KMTypography.body(14))
            Spacer(minLength: 0)
            Text(percentage(amount, total: total)).font(KMTypography.number(13, weight: .semibold))
        }
        .foregroundStyle(KMColor.text)
    }

    private func percentage(_ amount: Int, total: Int) -> String {
        guard total > 0 else { return "0.0%" }
        var value = Decimal(amount) / Decimal(total) * 100
        var rounded = Decimal()
        NSDecimalRound(&rounded, &value, 1, .plain)
        return "\(NSDecimalNumber(decimal: rounded).stringValue)%"
    }

    private func recentRecords(_ records: [KMTransaction]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("最近の記録").font(KMTypography.heading).foregroundStyle(KMColor.text)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button("すべて ›") { onNavigate(.records) }
                    .font(KMTypography.body(15)).foregroundStyle(KMColor.primary)
                    .accessibilityIdentifier("home.recent.all")
            }
            .padding(.bottom, KMSpacing.space2)
            if records.isEmpty {
                Text("まだ記録がありません。").font(KMTypography.body(15)).foregroundStyle(KMColor.muted)
                    .padding(.vertical, KMSpacing.space4)
            } else {
                ForEach(records) { transaction in
                    KMRecordRow(record: recordSummary(transaction), identifier: "home.recent.row.\(transaction.id)") {
                        onNavigate(.records)
                    }
                }
            }
        }
        .padding(.top, KMSpacing.space4)
        .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private func recordSummary(_ transaction: KMTransaction) -> KMRecordSummary {
        KMRecordSummary(kind: transaction.kind == .expense ? .expense : transaction.kind == .income ? .income : .transfer,
                        amountYen: transaction.amountYen, date: transaction.date.rawValue,
                        payeeName: transaction.payeeName, categoryName: transaction.categoryName,
                        categoryID: transaction.categoryId, accountName: accounts[transaction.accountId],
                        memo: transaction.memo, excludedFromSpending: transaction.excludedFromSpending == true)
    }

    private var currentMonth: KMYearMonth? {
        repositories.map { KMDate(instant: $0.referenceDate).yearMonth }
    }

    private var today: KMDate {
        KMDate(instant: repositories?.referenceDate ?? Date())
    }

    @MainActor private func load() async {
        guard let repositories else {
            errorMessage = "家計データを読み込めません。"
            return
        }
        if selectedMonth == nil { selectedMonth = KMDate(instant: repositories.referenceDate).yearMonth }
        guard let month = selectedMonth else { return }
        do {
            let data = try await repositories.transactions.home(month: month)
            let accountRows = try await repositories.accounts.accounts(includeClosed: true)
            let run = try await repositories.reconciliation.latestRun()
            let resolutions = try await repositories.reconciliation.resolutions()
            let suspected = try await repositories.reconciliation.suspectedStatements()
            let statements = try await repositories.statements.statementTransactions()
            let imports = try await repositories.statements.statementImports()
            snapshot = data
            accounts = Dictionary(uniqueKeysWithValues: accountRows.map { ($0.id, $0.name) })
            hasImportedStatements = !imports.isEmpty || !statements.isEmpty
            updateAttention(run: run, resolutions: resolutions, suspected: suspected, statements: statements)
            errorMessage = nil
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "ホームを読み込めませんでした。"
        }
    }

    private func updateAttention(run: KMReconciliationRun?, resolutions: [KMReconciliationResolution],
                                 suspected: [KMSuspectedStatement], statements: [KMStatementTransaction]) {
        let byId = Dictionary(uniqueKeysWithValues: statements.map { ($0.id, $0) })
        let decisionIds = Set(resolutions.map(\.statementId))
        let suspectedIds = Set(suspected.map(\.statementId))
        let pending = run?.statementResults.filter {
            $0.status != .matched && !decisionIds.contains($0.statementTransactionId) && !suspectedIds.contains($0.statementTransactionId)
        } ?? []
        let needsReview = pending.filter { $0.status == .needsReview }.count
        let unmatched = pending.filter { $0.status != .needsReview }.count
        let failed = resolutions.filter { $0.status != .applied }.count
        attentionCount = (run == nil ? 0 : needsReview + unmatched + failed + suspected.count)
        matchedCount = resolutions.filter { $0.resolution == .sameExpense && $0.status == .applied && $0.undoRequestedAt == nil }.count
        var items: [KMHomeAttentionItem] = []
        for decision in resolutions.filter({ $0.status != .applied }) {
            let row = byId[decision.statementId]
            items.append(.init(id: decision.statementId, merchant: row?.merchant ?? "保存済みの照合",
                               amountYen: row?.amountYen ?? decision.statementAmountYen,
                               status: .danger, reason: "反映できませんでした"))
        }
        for flag in suspected {
            guard let row = byId[flag.statementId] else { continue }
            items.append(.init(id: row.id, merchant: row.merchant, amountYen: row.amountYen,
                               status: .warning, reason: "不正利用？として確認待ち"))
        }
        for result in pending where result.status == .needsReview {
            guard let row = byId[result.statementTransactionId] else { continue }
            let candidates = run?.candidates.filter { $0.statementTransactionId == result.statementTransactionId } ?? []
            let candidate = candidates.first
            let reason = candidates.count > 1 ? "候補が\(candidates.count)件あります"
                : candidate.map { $0.amountDeltaYen != 0 ? "金額が\(KMAmountFormatter.yen(abs($0.amountDeltaYen)))違います" : $0.dateDistanceDays != 0 ? "日付が\($0.dateDistanceDays)日ずれています" : "内容を確認してください" }
                    ?? "内容を確認してください"
            items.append(.init(id: row.id, merchant: row.merchant, amountYen: row.amountYen, status: .warning, reason: reason))
        }
        for result in pending where result.status != .needsReview {
            guard let row = byId[result.statementTransactionId] else { continue }
            items.append(.init(id: row.id, merchant: row.merchant, amountYen: row.amountYen,
                               status: .missing, reason: "記録が見つかりません"))
        }
        attentionItems = items
    }
}

#if DEBUG
#Preview {
    KMFixturePreview("populated") { HomeView() }
}
#endif
