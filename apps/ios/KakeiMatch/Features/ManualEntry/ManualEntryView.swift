import SwiftUI

private enum KMEntrySheet: String, Identifiable {
    case category, sourceAccount, destinationAccount, addCategory, addAccount
    var id: String { rawValue }

    var title: String {
        switch self {
        case .category: "カテゴリを選ぶ"
        case .sourceAccount: "支払元を選ぶ"
        case .destinationAccount: "振替先口座を選ぶ"
        case .addCategory: "カテゴリを追加"
        case .addAccount: "支払元・口座を追加"
        }
    }
}

/// Shared PWA-shaped manual entry form for expenses, income, and transfers.
struct KMEntryFormView: View {
    @Environment(\.repositories) private var repositories
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model: KMEntryFormModel
    @State private var sheet: KMEntrySheet?
    @FocusState private var focusedField: String?

    init(kind: KMEntryKind) {
        _model = State(initialValue: KMEntryFormModel(kind: kind))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: KMSpacing.space3) {
                    Text(model.kind.title)
                        .font(KMTypography.body(22, weight: .bold))
                        .foregroundStyle(KMColor.text)
                        .accessibilityAddTraits(.isHeader)

                    if model.loading {
                        ProgressView("カテゴリと口座を読み込んでいます。")
                            .tint(KMColor.primary)
                            .padding(.vertical, KMSpacing.space6)
                    } else {
                        formRows
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, KMSpacing.space4)
                .padding(.bottom, KMSpacing.space3)
                .scrollTargetLayout()
            }
            .scrollBounceBehavior(.basedOnSize)

            if !model.loading {
                VStack(alignment: .leading, spacing: KMSpacing.space2) {
                    if let error = model.error {
                        Text("! \(error)")
                            .font(KMTypography.note)
                            .foregroundStyle(KMColor.danger)
                            .accessibilityIdentifier("entry.error")
                    }
                    if let status = model.status {
                        Text(status)
                            .font(KMTypography.note)
                            .foregroundStyle(KMColor.muted)
                            .accessibilityIdentifier("entry.status")
                    }
                    Button {
                        focusedField = nil
                        Task { await model.save() }
                    } label: {
                        Text(model.didSave ? "登録しました" : model.busy ? "登録しています…" : "登録する")
                            .font(KMTypography.body(17, weight: .bold))
                            .frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .buttonStyle(KMButtonStyle(role: .primary))
                    .accessibilityIdentifier("entry.saveButton")
                    .disabled(model.busy || model.didSave)
                }
                .padding(.horizontal, KMSpacing.space4)
                .padding(.vertical, KMSpacing.space3)
                .frame(maxWidth: KMLayout.contentMax)
                .frame(maxWidth: .infinity)
                .background(KMColor.bg)
                .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(screenIdentifier)
        .task { if model.loading { await model.load(repositories) } }
        .fullScreenCover(item: $sheet) { current in
            KMBottomSheet(title: current.title, isPresented: sheetBinding) {
                sheetContent(current)
            }
            .presentationBackground(.clear)
            .transaction { if reduceMotion { $0.disablesAnimations = true } }
        }
    }

    private var screenIdentifier: String {
        switch model.kind {
        case .expense: "manualEntry.screen"
        case .income: "income.screen"
        case .transfer: "transfer.screen"
        }
    }

    private var sheetBinding: Binding<Bool> {
        Binding(get: { sheet != nil }, set: { if !$0 { sheet = nil } })
    }

    private var formRows: some View {
        VStack(spacing: 0) {
            ruledRow("金額", height: 64) {
                HStack(spacing: KMSpacing.space1) {
                    Text("¥").font(KMTypography.number(16, weight: .medium)).foregroundStyle(KMColor.muted)
                    TextField("", text: $model.amount)
                        .textFieldStyle(.plain)
                        .font(KMTypography.number(30, weight: .bold))
                        .keyboardType(.numberPad)
                        .focused($focusedField, equals: "manual-transaction-amount")
                        .accessibilityLabel("金額（円）")
                        .accessibilityIdentifier("manual-transaction-amount")
                }
            }

            if model.kind != .transfer {
                ruledRow(model.kind.payeeLabel, height: 52) {
                    TextField("", text: $model.payee)
                        .textFieldStyle(.plain)
                        .font(KMTypography.body(16, weight: .medium))
                        .textInputAutocapitalization(.never)
                        .focused($focusedField, equals: "manual-transaction-payee")
                        .accessibilityLabel(model.kind == .income ? "入金元・内容" : "店名・支払先")
                        .accessibilityIdentifier("manual-transaction-payee")
                }
            }

            dateRow

            if model.kind != .transfer {
                categoryRow
            }

            accountRow
            if model.kind == .transfer { destinationAccountRow }
            optionalRow

            if model.kind == .expense {
                Button {
                    model.excludedFromSpending.toggle()
                } label: {
                    HStack(spacing: KMSpacing.space3) {
                        Image(systemName: model.excludedFromSpending ? "checkmark.square.fill" : "square")
                            .font(.system(size: 22, weight: .regular))
                            .foregroundStyle(model.excludedFromSpending ? KMColor.primary : KMColor.muted)
                        Text("支出の計算に含めない")
                            .font(KMTypography.body(16))
                            .foregroundStyle(KMColor.text)
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: KMLayout.entryHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("支出の計算に含めない")
                .accessibilityValue(model.excludedFromSpending ? "選択中" : "未選択")
                .accessibilityIdentifier("manual-transaction-excluded")
                .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
            }

            if model.kind != .transfer {
                recurrenceRow
            }
        }
        .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private func ruledRow<Content: View>(_ label: String, height: CGFloat = KMLayout.entryHeight,
                                         @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: KMSpacing.space3) {
            Text(label)
                .font(KMTypography.body(13, weight: .medium))
                .foregroundStyle(KMColor.muted)
                .frame(width: KMLayout.entryKeyWidth, alignment: .leading)
            content().frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: height)
        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private var dateRow: some View {
        ruledRow("日付") {
            HStack(spacing: KMSpacing.space1) {
                DatePicker("日付", selection: dateBinding, displayedComponents: .date)
                    .datePickerStyle(.compact)
                    .labelsHidden()
                    .environment(\.calendar, KMDate.calendar)
                    .environment(\.timeZone, KMDate.calendar.timeZone)
                    .environment(\.locale, Locale(identifier: "ja_JP"))
                    .accessibilityIdentifier("manual-transaction-date")
                Spacer(minLength: 0)
                shortcut("今日", value: model.today, identifier: "entry.date.today")
                if let yesterday = KMEntryPresentation.shiftedDate(model.today, by: -1) {
                    shortcut("昨日", value: yesterday, identifier: "entry.date.yesterday")
                }
            }
        }
    }

    private var dateBinding: Binding<Date> {
        Binding(get: {
            (try? KMDate(model.date)).map(KMEntryPresentation.dateValue) ?? KMEntryPresentation.dateValue(model.today)
        }, set: { model.date = KMDate(instant: $0).rawValue })
    }

    private func shortcut(_ title: String, value: KMDate, identifier: String) -> some View {
        let selected = model.date == value.rawValue
        return Button {
            model.date = value.rawValue
        } label: {
            Text(title)
                .font(KMTypography.body(13, weight: selected ? .bold : .medium))
                .foregroundStyle(selected ? KMColor.primary : KMColor.text)
                .padding(.horizontal, KMSpacing.space3)
                .frame(minHeight: 36)
                .background(selected ? KMColor.primarySoft : KMColor.surface, in: Capsule())
                .overlay(Capsule().stroke(selected ? KMColor.primary : KMColor.borderStrong, lineWidth: selected ? 2 : 1))
                .frame(minHeight: KMLayout.minimumHit)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title == "今日" ? "今日 \(value.yearMonth.month)/\(value.rawValue.suffix(2))" : "昨日")
        .accessibilityValue(selected ? "選択中" : "")
        .accessibilityIdentifier(identifier)
    }

    private var categoryRow: some View {
        ruledRow("カテゴリ") {
            HStack(spacing: KMSpacing.space2) {
                Text(model.selectedCategory?.name ?? "未選択")
                    .font(KMTypography.body(16, weight: .medium))
                    .foregroundStyle(model.selectedCategory == nil ? KMColor.muted : KMColor.text)
                    .lineLimit(1)
                if model.categoryId == model.lastUsedCategoryId, model.lastUsedCategoryId != nil {
                    Text("前回と同じ")
                        .font(KMTypography.note)
                        .foregroundStyle(KMColor.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Button {
                    focusedField = nil
                    model.sheetError = nil
                    sheet = .category
                } label: {
                    Text("すべて ›")
                        .font(KMTypography.body(14, weight: .bold))
                        .foregroundStyle(KMColor.primary)
                        .frame(minWidth: KMLayout.minimumHit, minHeight: KMLayout.minimumHit)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("すべてのカテゴリから選ぶ")
                .accessibilityIdentifier("entry.categorySheet")
            }
        }
    }

    private var accountRow: some View {
        let label = model.kind == .expense ? "支払元" : model.kind == .income ? "入金先" : "振替元口座"
        return ruledRow(label) {
            HStack(spacing: KMSpacing.space1) {
                Button {
                    focusedField = nil
                    model.accountFieldForCreation = .source
                    model.sheetError = nil
                    sheet = .sourceAccount
                } label: {
                    HStack(spacing: KMSpacing.space2) {
                        Text(model.selectedAccount?.name ?? "選択してください")
                            .font(KMTypography.body(16, weight: .medium))
                            .foregroundStyle(model.selectedAccount == nil ? KMColor.muted : KMColor.text)
                            .lineLimit(1)
                        KMIcon(name: "chevronDown", size: 16).foregroundStyle(KMColor.muted)
                    }
                    .frame(minHeight: KMLayout.minimumHit, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(label)
                .accessibilityValue(model.selectedAccount?.name ?? "選択してください")
                .accessibilityIdentifier("manual-transaction-account")
                Spacer(minLength: 0)
                Button("＋ 追加") {
                    focusedField = nil
                    model.accountFieldForCreation = .source
                    model.sheetError = nil
                    sheet = .addAccount
                }
                .font(KMTypography.body(14, weight: .bold))
                .foregroundStyle(KMColor.primary)
                .frame(minHeight: KMLayout.minimumHit)
                .buttonStyle(.plain)
                .accessibilityIdentifier("entry.addAccount")
            }
        }
    }

    private var destinationAccountRow: some View {
        ruledRow("振替先口座") {
            HStack(spacing: KMSpacing.space1) {
                Button {
                    focusedField = nil
                    model.accountFieldForCreation = .destination
                    model.sheetError = nil
                    sheet = .destinationAccount
                } label: {
                    HStack(spacing: KMSpacing.space2) {
                        Text(model.selectedDestinationAccount?.name ?? "選択してください")
                            .font(KMTypography.body(16, weight: .medium))
                            .foregroundStyle(model.selectedDestinationAccount == nil ? KMColor.muted : KMColor.text)
                            .lineLimit(1)
                        KMIcon(name: "chevronDown", size: 16).foregroundStyle(KMColor.muted)
                    }
                    .frame(minHeight: KMLayout.minimumHit, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("振替先口座")
                .accessibilityValue(model.selectedDestinationAccount?.name ?? "選択してください")
                .accessibilityIdentifier("manual-transaction-destination")
                Spacer(minLength: 0)
                Button("入替") {
                    let source = model.accountId
                    model.accountId = model.destinationAccountId
                    model.destinationAccountId = source
                }
                .font(KMTypography.body(13, weight: .bold))
                .foregroundStyle(KMColor.primary)
                .frame(minWidth: KMLayout.minimumHit, minHeight: KMLayout.minimumHit)
                .buttonStyle(.plain)
                .accessibilityIdentifier("entry.swapAccounts")
                Button("＋ 追加") {
                    focusedField = nil
                    model.accountFieldForCreation = .destination
                    model.sheetError = nil
                    sheet = .addAccount
                }
                .font(KMTypography.body(14, weight: .bold))
                .foregroundStyle(KMColor.primary)
                .frame(minHeight: KMLayout.minimumHit)
                .buttonStyle(.plain)
                .accessibilityIdentifier("entry.addDestinationAccount")
            }
        }
    }

    private var optionalRow: some View {
        VStack(spacing: 0) {
            Button {
                focusedField = nil
                model.isMemoExpanded.toggle()
            } label: {
                HStack(spacing: KMSpacing.space3) {
                    Text(model.kind == .expense ? "時刻・メモ" : "メモ")
                        .font(KMTypography.body(13, weight: .medium))
                        .foregroundStyle(KMColor.muted)
                        .frame(width: KMLayout.entryKeyWidth, alignment: .leading)
                    Text(optionalSummary)
                        .font(KMTypography.body(16))
                        .foregroundStyle(optionalSummary == "任意" ? KMColor.muted : KMColor.text)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    KMIcon(name: "chevronRight", size: 16)
                        .foregroundStyle(KMColor.muted)
                        .rotationEffect(.degrees(model.isMemoExpanded ? 90 : 0))
                }
                .frame(minHeight: KMLayout.entryHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("entry.optionalFields")
            if model.isMemoExpanded {
                if model.kind == .expense {
                    ruledRow("時刻", height: KMLayout.entryHeight) {
                        HStack {
                            DatePicker("時刻", selection: timeBinding, displayedComponents: .hourAndMinute)
                                .datePickerStyle(.compact)
                                .labelsHidden()
                                .environment(\.calendar, KMDate.calendar)
                                .environment(\.timeZone, KMDate.calendar.timeZone)
                                .environment(\.locale, Locale(identifier: "ja_JP"))
                                .accessibilityIdentifier("receipt-time")
                            Spacer(minLength: 0)
                            if model.time != nil {
                                Button("消去") { model.time = nil }
                                    .font(KMTypography.note)
                                    .foregroundStyle(KMColor.primary)
                                    .frame(minHeight: KMLayout.minimumHit)
                                    .buttonStyle(.plain)
                            }
                        }
                    }
                }
                ruledRow("メモ", height: 56) {
                    TextField("任意", text: $model.memo, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(KMTypography.body(16))
                        .lineLimit(1...3)
                        .focused($focusedField, equals: "manual-transaction-memo")
                        .accessibilityLabel("メモ")
                        .accessibilityIdentifier("manual-transaction-memo")
                }
            }
        }
        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private var optionalSummary: String {
        let values = [model.time, model.memo.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : model.memo]
            .compactMap { $0 }
        return values.isEmpty ? "任意" : values.joined(separator: "・")
    }

    private var timeBinding: Binding<Date> {
        Binding(get: {
            KMEntryPresentation.timeValue(model.time, on: (try? KMDate(model.date)) ?? model.today)
        }, set: { model.time = KMEntryPresentation.timeString(from: $0) })
    }

    private var recurrenceRow: some View {
        ruledRow("くり返し") {
            Menu {
                ForEach(KMEntryFrequency.allCases, id: \.rawValue) { frequency in
                    Button(frequency.label) { model.frequency = frequency }
                        .accessibilityIdentifier("entry.recurrence.\(frequency.rawValue.isEmpty ? "none" : frequency.rawValue)")
                }
            } label: {
                HStack(spacing: KMSpacing.space2) {
                    Text(model.frequency.label)
                        .font(KMTypography.body(16, weight: .medium))
                        .foregroundStyle(KMColor.text)
                    if model.frequency != .none {
                        Text("定期登録も作ります")
                            .font(KMTypography.note)
                            .foregroundStyle(KMColor.muted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    KMIcon(name: "chevronDown", size: 16).foregroundStyle(KMColor.text)
                }
                .frame(minHeight: KMLayout.minimumHit)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("くり返し")
            .accessibilityValue(model.frequency.label)
            .accessibilityIdentifier("manual-transaction-recurrence")
        }
    }

    @ViewBuilder private func sheetContent(_ current: KMEntrySheet) -> some View {
        switch current {
        case .category:
            categorySheet
        case .sourceAccount:
            accountSheet(for: .source)
        case .destinationAccount:
            accountSheet(for: .destination)
        case .addCategory:
            addCategorySheet
        case .addAccount:
            addAccountSheet
        }
    }

    private var categorySheet: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            if model.eligibleCategories.isEmpty {
                Text("カテゴリがありません。追加してください。")
                    .font(KMTypography.body(14))
                    .foregroundStyle(KMColor.muted)
                    .padding(.vertical, KMSpacing.space3)
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: KMSpacing.space2), count: 4), spacing: KMSpacing.space2) {
                    ForEach(model.eligibleCategories) { category in
                        categoryChoice(category)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("entry.categoryPicker")
            }
            Button {
                model.sheetError = nil
                model.newCategoryName = ""
                sheet = .addCategory
            } label: {
                Text("＋ カテゴリを追加")
                    .font(KMTypography.body(16, weight: .medium))
                    .foregroundStyle(KMColor.primary)
                    .frame(minHeight: KMLayout.minimumHit, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("entry.addCategory")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func categoryChoice(_ category: KMCategory) -> some View {
        let visual = KMCategoryTone.visual(name: category.name, id: category.id)
        let selected = category.id == model.categoryId
        return Button {
            model.categoryId = category.id
            sheet = nil
        } label: {
            VStack(spacing: KMSpacing.space1) {
                KMIcon(name: visual.icon, size: 20)
                    .foregroundStyle(visual.tone.foreground)
                    .frame(width: 30, height: 30)
                    .background(visual.tone.background, in: Circle())
                Text(category.name)
                    .font(KMTypography.body(13, weight: selected ? .bold : .medium))
                    .foregroundStyle(KMColor.text)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 32)
            }
            .frame(maxWidth: .infinity, minHeight: 68)
            .padding(.horizontal, KMSpacing.space1)
            .background(selected ? KMColor.primarySoft : KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.lg))
            .overlay(RoundedRectangle(cornerRadius: KMRadius.lg)
                .stroke(selected ? KMColor.primary : KMColor.border, lineWidth: selected ? 2 : 1))
            .contentShape(RoundedRectangle(cornerRadius: KMRadius.lg))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(category.name)
        .accessibilityValue(selected ? "選択中" : "")
        .accessibilityIdentifier("entry.category.\(category.id)")
    }

    private func accountSheet(for field: KMEntryFormModel.AccountField) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            ForEach(accountTypeOrder, id: \.rawValue) { type in
                let rows = model.accounts.filter { $0.accountType == type }
                if !rows.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(accountTypeLabel(type))
                            .font(KMTypography.note.weight(.bold))
                            .foregroundStyle(KMColor.muted)
                            .frame(minHeight: KMLayout.entryHeight, alignment: .bottomLeading)
                        ForEach(rows) { account in
                            Button {
                                if field == .source { model.accountId = account.id }
                                else { model.destinationAccountId = account.id }
                                sheet = nil
                            } label: {
                                HStack(spacing: KMSpacing.space3) {
                                    Text(account.name).font(KMTypography.body(16, weight: .medium)).foregroundStyle(KMColor.text)
                                    Spacer(minLength: 0)
                                    if (field == .source ? model.accountId : model.destinationAccountId) == account.id {
                                        KMIcon(name: "check", size: 18).foregroundStyle(KMColor.primary)
                                    }
                                }
                                .frame(minHeight: KMLayout.entryHeight)
                                .contentShape(Rectangle())
                                .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(account.name)
                            .accessibilityValue((field == .source ? model.accountId : model.destinationAccountId) == account.id ? "選択中" : "")
                            .accessibilityIdentifier("entry.account.\(account.id)")
                        }
                    }
                }
            }
            Button("＋ 支払元・口座を追加") {
                model.accountFieldForCreation = field
                model.sheetError = nil
                model.newAccountName = ""
                model.newAccountType = .bank
                sheet = .addAccount
            }
            .font(KMTypography.body(16, weight: .medium))
            .foregroundStyle(KMColor.primary)
            .frame(minHeight: KMLayout.minimumHit, alignment: .leading)
            .buttonStyle(.plain)
            .accessibilityIdentifier("entry.addAccountFromPicker")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var accountTypeOrder: [KMAccountType] {
        model.kind == .expense ? [.creditCard, .bank, .cash, .other] : [.bank, .cash, .other, .creditCard]
    }

    private func accountTypeLabel(_ type: KMAccountType) -> String {
        switch type {
        case .bank: "銀行口座"
        case .creditCard: "クレジットカード"
        case .cash: "現金"
        case .other: "その他 / 未分類"
        }
    }

    private var addCategorySheet: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            TextField("カテゴリ名", text: $model.newCategoryName)
                .textFieldStyle(.plain)
                .font(KMTypography.body(16))
                .padding(.horizontal, KMSpacing.space3)
                .frame(minHeight: 48)
                .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.md))
                .accessibilityLabel("カテゴリ名")
                .accessibilityIdentifier("entry.newCategoryName")
            sheetError
            Button("追加する") {
                Task { if await model.createCategory() != nil { sheet = nil } }
            }
            .buttonStyle(KMButtonStyle(role: .primary))
            .accessibilityIdentifier("entry.createCategory")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var addAccountSheet: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            TextField("支払元・口座名", text: $model.newAccountName)
                .textFieldStyle(.plain)
                .font(KMTypography.body(16))
                .padding(.horizontal, KMSpacing.space3)
                .frame(minHeight: 48)
                .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.md))
                .accessibilityLabel("支払元・口座名")
                .accessibilityIdentifier("entry.newAccountName")
            Picker("種類", selection: $model.newAccountType) {
                Text("銀行口座").tag(KMAccountType.bank)
                Text("クレジットカード").tag(KMAccountType.creditCard)
                Text("現金").tag(KMAccountType.cash)
                Text("その他 / 未分類").tag(KMAccountType.other)
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("entry.newAccountType")
            sheetError
            Button("追加する") {
                Task { if await model.createAccount() != nil { sheet = nil } }
            }
            .buttonStyle(KMButtonStyle(role: .primary))
            .accessibilityIdentifier("entry.createAccount")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var sheetError: some View {
        if let error = model.sheetError {
            Text("! \(error)")
                .font(KMTypography.note)
                .foregroundStyle(KMColor.danger)
                .accessibilityIdentifier("entry.sheetError")
        }
    }
}

struct ManualEntryView: View {
    var body: some View { KMEntryFormView(kind: .expense) }
}

#Preview { KMFixturePreview("migration") { KMEntryFormView(kind: .expense) } }
