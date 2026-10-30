import Observation
import SwiftUI

@MainActor @Observable
private final class KMMasterManagementModel {
    private(set) var categories: [KMCategory] = []
    private(set) var accounts: [KMAccount] = []
    private(set) var accountUsageCounts: [String: Int] = [:]
    private(set) var rules: [KMCategoryLearningRule] = []
    var error: String?
    var message: String?
    private var repositories: KMRepositories?

    func load(_ repositories: KMRepositories?) async {
        guard let repositories else { error = "保存先を読み込めませんでした。"; return }
        self.repositories = repositories
        do { try await reload() } catch { self.error = "読み込めませんでした。\(error.localizedDescription)" }
    }

    func reload() async throws {
        guard let repositories else { return }
        categories = try await repositories.categories.categories(includeHidden: true)
        accounts = try await repositories.accounts.accounts(asOf: KMDate(instant: repositories.referenceDate), includeClosed: true)
        let transactions = try await repositories.transactions.transactions(matching: KMTransactionQuery(limit: nil))
        accountUsageCounts = Dictionary(grouping: transactions.flatMap { transaction -> [String] in
            [transaction.accountId, transaction.transferAccountId].compactMap { $0 }
        }, by: { $0 }).mapValues(\.count)
        rules = try await repositories.categoryLearning.categoryRules()
        error = nil
    }

    func saveCategory(_ value: KMCategory) async {
        guard let repositories else { return }
        do { try await repositories.categories.saveCategory(value); try await reload(); message = "カテゴリを保存しました。" }
        catch let caught { error = "カテゴリを保存できませんでした。\(caught.localizedDescription)" }
    }

    func setHidden(_ value: KMCategory) async {
        var updated = value; updated.hidden.toggle(); await saveCategory(updated)
    }

    func deleteCategory(_ value: KMCategory) async {
        guard let repositories else { return }
        do { try await repositories.categories.deleteCategory(id: value.id); try await reload(); message = "カテゴリを削除しました。" }
        catch let caught { error = "カテゴリを削除できませんでした。\(caught.localizedDescription)" }
    }

    func saveAccount(_ value: KMAccount, isNew: Bool) async {
        guard let repositories else { return }
        do {
            if isNew { try await repositories.accounts.createAccount(value, startingBalanceYen: 0, startingDate: KMDate(instant: repositories.referenceDate)) }
            else { try await repositories.accounts.saveAccount(value) }
            try await reload(); message = "支払元を保存しました。"
        } catch let caught { error = "支払元を保存できませんでした。\(caught.localizedDescription)" }
    }

    func deleteAccount(_ value: KMAccount) async {
        guard let repositories else { return }
        do { try await repositories.accounts.deleteAccount(id: value.id); try await reload(); message = "支払元を削除しました。" }
        catch let caught { error = "支払元を削除できませんでした。\(caught.localizedDescription)" }
    }

    func setRule(_ rule: KMCategoryLearningRule, enabled: Bool? = nil, categoryId: String? = nil, deleted: Bool? = nil) async {
        guard let repositories else { return }
        do {
            try await repositories.categoryLearning.setCategoryRuleOverride(.init(
                targetType: rule.targetType, normalizedName: rule.normalizedName,
                disabled: enabled.map { !$0 }, deleted: deleted, categoryId: categoryId))
            try await reload(); message = "分類ルールを保存しました。"
        } catch let caught { error = "分類ルールを保存できませんでした。\(caught.localizedDescription)" }
    }

    func resetRules() async {
        guard let repositories else { return }
        do { try await repositories.categoryLearning.resetCategoryRuleOverrides(); try await reload(); message = "分類ルールへの変更をリセットしました。" }
        catch let caught { error = "分類ルールをリセットできませんでした。\(caught.localizedDescription)" }
    }
}

struct KMMasterManagementView: View {
    enum Page: Equatable { case rules, categories, accounts }
    var initialPage: Page
    var onBack: () -> Void
    @Environment(\.repositories) private var repositories
    @State private var model = KMMasterManagementModel()
    @State private var page: Page
    @State private var categoryKind = false
    @State private var selectedCategory: KMCategory?
    @State private var selectedAccount: KMAccount?
    @State private var editingCategory: KMCategory?
    @State private var editingAccount: KMAccount?
    @State private var isAddingCategory = false
    @State private var isAddingAccount = false
    @State private var confirmingCategoryDelete = false
    @State private var confirmingAccountDelete = false
    @State private var confirmingRulesReset = false
    @State private var ruleToDelete: KMCategoryLearningRule?
    @State private var categoryName = ""
    @State private var categoryIncome = false
    @State private var accountName = ""
    @State private var accountType: KMAccountType = .other
    @State private var statementProvider: KMStatementProvider?
    @State private var ruleCategoryIds: [String: String] = [:]

    init(initialPage: Page, onBack: @escaping () -> Void) {
        self.initialPage = initialPage; self.onBack = onBack
        _page = State(initialValue: initialPage)
    }

    var body: some View { alertScreen }

    private var alertScreen: some View {
        masterScreen
        .task { await model.load(repositories) }
        .safeAreaInset(edge: .bottom, spacing: 0) { pinnedActions }
        .onChange(of: page) { _, _ in model.message = nil }
        .onChange(of: accountType) { _, value in if value == .cash { statementProvider = nil } }
        .alert("カテゴリを削除しますか？", isPresented: $confirmingCategoryDelete) {
            Button("削除する", role: .destructive) { if let selectedCategory { Task { await model.deleteCategory(selectedCategory); self.selectedCategory = nil } } }
            Button("キャンセル", role: .cancel) {}
        } message: { Text("「\(selectedCategory?.name ?? "")」を削除します。") }
        .alert("支払元を完全に削除しますか？", isPresented: $confirmingAccountDelete) {
            Button("削除する", role: .destructive) { if let selectedAccount { Task { await model.deleteAccount(selectedAccount); self.selectedAccount = nil } } }
            Button("キャンセル", role: .cancel) {}
        } message: { Text("「\(selectedAccount?.name ?? "")」を削除します。この操作は取り消せません。") }
        .alert("分類ルールをリセットしますか？", isPresented: $confirmingRulesReset) {
            Button("リセットする", role: .destructive) { Task { await model.resetRules() } }
            Button("キャンセル", role: .cancel) {}
        } message: { Text("分類ルールへの変更をすべてリセットします。学習履歴は残り、ルールは履歴から再計算されます。") }
        .alert("分類ルールを削除しますか？", isPresented: Binding(
            get: { ruleToDelete != nil }, set: { if !$0 { ruleToDelete = nil } }
        )) {
            Button("削除する", role: .destructive) {
                if let rule = ruleToDelete { Task { await model.setRule(rule, deleted: true, enabled: false) } }
                ruleToDelete = nil
            }
            Button("キャンセル", role: .cancel) { ruleToDelete = nil }
        } message: { Text("学習履歴は残り、このルールは自動で適用されなくなります。") }
    }

    private var masterScreen: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: KMSpacing.space3) {
                Button(action: back) {
                    Label(backTitle, systemImage: "chevron.left")
                        .font(KMTypography.body(15, weight: .semibold))
                        .frame(minHeight: 44, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("masters.back")

                Text(title).font(KMTypography.heading).foregroundStyle(KMColor.text)
                    .accessibilityAddTraits(.isHeader).accessibilityIdentifier("masters.title")

                if let error = model.error { status(error, color: KMColor.danger, id: "masters.error") }
                if let message = model.message { status(message, color: KMColor.success, id: "masters.status") }

                switch page {
                case .rules: rulesPage
                case .categories: categoriesPage
                case .accounts: accountsPage
                }
            }
            .padding(.horizontal, KMSpacing.space4)
            .padding(.top, KMSpacing.space2)
            .padding(.bottom, KMSpacing.space8)
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    private var title: String {
        if let editingCategory { return editingCategory.isIncome ? "収入カテゴリを編集" : "支出カテゴリを編集" }
        if isAddingCategory { return categoryIncome ? "収入カテゴリを追加" : "支出カテゴリを追加" }
        if editingAccount != nil { return "支払元を編集" }
        if isAddingAccount { return "支払元を追加" }
        if selectedCategory != nil { return selectedCategory!.isIncome ? "収入カテゴリの詳細" : "支出カテゴリの詳細" }
        if selectedAccount != nil { return "支払元の詳細" }
        switch page { case .rules: "分類ルール"; case .categories: "カテゴリ"; case .accounts: "支払元・口座" }
    }

    private var backTitle: String {
        if editingCategory != nil || isAddingCategory { return "カテゴリ" }
        if editingAccount != nil || isAddingAccount { return "支払元・口座" }
        if selectedCategory != nil { return "カテゴリ" }
        if selectedAccount != nil { return "支払元・口座" }
        return "設定"
    }

    private func back() {
        model.message = nil
        if editingCategory != nil || isAddingCategory { editingCategory = nil; isAddingCategory = false; return }
        if editingAccount != nil || isAddingAccount { editingAccount = nil; isAddingAccount = false; return }
        if selectedCategory != nil { selectedCategory = nil; return }
        if selectedAccount != nil { selectedAccount = nil; return }
        onBack()
    }

    private var categoriesPage: some View {
        Group {
            if let category = editingCategory { categoryForm(category) }
            else if isAddingCategory { categoryForm(nil) }
            else if let category = selectedCategory { categoryDetail(category) }
            else { categoryList }
        }
    }

    private var categoryList: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            HStack(spacing: KMSpacing.space2) {
                kindButton("支出", income: false).accessibilityIdentifier("masters.expenseCategories")
                kindButton("収入", income: true).accessibilityIdentifier("masters.incomeCategories")
            }
            .padding(4).background(KMColor.sunken, in: RoundedRectangle(cornerRadius: KMRadius.md))
            ForEach(model.categories.filter { $0.isIncome == categoryKind }) { category in
                Button { selectedCategory = category } label: {
                    HStack(spacing: KMSpacing.space3) {
                        let visual = KMCategoryTone.visual(name: category.name, id: category.id)
                        Circle().fill(visual.tone.background).frame(width: 36, height: 36)
                            .overlay(KMIcon(name: visual.icon, size: 20).foregroundStyle(visual.tone.foreground))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(category.name).font(KMTypography.text).foregroundStyle(KMColor.text)
                            Text("記録 \(category.usageCount)件 · \(category.hidden ? "非表示" : category.groupName)")
                                .font(KMTypography.note).foregroundStyle(KMColor.muted)
                        }
                        Spacer()
                        Text("›").foregroundStyle(KMColor.muted)
                    }
                    .frame(minHeight: 56)
                    .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("masters.category.row.\(category.id)")
            }
            if model.categories.filter({ $0.isIncome == categoryKind }).isEmpty { Text("カテゴリがありません。").font(KMTypography.note).foregroundStyle(KMColor.muted) }
            Text("記録が多い順に並びます。入力画面のボタンも同じ順です。")
                .font(KMTypography.note).foregroundStyle(KMColor.muted).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func categoryDetail(_ category: KMCategory) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            Text(category.name).font(KMTypography.body(20, weight: .bold)).foregroundStyle(KMColor.text)
            detailRow("種類", category.isIncome ? "収入" : "支出")
            detailRow("グループ", category.groupName)
            detailRow("状態", category.hidden ? "非表示" : "表示中")
            detailRow("使われている記録", "\(category.usageCount)件")
            secondaryButton(category.hidden ? "カテゴリを表示する" : "カテゴリを非表示にする", id: "masters.category.visibility") {
                Task { await model.setHidden(category); try? await model.reload(); selectedCategory = model.categories.first { $0.id == category.id } }
            }
            if category.usageCount > 0 {
                Text("このカテゴリには記録があります。履歴を残すため削除できません。")
                    .font(KMTypography.note).foregroundStyle(KMColor.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func categoryForm(_ current: KMCategory?) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            labeledField("カテゴリ名", text: $categoryName, id: "masters.category.name")
        }
    }

    private var accountsPage: some View {
        Group {
            if let account = editingAccount { accountForm(account) }
            else if isAddingAccount { accountForm(nil) }
            else if let account = selectedAccount { accountDetail(account) }
            else { accountList }
        }
    }

    private var accountList: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            let open = model.accounts.filter { !$0.closed }
            let total = open.reduce(0) { $0 + $1.balanceYen }
            VStack(alignment: .leading, spacing: 4) {
                Text("利用中の口座の合計").font(KMTypography.note).foregroundStyle(KMColor.muted)
                Text("\(total < 0 ? "−" : "")¥\(abs(total).formatted())").font(KMTypography.body(18, weight: .bold)).foregroundStyle(KMColor.text)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, KMSpacing.space3)
            ForEach(KMAccountType.allCases, id: \.self) { type in
                let rows = open.filter { $0.accountType == type }
                if !rows.isEmpty {
                    Text(type.label).font(KMTypography.body(13, weight: .bold)).foregroundStyle(KMColor.muted).padding(.top, KMSpacing.space2)
                    ForEach(rows) { accountRow($0) }
                    if type == .creditCard { Text("差引額は登録した利用と支払いの差です。確定した請求額ではありません。").font(KMTypography.note).foregroundStyle(KMColor.muted) }
                }
            }
            if open.isEmpty { Text("利用中の支払元がありません。").font(KMTypography.note).foregroundStyle(KMColor.muted) }
            let closed = model.accounts.filter(\.closed)
            if !closed.isEmpty {
                DisclosureGroup("利用終了の口座 \(closed.count)件") {
                    ForEach(closed) { accountRow($0) }
                }
                .font(KMTypography.body(14, weight: .semibold)).foregroundStyle(KMColor.muted)
                .padding(.vertical, KMSpacing.space2)
            }
        }
    }

    private func accountRow(_ account: KMAccount) -> some View {
        Button { selectedAccount = account } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.name).font(KMTypography.text).foregroundStyle(KMColor.text)
                    Text([account.statementProvider?.label ?? account.accountType.label, account.closed ? "利用終了" : ""].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(KMTypography.note).foregroundStyle(KMColor.muted)
                }
                Spacer()
                Text("\(account.balanceYen < 0 ? "−" : "")¥\(abs(account.balanceYen).formatted())")
                    .font(KMTypography.body(14, weight: .medium)).foregroundStyle(KMColor.text).monospacedDigit()
            }
            .frame(minHeight: 56).overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
        }
        .buttonStyle(.plain).accessibilityIdentifier("masters.account.row.\(account.id)")
    }

    private func accountDetail(_ account: KMAccount) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            Text(account.name).font(KMTypography.body(20, weight: .bold)).foregroundStyle(KMColor.text)
            detailRow(account.accountType == .creditCard ? "差引額" : "残高", "\(account.balanceYen < 0 ? "−" : "")¥\(abs(account.balanceYen).formatted())")
            detailRow("種類", account.accountType.label)
            detailRow("明細サービス", account.statementProvider?.label ?? "未設定")
            detailRow("状態", account.closed ? "利用終了" : "利用中")
            detailRow("記録", "\(model.accountUsageCounts[account.id, default: 0])件")
            secondaryButton(account.closed ? "利用を再開する" : "利用終了", id: "masters.account.close") {
                var value = account; value.closed.toggle(); Task { await model.saveAccount(value, isNew: false); try? await model.reload(); selectedAccount = model.accounts.first { $0.id == account.id } }
            }
            if account.balanceYen == 0 && model.accountUsageCounts[account.id, default: 0] == 0 {
                secondaryButton("完全に削除する", id: "masters.account.delete", role: .destructive) { confirmingAccountDelete = true }
            } else {
                Text("記録または残高がある支払元は完全には削除できません。利用終了にすると、今後の支払元として選ばれなくなります。")
                    .font(KMTypography.note).foregroundStyle(KMColor.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func accountForm(_ current: KMAccount?) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            labeledField("支払元の名前", text: $accountName, id: "masters.account.name")
            Text("種類").font(KMTypography.note).foregroundStyle(KMColor.muted)
            Picker("種類", selection: $accountType) { ForEach(KMAccountType.allCases, id: \.self) { Text($0.label).tag($0) } }
                .pickerStyle(.menu).accessibilityIdentifier("masters.account.type")
            if accountType != .cash {
                Text("明細サービス").font(KMTypography.note).foregroundStyle(KMColor.muted)
                Picker("明細サービス", selection: $statementProvider) {
                    Text("設定しない").tag(KMStatementProvider?.none)
                    if statementProvider == .paypay { Text("PayPay取引履歴（旧形式・再取込不可）").tag(Optional(KMStatementProvider.paypay)).disabled(true) }
                    if statementProvider == .aeonCard { Text(KMStatementProvider.aeonCard.label).tag(Optional(KMStatementProvider.aeonCard)).disabled(true) }
                    ForEach([KMStatementProvider.smbcCard, .rakutenCard, .paypayCard], id: \.self) { Text($0.label).tag(Optional($0)) }
                }
                .pickerStyle(.menu).accessibilityIdentifier("masters.account.provider")
            }
        }
    }

    private var rulesPage: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            Text("過去のレシートで確定した分類から、いつもの分類を自動で適用します。")
                .font(KMTypography.note).foregroundStyle(KMColor.muted).fixedSize(horizontal: false, vertical: true)
            if model.rules.isEmpty {
                Text("分類ルールはまだありません。レシートを登録すると、履歴から自動で学習します。")
                    .font(KMTypography.note).foregroundStyle(KMColor.muted).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(model.rules) { rule in ruleRow(rule) }
            if !model.rules.isEmpty {
                secondaryButton("すべての変更をリセット", id: "masters.rules.reset", role: .normal) {
                    confirmingRulesReset = true
                }
            }
        }
    }

    private func ruleRow(_ rule: KMCategoryLearningRule) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text("\(rule.normalizedName) → \(model.categories.first { $0.id == rule.categoryId }?.name ?? "利用できないカテゴリ")")
                .font(KMTypography.text).foregroundStyle(KMColor.text)
            Text(rule.targetType == .item ? "品目" : "店舗").font(KMTypography.note).foregroundStyle(KMColor.muted)
            Text("根拠: \(rule.matchingReceipts)件 / \(rule.receipts)件 · 一致率 \(rule.agreementPercent)%")
                .font(KMTypography.note).foregroundStyle(KMColor.muted)
            Toggle(rule.deleted ? "削除済み" : rule.enabled ? "有効" : "無効", isOn: Binding(
                get: { rule.enabled && !rule.deleted }, set: { value in Task { await model.setRule(rule, enabled: value, deleted: false) } }
            )).accessibilityIdentifier("masters.rule.enabled.\(rule.id)")
            Picker("適用カテゴリ", selection: Binding(
                get: { ruleCategoryIds[rule.id] ?? rule.categoryId }, set: { ruleCategoryIds[rule.id] = $0 }
            )) {
                ForEach(model.categories.filter { !$0.isIncome }) { Text($0.name).tag($0.id) }
            }.pickerStyle(.menu).accessibilityIdentifier("masters.rule.category.\(rule.id)")
            secondaryButton("カテゴリを変更", id: "masters.rule.save.\(rule.id)") {
                Task { await model.setRule(rule, enabled: true, categoryId: ruleCategoryIds[rule.id] ?? rule.categoryId, deleted: false) }
            }
            if rule.deleted {
                secondaryButton("削除を取り消す", id: "masters.rule.undo.\(rule.id)") {
                    Task { guard let repositories else { return }; try? await repositories.categoryLearning.resetCategoryRuleOverride(targetType: rule.targetType, normalizedName: rule.normalizedName); try? await model.reload() }
                }
            } else {
                secondaryButton("削除する", id: "masters.rule.delete.\(rule.id)", role: .destructive) {
                    ruleToDelete = rule
                }
            }
            Rectangle().fill(KMColor.border).frame(height: 1)
        }
        .padding(.vertical, KMSpacing.space2)
    }

    private func kindButton(_ label: String, income: Bool) -> some View {
        Button { categoryKind = income } label: {
            Text(label).font(KMTypography.body(14, weight: categoryKind == income ? .bold : .regular))
                .foregroundStyle(categoryKind == income ? KMColor.primary : KMColor.muted)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(categoryKind == income ? KMColor.surface : .clear, in: RoundedRectangle(cornerRadius: KMRadius.sm))
        }.buttonStyle(.plain).accessibilityAddTraits(categoryKind == income ? .isSelected : [])
    }

    private func detailRow(_ title: String, _ value: String) -> some View {
        HStack { Text(title).font(KMTypography.note).foregroundStyle(KMColor.muted); Spacer(); Text(value).font(KMTypography.text).foregroundStyle(KMColor.text) }
            .frame(minHeight: 40).overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    @ViewBuilder
    private var pinnedActions: some View {
        let category = selectedCategory
        let account = selectedAccount
        let categoryFormValue = editingCategory
        let accountFormValue = editingAccount
        if page == .categories && (editingCategory != nil || isAddingCategory) {
            pinnedBar(editingCategory == nil ? "追加する" : "変更を保存", id: "masters.category.save") {
                let current = categoryFormValue
                let value = KMCategory(id: current?.id ?? UUID().uuidString,
                    name: categoryName.trimmingCharacters(in: .whitespacesAndNewlines),
                    isIncome: current?.isIncome ?? categoryIncome, hidden: current?.hidden ?? false,
                    groupName: current?.groupName ?? (categoryIncome ? "収入" : "支出"), groupId: current?.groupId, tone: current?.tone)
                Task {
                    await model.saveCategory(value)
                    if model.error == nil { editingCategory = nil; isAddingCategory = false; selectedCategory = model.categories.first { $0.id == value.id } }
                }
            }
        } else if page == .categories, let category {
            VStack(spacing: KMSpacing.space2) {
                pinnedBar("編集する", id: "masters.category.edit") { categoryName = category.name; editingCategory = category }
                if category.usageCount == 0 {
                    secondaryButton("カテゴリを削除する", id: "masters.category.delete.pinned", role: .destructive) { confirmingCategoryDelete = true }
                }
            }.padding(.horizontal, KMSpacing.space4).padding(.vertical, KMSpacing.space2).background(KMColor.surface)
                .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
        } else if page == .categories {
            pinnedBar("カテゴリを追加", id: "masters.category.add") { categoryName = ""; categoryIncome = categoryKind; isAddingCategory = true }
        } else if page == .accounts && (editingAccount != nil || isAddingAccount) {
            let current = accountFormValue
            pinnedBar(editingAccount == nil ? "追加する" : "変更を保存", id: "masters.account.save") {
                let value = KMAccount(id: current?.id ?? UUID().uuidString,
                    name: accountName.trimmingCharacters(in: .whitespacesAndNewlines), closed: current?.closed ?? false,
                    accountType: accountType, balanceYen: current?.balanceYen ?? 0,
                    statementProvider: accountType == .cash ? nil : statementProvider, offbudget: current?.offbudget)
                Task {
                    await model.saveAccount(value, isNew: current == nil)
                    if model.error == nil { editingAccount = nil; isAddingAccount = false; selectedAccount = model.accounts.first { $0.id == value.id } }
                }
            }
        } else if page == .accounts, let account {
            pinnedBar("編集する", id: "masters.account.edit") { accountName = account.name; accountType = account.accountType; statementProvider = account.statementProvider; editingAccount = account }
        } else if page == .accounts {
            pinnedBar("支払元を追加する", id: "masters.account.add") { accountName = ""; accountType = .other; statementProvider = nil; isAddingAccount = true }
        }
    }

    private func pinnedBar(
        _ title: String,
        id: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) { Text(title).font(KMTypography.text).frame(maxWidth: .infinity, minHeight: 52) }
            .buttonStyle(KMButtonStyle(role: .primary)).accessibilityIdentifier(id)
            .padding(.horizontal, KMSpacing.space4).padding(.vertical, KMSpacing.space2)
            .background(KMColor.surface).overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private func labeledField(_ label: String, text: Binding<String>, id: String) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space1) {
            Text(label).font(KMTypography.note).foregroundStyle(KMColor.muted)
            TextField(label, text: text).textFieldStyle(.plain).font(KMTypography.text).padding(KMSpacing.space3)
                .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.md))
                .overlay(RoundedRectangle(cornerRadius: KMRadius.md).stroke(KMColor.borderStrong, lineWidth: 1))
                .accessibilityIdentifier(id)
        }
    }

    private func status(_ text: String, color: Color, id: String) -> some View {
        Text(text).font(KMTypography.note).foregroundStyle(color).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier(id)
    }

    private func primaryButton(_ title: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title).font(KMTypography.text).frame(maxWidth: .infinity, minHeight: 48) }
            .buttonStyle(KMButtonStyle(role: .primary)).accessibilityIdentifier(id)
    }

    private func secondaryButton(_ title: String, id: String, role: Role = .normal, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title).font(KMTypography.text).frame(maxWidth: .infinity, minHeight: 48) }
            .buttonStyle(KMButtonStyle(role: role == .destructive ? .destructive : .secondary))
            .foregroundStyle(role == .destructive ? KMColor.danger : KMColor.text).accessibilityIdentifier(id)
    }

    private enum Role { case normal, destructive }
}

private extension KMAccountType {
    var label: String {
        switch self { case .bank: "銀行口座"; case .creditCard: "クレジットカード"; case .cash: "現金"; case .other: "その他 / 未分類" }
    }
}

private extension KMStatementProvider {
    var label: String {
        switch self { case .smbcCard: "三井住友カード"; case .rakutenCard: "楽天カード"; case .aeonCard: "イオンカード"; case .paypay: "PayPay取引履歴（旧形式）"; case .paypayCard: "PayPayカード" }
    }
}
