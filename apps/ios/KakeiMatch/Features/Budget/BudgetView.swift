import SwiftUI

struct KMBudgetView: View {
    @Environment(\.repositories) private var repositories
    @State private var model: KMBudgetModel
    @State private var total = ""
    @State private var breakdown = false
    @State private var allocations: [String: String] = [:]
    private let onBack: () -> Void

    init(initialMonth: KMYearMonth?, onBack: @escaping () -> Void) {
        let currentMonth = KMDate(instant: Date()).yearMonth
        _model = State(initialValue: KMBudgetModel(month: initialMonth ?? currentMonth, mode: initialMonth == nil ? .default : .monthly))
        self.onBack = onBack
    }

    var body: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            Button(action: onBack) {
                HStack(spacing: 4) { Text("‹"); Text("設定") }
                    .font(KMTypography.body(15, weight: .medium)).foregroundStyle(KMColor.primary)
                    .frame(minHeight: KMLayout.minimumHit)
            }
            .buttonStyle(.plain).accessibilityIdentifier("settings.back")

            Text(model.mode == .default ? "毎月の基本予算" : "\(KMBudgetPresentation.monthLabel(model.month))の予算")
                .font(KMTypography.heading).foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader).accessibilityIdentifier("budget-edit-month")

            HStack(spacing: 0) {
                modeButton("毎月の基本予算", mode: .default, id: "budget.mode.default")
                modeButton("\(model.month.month)月だけ変更", mode: .monthly, id: "budget.mode.monthly")
            }
            .padding(3).background(KMColor.sunken, in: RoundedRectangle(cornerRadius: 10))
            .accessibilityIdentifier("budget.mode")

            if model.mode == .monthly {
                HStack {
                    monthButton("予算の前月へ", symbol: "chevron.left", offset: -1)
                    Spacer(); Text(KMBudgetPresentation.monthLabel(model.month)).font(KMTypography.body(16, weight: .bold)).foregroundStyle(KMColor.text)
                    Spacer(); monthButton("予算の翌月へ", symbol: "chevron.right", offset: 1)
                }
                .accessibilityIdentifier("budget.month")
            }

            if model.isLoading { ProgressView().tint(KMColor.primary).frame(maxWidth: .infinity).padding(.vertical, KMSpacing.space4) }
            else if let error = model.error { Text(error).font(KMTypography.note).foregroundStyle(KMColor.danger).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("budget.error") }
            else if let summary = model.summary {
                Text(model.saved ? "予算を保存しました。" : "")
                    .font(KMTypography.note).foregroundStyle(KMColor.primary).accessibilityIdentifier("budget.status")
                VStack(alignment: .leading, spacing: KMSpacing.space2) {
                    HStack(spacing: KMSpacing.space2) {
                        Text(model.mode == .default ? "1か月の全体予算" : "\(KMBudgetPresentation.monthLabel(model.month))の全体予算")
                            .font(KMTypography.body(14, weight: .medium)).foregroundStyle(KMColor.text)
                        Spacer(minLength: 0)
                        yenField("budget-overall-amount", value: $total, label: "全体予算", placeholder: "例：50000")
                            .frame(width: 132)
                    }
                    Button { breakdown.toggle() } label: {
                        HStack(spacing: KMSpacing.space2) {
                            Image(systemName: breakdown ? "checkmark.square.fill" : "square")
                                .font(.system(size: 20)).foregroundStyle(breakdown ? KMColor.primary : KMColor.muted)
                            Text("カテゴリ別にも予算を設定する").font(KMTypography.body(14)).foregroundStyle(KMColor.text)
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: KMLayout.minimumHit, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityIdentifier("budget.breakdown")
                }
                .padding(.vertical, KMSpacing.space2)
                .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
                .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }

                if breakdown {
                    VStack(spacing: 0) {
                        ForEach(Array(summary.categories.enumerated().sorted { left, right in
                            let leftRank = KMCategoryOrdering.rank(left.element.categoryName)
                            let rightRank = KMCategoryOrdering.rank(right.element.categoryName)
                            return leftRank == rightRank ? left.offset < right.offset : leftRank < rightRank
                        }), id: \.element.id) { index, category in
                            HStack(spacing: KMSpacing.space2) {
                                let visual = KMCategoryTone.visual(name: category.categoryName, id: category.categoryId)
                                KMIcon(name: visual.icon, size: 20).foregroundStyle(visual.tone.foreground)
                                    .frame(width: KMLayout.recordIcon, height: KMLayout.recordIcon)
                                    .background(visual.tone.background, in: Circle())
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(category.categoryName).font(KMTypography.body(14, weight: .medium)).foregroundStyle(KMColor.text)
                                    Text("今月 \(KMAmountFormatter.yen(category.spentYen)) 使用").font(KMTypography.note).foregroundStyle(KMColor.muted)
                                }
                                Spacer(minLength: 4)
                                yenField("budget-amount-\(index)", value: allocationBinding(category.categoryId), label: "\(category.categoryName)の予算", placeholder: "0")
                                    .frame(width: 132)
                            }
                            .frame(minHeight: 60).padding(.horizontal, KMSpacing.space3)
                            Rectangle().fill(KMColor.border).frame(height: 1)
                        }
                    }
                    .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
                    .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
                    Text("カテゴリ別の合計：\(categoryTotal)").font(KMTypography.note).foregroundStyle(KMColor.muted).accessibilityIdentifier("budget.category-total")
                }

                Text("カテゴリ別に設定する場合は、カテゴリ別予算の合計と全体予算が一致したときだけ保存できます。")
                    .font(KMTypography.note).foregroundStyle(KMColor.muted).fixedSize(horizontal: false, vertical: true)
                Button { Task { await model.save(total: total, breakdown: breakdown, allocations: allocations, repositories: repositories) } } label: {
                    Text(model.mode == .default ? "基本予算を保存" : "この月の予算を保存")
                        .font(KMTypography.body(16, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity, minHeight: 48).background(KMColor.primary, in: RoundedRectangle(cornerRadius: 10))
                }
                .disabled(model.isSaving).accessibilityIdentifier(model.mode == .default ? "budget.save.default" : "budget.save.monthly")

                if (model.mode == .default && model.defaultPlan?.totalYen != nil) || (model.mode == .monthly && model.settings?.hasExplicitMonthlyPlan(yearMonth: model.month) == true) {
                    Button(model.mode == .default ? "予算を未設定に戻す" : "基本予算に戻す") { Task { await model.reset(repositories: repositories) } }
                        .font(KMTypography.body(14)).foregroundStyle(KMColor.primary).frame(maxWidth: .infinity, minHeight: 44)
                        .accessibilityIdentifier(model.mode == .default ? "budget.reset.default" : "budget.reset.monthly")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain).accessibilityIdentifier("budget.screen")
        .task {
            await model.load(repositories)
            guard let summary = model.summary else { return }
            if model.mode == .default {
                total = model.defaultPlan?.totalYen.map(String.init) ?? ""
                breakdown = model.defaultPlan?.breakdownEnabled ?? false
                allocations = categoryAllocations(summary.categories, amounts: model.defaultPlan?.allocations ?? [:])
            } else {
                total = summary.budgetConfigured ? String(summary.budgetYen) : ""
                breakdown = summary.breakdownEnabled
                allocations = categoryAllocations(summary.categories, amounts: Dictionary(uniqueKeysWithValues: summary.categories.compactMap { category in category.budgetYen.map { (category.categoryId, $0) } }))
            }
        }
        .onChange(of: model.month) { _, _ in
            Task {
                await model.load(repositories)
                guard let summary = model.summary else { return }
                total = summary.budgetConfigured ? String(summary.budgetYen) : ""
                breakdown = summary.breakdownEnabled
                allocations = categoryAllocations(summary.categories, amounts: Dictionary(uniqueKeysWithValues: summary.categories.compactMap { category in category.budgetYen.map { (category.categoryId, $0) } }))
            }
        }
        .onChange(of: model.saved) { _, saved in
            guard saved, let summary = model.summary else { return }
            total = model.mode == .default ? model.defaultPlan?.totalYen.map(String.init) ?? "" : (summary.budgetConfigured ? String(summary.budgetYen) : "")
            breakdown = model.mode == .default ? (model.defaultPlan?.breakdownEnabled ?? false) : summary.breakdownEnabled
            allocations = model.mode == .default
                ? categoryAllocations(summary.categories, amounts: model.defaultPlan?.allocations ?? [:])
                : categoryAllocations(summary.categories, amounts: Dictionary(uniqueKeysWithValues: summary.categories.compactMap { category in category.budgetYen.map { (category.categoryId, $0) } }))
        }
    }

    private func modeButton(_ title: String, mode: KMBudgetModel.Mode, id: String) -> some View {
        Button {
            Task {
                await model.selectMode(mode, repositories: repositories)
                if let summary = model.summary, mode == .default {
                    total = model.defaultPlan?.totalYen.map(String.init) ?? ""
                    breakdown = model.defaultPlan?.breakdownEnabled ?? false
                    allocations = categoryAllocations(summary.categories, amounts: model.defaultPlan?.allocations ?? [:])
                } else if let summary = model.summary {
                    total = summary.budgetConfigured ? String(summary.budgetYen) : ""
                    breakdown = summary.breakdownEnabled
                    allocations = categoryAllocations(summary.categories, amounts: Dictionary(uniqueKeysWithValues: summary.categories.compactMap { category in category.budgetYen.map { (category.categoryId, $0) } }))
                }
            }
        } label: {
            Text(title).font(KMTypography.body(13, weight: model.mode == mode ? .bold : .regular))
                .foregroundStyle(model.mode == mode ? KMColor.text : KMColor.muted).frame(maxWidth: .infinity, minHeight: 40)
                .background(model.mode == mode ? KMColor.surface : .clear, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain).accessibilityIdentifier(id).accessibilityAddTraits(model.mode == mode ? .isSelected : [])
    }

    private func monthButton(_ label: String, symbol: String, offset: Int) -> some View {
        Button { Task { await model.shiftMonth(offset, repositories: repositories) } } label: {
            Image(systemName: symbol).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(KMColor.text)
        .disabled(model.month.shifted(by: offset) == model.month)
        .accessibilityLabel(label).accessibilityIdentifier(offset < 0 ? "budget.month.previous" : "budget.month.next")
    }

    private func yenField(_ id: String, value: Binding<String>, label: String, placeholder: String) -> some View {
        HStack(spacing: 3) {
            Text("¥").foregroundStyle(KMColor.muted)
            TextField(placeholder, text: value).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                .font(KMTypography.number(15)).foregroundStyle(KMColor.text).accessibilityLabel(label).accessibilityIdentifier(id)
        }
        .padding(.horizontal, KMSpacing.space2).frame(minHeight: 44)
        .background(KMColor.bg, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(KMColor.border, lineWidth: 1))
    }

    private func allocationBinding(_ id: String) -> Binding<String> {
        Binding(get: { allocations[id] ?? "" }, set: { allocations[id] = $0 })
    }

    private func categoryAllocations(_ categories: [KMMonthlyBudgetCategory], amounts: [String: Int]) -> [String: String] {
        Dictionary(uniqueKeysWithValues: categories.map { ($0.categoryId, String(amounts[$0.categoryId] ?? 0)) })
    }

    private var categoryTotal: String {
        let values = allocations.values.compactMap(Int.init)
        guard let sum = try? KMBudgetPresentation.checkedSum(values) else { return "—" }
        return KMAmountFormatter.yen(sum)
    }
}
