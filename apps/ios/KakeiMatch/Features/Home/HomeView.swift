import SwiftUI

struct HomeView: View {
    @Environment(\.repositories) private var repositories
    @State private var snapshot: KMHomeSnapshot?
    @State private var attentionItems: [KMHomeAttentionItem] = []
    @State private var attentionCount = 0
    @State private var matchedCount = 0
    @State private var showsImportHint = true
    @State private var accounts: [String: String] = [:]
    @State private var selectedMonth: KMYearMonth?
    @State private var budgetExpanded = false
    @State private var categoriesExpanded = false
    @State private var errorMessage: String?
    var onNavigate: (KMTab) -> Void = { _ in }
    var onOpenBudget: (KMYearMonth) -> Void = { _ in }

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
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.screen")
        .task(id: selectedMonth?.rawValue) { await load() }
    }

    private func monthSelector(_ month: KMYearMonth) -> some View {
        VStack(spacing: KMSpacing.space1) {
            HStack {
                Button { selectMonth(month.shifted(by: -1)) } label: {
                    KMIcon(name: "chevronLeft", size: 20).frame(width: 44, height: 44).background(KMColor.surface, in: Circle())
                }
                .accessibilityLabel("前月へ").accessibilityIdentifier("home.month.previous")
                Spacer()
                Text(String(format: "%d年%d月", month.year, month.month))
                    .font(KMTypography.body(18, weight: .bold)).foregroundStyle(KMColor.text)
                    .accessibilityIdentifier("home.month.label")
                Spacer()
                Button { selectMonth(month.shifted(by: 1)) } label: {
                    KMIcon(name: "chevronRight", size: 20).frame(width: 44, height: 44).background(KMColor.surface, in: Circle())
                }
                .accessibilityLabel("翌月へ").accessibilityIdentifier("home.month.next")
            }
            .buttonStyle(.plain).foregroundStyle(KMColor.text)
            .frame(height: KMLayout.minimumHit)
            if let repositories, month != KMDate(instant: repositories.referenceDate).yearMonth {
                Button("当月へ戻る") { selectMonth(KMDate(instant: repositories.referenceDate).yearMonth) }
                    .font(KMTypography.note).foregroundStyle(KMColor.primary)
                    .frame(minHeight: KMLayout.minimumHit)
                    .accessibilityIdentifier("home.month.current")
            }
        }
    }

    private func selectMonth(_ month: KMYearMonth) { selectedMonth = month }

    private func totals(_ summary: KMMonthlySummary) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            VStack(alignment: .leading, spacing: 0) {
                Text(summary.yearMonth == currentMonth ? "今月の支出" : "支出")
                    .font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
                Text(KMAmountFormatter.yen(summary.expenseYen))
                    .font(KMTypography.number(42, weight: .bold)).tracking(-1.68)
                    .foregroundStyle(KMColor.text)
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
                                Text("予算 \(KMAmountFormatter.yen(summary.budgetYen))").foregroundStyle(KMColor.muted)
                                Spacer()
                                Text(summary.remainingYen < 0 ? "超過 \(KMAmountFormatter.yen(-summary.remainingYen))" : "残り \(KMAmountFormatter.yen(summary.remainingYen))")
                                    .foregroundStyle(summary.remainingYen < 0 ? KMColor.danger : KMColor.muted)
                                Text("›").foregroundStyle(KMColor.muted)
                            }
                            .font(KMTypography.number(14, weight: .regular))
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
                                                .offset(x: geometry.size.width * CGFloat(scale.elapsedDayCount) / CGFloat(scale.dayCount) - 1, y: -5)
                                        }
                                    }
                                }
                                .frame(height: 26)
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
                    .accessibilityIdentifier("home.budget.details")
                    if budgetExpanded { budgetDetails(summary) }
                }
                .accessibilityIdentifier("home.budget")
            } else {
                HStack {
                    Text("予算").foregroundStyle(KMColor.muted)
                    Spacer()
                    Button("予算を設定する") { onOpenBudget(selectedMonth ?? currentMonth ?? KMDate(instant: Date()).yearMonth) }
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
            Button("この月の予算を変更") { onOpenBudget(summary.yearMonth) }
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
                        Text("確認すること").font(KMTypography.body(15, weight: .black)).foregroundStyle(KMColor.text)
                            .accessibilityAddTraits(.isHeader)
                        Text("\(attentionCount)").font(KMTypography.number(13, weight: .bold))
                            .foregroundStyle(KMColor.warning).padding(.horizontal, 8).padding(.vertical, 4)
                            .background(KMColor.warningSoft, in: Capsule())
                            .accessibilityLabel("\(attentionCount)件")
                        Spacer()
                        Button { onNavigate(.reconciliation) } label: {
                            Text("照合へ").font(KMTypography.body(14, weight: .medium)).foregroundStyle(KMColor.primary)
                                .frame(minWidth: KMLayout.minimumHit, minHeight: KMLayout.minimumHit).contentShape(Rectangle())
                        }
                        .accessibilityIdentifier("home.attention.open")
                    }
                    .frame(minHeight: 48)
                    .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
                    ForEach(attentionItems) { item in
                        Button { onNavigate(.reconciliation) } label: {
                            HStack(spacing: KMSpacing.space3) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.merchant).font(KMTypography.body(15, weight: .medium)).foregroundStyle(KMColor.text).lineLimit(1)
                                    HStack(spacing: KMSpacing.space1) {
                                        Text(item.status.symbol).font(KMTypography.body(11, weight: .black))
                                            .foregroundStyle(item.status.foreground).frame(width: 18, height: 18)
                                            .background(item.status.background, in: Circle())
                                        Text(item.reason).font(KMTypography.body(13, weight: .medium)).foregroundStyle(KMColor.muted).lineLimit(1)
                                    }
                                }
                                Spacer(minLength: KMSpacing.space2)
                                KMAmount(yen: item.amountYen, size: 15)
                            }
                            .frame(minHeight: 60)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .overlay(alignment: .bottom) {
                            if item.id != attentionItems.last?.id { Rectangle().fill(KMColor.border).frame(height: 1) }
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(item.merchant) · \(item.reason) · \(KMAmountFormatter.yen(item.amountYen))")
                        .accessibilityIdentifier("home.attention.row.\(item.id)")
                    }
                }
                .padding(.horizontal, KMSpacing.space4)
                .padding(.vertical, KMSpacing.space1)
                .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.xl))
                .overlay(RoundedRectangle(cornerRadius: KMRadius.xl).stroke(KMColor.border, lineWidth: 1))
            } else if showsImportHint {
                Button { onNavigate(.reconciliation) } label: {
                    HStack {
                        Text("明細を取り込んで自動で照合する")
                        Spacer()
                        KMIcon(name: "chevronRight")
                    }
                    .font(KMTypography.body(16, weight: .medium)).foregroundStyle(KMColor.primary)
                    .frame(minHeight: 44)
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
            Text("支出の内訳").font(KMTypography.body(15, weight: .bold)).foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader)
            categoryContent(summary)
            if !KMHomeCategoryBreakdown.make(summary).isEmpty { allCategories(summary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, KMSpacing.space4)
        .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    @ViewBuilder private func categoryContent(_ summary: KMMonthlySummary) -> some View {
        if summary.expenseYen == 0 {
            Text("この月の支出はありません。")
                .font(KMTypography.body(15)).foregroundStyle(KMColor.muted)
        } else {
            let slices = KMHomeCategoryBreakdown.make(summary)
            if slices.isEmpty {
                Text("この月は返金・調整だけです。").font(KMTypography.body(15)).foregroundStyle(KMColor.muted)
            } else {
                categoryChart(slices)
            }
        }
    }

    private func categoryChart(_ slices: [KMHomeCategorySlice]) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            GeometryReader { geometry in
                let availableWidth = max(0, geometry.size.width - CGFloat(max(0, slices.count - 1) * 2))
                HStack(spacing: 2) {
                    ForEach(Array(slices.enumerated()), id: \.offset) { _, slice in
                        Rectangle().fill(slice.tone?.foreground ?? KMColor.cOtherSoft)
                            .frame(width: availableWidth * CGFloat(NSDecimalNumber(decimal: slice.share).doubleValue))
                    }
                }
            }
            .frame(height: 12).clipShape(Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("支出の内訳：" + slices.map { "\($0.name) \($0.percentage)" }.joined(separator: "、"))
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: KMSpacing.space1) {
                ForEach(Array(slices.enumerated()), id: \.offset) { _, slice in
                    HStack(spacing: KMSpacing.space2) {
                        Circle().fill(slice.tone?.foreground ?? KMColor.cOtherSoft).frame(width: 10, height: 10)
                        Text(slice.name).lineLimit(1).font(KMTypography.body(14))
                        Spacer(minLength: 0)
                        Text(slice.percentage).font(KMTypography.number(14, weight: .semibold))
                    }.foregroundStyle(KMColor.text)
                }
            }
        }
    }

    private func allCategories(_ summary: KMMonthlySummary) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { categoriesExpanded.toggle() } label: {
                HStack(spacing: KMSpacing.space2) {
                    Image(systemName: "triangle.fill")
                        .font(.system(size: 9))
                        .rotationEffect(.degrees(categoriesExpanded ? 180 : 90))
                    Text("すべてのカテゴリ").font(KMTypography.body(15, weight: .medium))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(KMColor.primary)
                .frame(minHeight: KMLayout.minimumHit, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("home.categories.all")
            .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
            if categoriesExpanded {
                if summary.categories.contains(where: { $0.amountYen < 0 }) {
                    Text("帯グラフは支出が正のカテゴリの構成です。返金・調整は一覧に表示します。")
                        .font(KMTypography.note).foregroundStyle(KMColor.muted)
                }
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(summary.categories.enumerated()), id: \.offset) { index, category in
                        let sign = category.amountYen < 0 ? "−" : ""
                        Text("\(category.categoryName) · \(sign)\(KMAmountFormatter.yen(category.amountYen)) · \(KMHomeCategoryBreakdown.percentage(category.amountYen, total: summary.expenseYen))")
                            .font(KMTypography.body(15)).foregroundStyle(KMColor.text)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, KMSpacing.space3)
                            .overlay(alignment: .bottom) {
                                if index < summary.categories.count - 1 { Rectangle().fill(KMColor.border).frame(height: 1) }
                            }
                    }
                }
            }
        }
    }

    private func recentRecords(_ records: [KMTransaction]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("最近の記録").font(KMTypography.body(18, weight: .bold)).foregroundStyle(KMColor.text)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button { onNavigate(.records) } label: {
                    Text("すべて ›").font(KMTypography.body(15)).foregroundStyle(KMColor.primary)
                        .frame(minWidth: KMLayout.minimumHit, minHeight: KMLayout.minimumHit).contentShape(Rectangle())
                }
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
            guard month == selectedMonth else { return }
            snapshot = data
            accounts = Dictionary(uniqueKeysWithValues: accountRows.map { ($0.id, $0.name) })
            let attention = KMHomeAttention.make(run: run, resolutions: resolutions, suspected: suspected, statements: statements)
            attentionCount = attention.count
            matchedCount = attention.matchedCount
            attentionItems = attention.items
            showsImportHint = attention.showsImportHint
            errorMessage = nil
        } catch {
            guard !Task.isCancelled, month == selectedMonth else { return }
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "ホームを読み込めませんでした。"
        }
    }

}

#if DEBUG
#Preview {
    KMFixturePreview("populated") { HomeView() }
}
#endif
