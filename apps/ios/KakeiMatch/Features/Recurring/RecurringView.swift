import SwiftUI

private enum KMRecurringPage { case list, detail, editor }
private enum KMRecurringEditorField: Hashable { case name, amount, startDate }

struct KMRecurringView: View {
    @Environment(\.repositories) private var repositories
    @State private var model = KMRecurringModel()
    @State private var page: KMRecurringPage = .list
    @State private var selected: KMRecurringTransaction?
    @State private var name = ""
    @State private var kind: KMRecurringTransaction.Kind = .expense
    @State private var amount = ""
    @State private var categoryId = ""
    @State private var accountId = ""
    @State private var frequency: KMRecurringTransaction.Frequency = .monthly
    @State private var startDate = ""
    @FocusState private var focusedEditorField: KMRecurringEditorField?
    @State private var postsTransaction = true
    @State private var confirmsDelete = false
    @State private var confirmsCatchUpDelete = false
    @State private var selectingCatchUp = false
    @State private var catchUpSelections: [String: Set<KMDate>] = [:]
    @State private var pendingDeleteGeneration: KMRecurringGeneration?
    @State private var pendingDeleteDates: [KMDate] = []
    let onBack: () -> Void

    var body: some View {
        pageWithDialogs
            .onChange(of: kind) { _, newKind in handleKindChange(newKind) }
            .task { await model.load(repositories) }
    }

    private var pageWithDialogs: some View {
        let content = pageContent
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("recurring.screen")
        return catchUpDeleteDialog(deleteScheduleDialog(content))
            .fullScreenCover(isPresented: catchUpPromptPresentation) {
                if let plan = model.catchUpPrompt { catchUpPromptDialog(plan) }
            }
    }

    @ViewBuilder private var pageContent: some View {
        if page == .list {
            listPage
        } else if page == .detail, let selected {
            detailPage(selected)
        } else {
            editor
        }
    }

    private var listPage: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            backButton("設定", action: onBack)
            title("定期登録", id: "recurring.title")
            Text("決まった日に自動で記録します。")
                .font(KMTypography.body(15)).foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
            status
            if model.isLoading { ProgressView().tint(KMColor.primary).frame(maxWidth: .infinity).padding(.vertical, 24) }
            else if model.schedules.isEmpty {
                Text("定期登録はありません。").font(KMTypography.body(15)).foregroundStyle(KMColor.muted).padding(.top, KMSpacing.space2)
            } else {
                VStack(spacing: 0) {
                    ForEach(model.schedules) { schedule in
                        Button { openDetail(schedule) } label: { scheduleRow(schedule) }
                            .buttonStyle(.plain).accessibilityIdentifier("recurring.row.\(schedule.id)")
                        Rectangle().fill(KMColor.border).frame(height: 1)
                    }
                }.overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
            }
            Spacer(minLength: 0)
            primaryButton("定期登録を追加") { prepareEditor(nil) }
                .accessibilityIdentifier("recurring.add")
        }
    }

    private func detailPage(_ schedule: KMRecurringTransaction) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            backButton("定期登録") { page = .list }
            title(schedule.name, id: "recurring.detail.title")
            Text("\(schedule.kind == .expense ? "支出" : "収入")の定期登録 · \(schedule.completed ? "終了済み" : "継続中")")
                .font(KMTypography.note).foregroundStyle(KMColor.muted)
            status
            detailRows(schedule)
            catchUpHistory(schedule)
            Spacer(minLength: 0)
            if schedule.editable {
                primaryButton("編集する") { prepareEditor(schedule) }.accessibilityIdentifier("recurring.edit")
            } else {
                Text("この定期登録には画面で扱えない予定条件があります。金額や頻度などの条件は編集できません。削除して作り直してください。")
                    .font(KMTypography.note).foregroundStyle(KMColor.muted).fixedSize(horizontal: false, vertical: true)
            }
            Button("削除する") { confirmsDelete = true }
                .buttonStyle(KMButtonStyle(role: .destructive)).frame(maxWidth: .infinity, minHeight: 44)
                .accessibilityIdentifier("recurring.delete")
        }
    }

    private func deleteScheduleDialog<Content: View>(_ content: Content) -> some View {
        content.confirmationDialog("この定期登録を削除しますか？", isPresented: $confirmsDelete, titleVisibility: .visible) {
            Button("削除する", role: .destructive) {
                guard let selected else { return }
                Task { await model.delete(selected, repositories: repositories); page = .list }
            }
            Button("キャンセル", role: .cancel) {}
        } message: { Text("すでに作成された取引は残ります。") }
    }

    private var catchUpPromptPresentation: Binding<Bool> {
        Binding(
            get: { model.catchUpPrompt != nil },
            set: { isPresented in
                if !isPresented && !selectingCatchUp { model.cancelCatchUpPrompt() }
            }
        )
    }

    private func catchUpPromptDialog(_ plan: KMRecurringCatchUpPlan) -> some View {
        GeometryReader { geometry in
            ZStack {
                KMColor.scrim.ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { model.cancelCatchUpPrompt() }
                    .accessibilityHidden(true)
                ScrollView {
                    catchUpPromptCard(plan)
                        .padding(.horizontal, KMSpacing.space4)
                        .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .center)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(.isModal)
            .accessibilityIdentifier("recurring.catchUp.dialog")
            .accessibilityAction(.escape) { model.cancelCatchUpPrompt() }
        }
        .ignoresSafeArea()
        .presentationBackground(.clear)
    }

    private func catchUpPromptCard(_ plan: KMRecurringCatchUpPlan) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            Text("過去分の記録")
                .font(KMTypography.body(20, weight: .bold)).foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader)
            Text(KMRecurringPresentation.catchUpPrompt(plan))
                .font(KMTypography.body(15)).foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
            VStack(spacing: KMSpacing.space2) {
                Button("全件を記録") { chooseCatchUp(currentMonthOnly: false) }
                    .buttonStyle(KMButtonStyle(role: .primary))
                    .accessibilityIdentifier("recurring.catchUp.all")
                Button("今月分から記録") { chooseCatchUp(currentMonthOnly: true) }
                    .font(KMTypography.body(16, weight: .bold)).foregroundStyle(KMColor.text)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.md))
                    .overlay { RoundedRectangle(cornerRadius: KMRadius.md).stroke(KMColor.border, lineWidth: 1) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("recurring.catchUp.currentMonth")
                Button("キャンセル", role: .cancel) { model.cancelCatchUpPrompt() }
                    .font(KMTypography.body(16, weight: .bold)).foregroundStyle(KMColor.text)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.md))
                    .overlay { RoundedRectangle(cornerRadius: KMRadius.md).stroke(KMColor.border, lineWidth: 1) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("recurring.catchUp.cancel")
            }
        }
        .padding(KMSpacing.space5)
        .frame(maxWidth: 440)
        .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.xl))
        .overlay { RoundedRectangle(cornerRadius: KMRadius.xl).stroke(KMColor.border, lineWidth: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("recurring.catchUp.dialog.card")
    }

    private func chooseCatchUp(currentMonthOnly: Bool) {
        selectingCatchUp = true
        Task {
            await model.chooseCatchUp(currentMonthOnly: currentMonthOnly, repositories: repositories)
            selectingCatchUp = false
            if model.saved { page = .list }
        }
    }

    private func catchUpDeleteDialog<Content: View>(_ content: Content) -> some View {
        content.confirmationDialog("過去分を削除しますか？", isPresented: $confirmsCatchUpDelete, titleVisibility: .visible) {
            Button("削除する", role: .destructive) {
                guard let selected, let generation = pendingDeleteGeneration else { return }
                let dates = pendingDeleteDates
                Task {
                    await model.deleteOccurrences(id: generation.id, dates: dates, scheduleId: selected.id, repositories: repositories)
                    catchUpSelections[generation.id] = []
                }
            }.accessibilityIdentifier("recurring.catchUp.confirmDelete")
            Button("キャンセル", role: .cancel) {}
        } message: {
            if let generation = pendingDeleteGeneration {
                Text(KMRecurringPresentation.selectedDeletionMessage(dates: pendingDeleteDates, amountYen: generation.input.amountYen))
            }
        }
    }

    private func handleKindChange(_ newKind: KMRecurringTransaction.Kind) {
        if let chosen = model.categories.first(where: { $0.id == categoryId }), chosen.isIncome != (newKind == .income) {
            categoryId = ""
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            backButton(selected == nil ? "定期登録" : selected!.name) { page = selected == nil ? .list : .detail }
            title(selected == nil ? "定期登録を追加" : "定期登録を編集", id: "recurring.editor.title")
            status
            formRow("名前") {
                TextField("例：家賃", text: $name).textInputAutocapitalization(.never)
                    .focused($focusedEditorField, equals: .name)
                    .accessibilityLabel("名前").accessibilityIdentifier("recurring.name")
            }
            formRow("種類") {
                Picker("種類", selection: $kind) { Text("支出").tag(KMRecurringTransaction.Kind.expense); Text("収入").tag(KMRecurringTransaction.Kind.income) }
                    .pickerStyle(.segmented).accessibilityIdentifier("recurring.kind")
            }
            formRow("金額（円）") {
                TextField("金額", text: $amount).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                    .focused($focusedEditorField, equals: .amount)
                    .accessibilityLabel("金額（円）").accessibilityIdentifier("recurring.amount")
            }
            formRow("カテゴリ") {
                Picker("カテゴリ", selection: $categoryId) {
                    Text("選択してください").tag("")
                    ForEach(model.categories.filter { $0.isIncome == (kind == .income) }) { Text($0.name).tag($0.id) }
                }.accessibilityIdentifier("recurring.category")
            }
            formRow("口座") {
                Picker("口座", selection: $accountId) {
                    Text("選択してください").tag("")
                    ForEach(orderedAccounts) { Text($0.name).tag($0.id) }
                }.accessibilityIdentifier("recurring.account")
            }
            formRow("頻度") {
                Picker("頻度", selection: $frequency) {
                    Text("毎月").tag(KMRecurringTransaction.Frequency.monthly)
                    Text("毎週").tag(KMRecurringTransaction.Frequency.weekly)
                    Text("毎年").tag(KMRecurringTransaction.Frequency.yearly)
                }.accessibilityIdentifier("recurring.frequency")
            }
            formRow("開始日") {
                TextField("YYYY-MM-DD", text: $startDate).textInputAutocapitalization(.never)
                    .focused($focusedEditorField, equals: .startDate)
                    .accessibilityLabel("開始日").accessibilityIdentifier("recurring.startDate")
            }
            Toggle("予定日に自動登録する", isOn: $postsTransaction).tint(KMColor.primary)
                .frame(minHeight: KMLayout.minimumHit).accessibilityIdentifier("recurring.autoPost")
            Spacer(minLength: 0)
            primaryButton("保存する") {
                focusedEditorField = nil
                Task {
                    await Task.yield()
                    await model.save(name: name, kind: kind, amount: amount, categoryId: categoryId, accountId: accountId,
                        frequency: frequency, startDate: startDate, postsTransaction: postsTransaction, editing: selected, repositories: repositories)
                    if model.saved { page = .list }
                }
            }.disabled(model.isSaving).accessibilityIdentifier("recurring.save")
        }
    }

    @ViewBuilder private var status: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            if let error = model.error {
                Text(error).font(KMTypography.note).foregroundStyle(KMColor.danger).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("recurring.status")
            } else if let message = model.message {
                Text(message).font(KMTypography.note).foregroundStyle(KMColor.primary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("recurring.status")
            } else if model.saved {
                Text("定期登録を保存しました。").font(KMTypography.note).foregroundStyle(KMColor.primary)
                    .accessibilityIdentifier("recurring.status")
            }
            if model.canRetryCatchUp {
                Button("過去分の記録を再試行する") {
                    Task {
                        await model.retryCatchUp(repositories: repositories)
                        if model.saved { page = .list }
                    }
                }
                .font(KMTypography.note).foregroundStyle(KMColor.primary)
                .disabled(model.isSaving).accessibilityIdentifier("recurring.catchUp.retry")
            }
        }
    }

    private var orderedAccounts: [KMAccount] {
        let order: [KMAccountType] = kind == .expense ? [.creditCard, .bank, .cash, .other] : [.bank, .cash, .other, .creditCard]
        return model.accounts.sorted { (order.firstIndex(of: $0.accountType) ?? order.count) < (order.firstIndex(of: $1.accountType) ?? order.count) }
    }

    private func scheduleRow(_ schedule: KMRecurringTransaction) -> some View {
        HStack(spacing: KMSpacing.space2) {
            let categoryName = model.categories.first(where: { $0.id == schedule.categoryId })?.name ?? ""
            let visual = KMCategoryTone.visual(name: categoryName, id: schedule.categoryId)
            KMIcon(name: schedule.kind == .income ? "income" : visual.icon, size: 20)
                .foregroundStyle(schedule.kind == .income ? KMColor.income : visual.tone.foreground)
                .frame(width: 36, height: 36)
                .background(schedule.kind == .income ? KMColor.income.opacity(0.12) : visual.tone.background, in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(schedule.name).font(KMTypography.body(15, weight: .medium)).foregroundStyle(KMColor.text).lineLimit(1)
                Text("\(KMRecurringPresentation.timing(schedule)) · \(model.accounts.first(where: { $0.id == schedule.accountId })?.name ?? "口座なし") · \(schedule.completed ? "終了済み" : "次回 \(schedule.nextDate?.rawValue ?? "未定")") · 自動登録\(schedule.postsTransaction ? "オン" : "オフ")")
                    .font(KMTypography.note).foregroundStyle(KMColor.muted).lineLimit(1)
            }
            Spacer(minLength: KMSpacing.space1)
            Text(KMRecurringPresentation.amount(schedule.amountYen, kind: schedule.kind)).font(KMTypography.number(14, weight: .semibold))
                .foregroundStyle(schedule.kind == .income ? KMColor.income : KMColor.text).lineLimit(1)
        }
        .frame(minHeight: 60).contentShape(Rectangle())
    }

    private func detailRows(_ schedule: KMRecurringTransaction) -> some View {
        let category = model.categories.first(where: { $0.id == schedule.categoryId })?.name ?? "利用できません"
        let account = model.accounts.first(where: { $0.id == schedule.accountId })?.name ?? "利用できません"
        return VStack(spacing: 0) {
            detailRow("金額", KMRecurringPresentation.amount(schedule.amountYen, kind: schedule.kind))
            detailRow("カテゴリ", category)
            detailRow("口座", account)
            detailRow("頻度", KMRecurringPresentation.frequency(schedule.frequency))
            detailRow("開始日", schedule.startDate.rawValue)
            detailRow("次回", schedule.nextDate?.rawValue ?? "未定")
            detailRow("自動登録", schedule.postsTransaction ? "オン" : "オフ")
        }.overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private func catchUpHistory(_ schedule: KMRecurringTransaction) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text("過去分の生成履歴").font(KMTypography.body(16, weight: .bold)).foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader).accessibilityIdentifier("recurring.catchUp.history.title")
            if model.isLoadingHistory {
                ProgressView().tint(KMColor.primary).frame(maxWidth: .infinity).padding(.vertical, KMSpacing.space2)
            } else if model.generations.isEmpty {
                Text("過去分の生成履歴はありません。").font(KMTypography.body(15)).foregroundStyle(KMColor.muted)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("recurring.catchUp.history.empty")
            } else {
                ForEach(model.generations) { generation in
                    catchUpGeneration(generation, schedule: schedule)
                    Rectangle().fill(KMColor.border).frame(height: 1)
                }
            }
        }
        .padding(.top, KMSpacing.space4)
        .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("recurring.catchUp.history")
    }

    private func catchUpGeneration(_ generation: KMRecurringGeneration, schedule: KMRecurringTransaction) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text(KMRecurringPresentation.historySummary(generation))
                .font(KMTypography.note).foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("recurring.catchUp.summary.\(generation.id)")
            if generation.undoneAt != nil {
                Text("一括取り消し済みです。").font(KMTypography.note).foregroundStyle(KMColor.muted)
                    .accessibilityIdentifier("recurring.catchUp.undone.\(generation.id)")
            }
            ForEach(generation.occurrences, id: \.date) { occurrence in
                if let status = KMRecurringPresentation.occurrenceStatus(occurrence.status) {
                    Text("\(occurrence.date.rawValue) · \(KMAmountFormatter.yen(generation.input.amountYen)) · \(status)")
                        .font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("recurring.catchUp.date.\(generation.id).\(occurrence.date.rawValue)")
                } else {
                    let isSelected = catchUpSelections[generation.id, default: []].contains(occurrence.date)
                    Button {
                        var dates = catchUpSelections[generation.id, default: []]
                        if isSelected { dates.remove(occurrence.date) } else { dates.insert(occurrence.date) }
                        catchUpSelections[generation.id] = dates
                    } label: {
                        HStack(spacing: KMSpacing.space3) {
                            Image(systemName: isSelected ? "checkmark.square.fill" : "square")
                                .font(.system(size: 22)).foregroundStyle(isSelected ? KMColor.primary : KMColor.muted)
                            Text("\(occurrence.date.rawValue) · \(KMAmountFormatter.yen(generation.input.amountYen))")
                                .font(KMTypography.body(14)).foregroundStyle(KMColor.text)
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: KMLayout.minimumHit, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(occurrence.date.rawValue) · \(KMAmountFormatter.yen(generation.input.amountYen))")
                    .accessibilityValue(isSelected ? "選択中" : "未選択")
                    .accessibilityIdentifier("recurring.catchUp.date.\(generation.id).\(occurrence.date.rawValue)")
                }
            }
            if let undoLabel = KMRecurringPresentation.undoLabel(generation) {
                Button(undoLabel) {
                    Task { await model.undoGeneration(id: generation.id, scheduleId: schedule.id, repositories: repositories) }
                }
                .buttonStyle(KMButtonStyle(role: .secondary)).frame(maxWidth: .infinity, minHeight: 44)
                .disabled(model.isSaving).accessibilityIdentifier("recurring.catchUp.undo.\(generation.id)")
                Button("選択した記録を削除") {
                    let dates = (catchUpSelections[generation.id] ?? []).sorted()
                    guard !dates.isEmpty else { model.message = "削除する日を選んでください。"; return }
                    pendingDeleteGeneration = generation
                    pendingDeleteDates = dates
                    confirmsCatchUpDelete = true
                }
                .font(KMTypography.note).foregroundStyle(KMColor.danger).frame(minHeight: 44, alignment: .leading)
                .disabled(model.isSaving).accessibilityIdentifier("recurring.catchUp.deleteSelected.\(generation.id)")
            }
        }
        .padding(.vertical, KMSpacing.space3)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("recurring.catchUp.entry.\(generation.id)")
    }

    private func openDetail(_ schedule: KMRecurringTransaction) {
        selected = schedule
        catchUpSelections = [:]
        page = .detail
        Task { await model.loadGenerations(scheduleId: schedule.id, repositories: repositories) }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack { Text(label).font(KMTypography.note).foregroundStyle(KMColor.muted); Spacer(); Text(value).font(KMTypography.text).foregroundStyle(KMColor.text) }
            .frame(minHeight: 52).overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private func formRow<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: KMSpacing.space2) {
            Text(label).font(KMTypography.note).foregroundStyle(KMColor.muted).frame(width: 92, alignment: .leading)
            content().font(KMTypography.body(15)).foregroundStyle(KMColor.text)
        }.frame(minHeight: 52).overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private func backButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { HStack(spacing: 3) { Text("‹"); Text(label) }.font(KMTypography.body(15, weight: .medium)).foregroundStyle(KMColor.primary).frame(minHeight: KMLayout.minimumHit) }
            .buttonStyle(.plain).accessibilityLabel(label == "設定" ? "設定へ戻る" : "一覧へ戻る").accessibilityIdentifier("settings.back")
    }

    private func title(_ text: String, id: String) -> some View {
        Text(text).font(KMTypography.heading).foregroundStyle(KMColor.text).fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader).accessibilityIdentifier(id)
    }

    private func primaryButton(_ text: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(text).font(KMTypography.body(16, weight: .bold)).foregroundStyle(KMColor.onPrimary).frame(maxWidth: .infinity, minHeight: 52).background(KMColor.primary, in: RoundedRectangle(cornerRadius: KMRadius.lg)) }
            .buttonStyle(.plain)
    }

    private func prepareEditor(_ value: KMRecurringTransaction?) {
        selected = value
        name = value?.name ?? ""
        kind = value?.kind ?? .expense
        amount = value.map { String($0.amountYen) } ?? ""
        categoryId = value?.categoryId ?? ""
        accountId = value?.accountId ?? ""
        frequency = value?.frequency ?? .monthly
        startDate = value?.startDate.rawValue ?? KMDate(instant: repositories?.referenceDate ?? Date()).rawValue
        postsTransaction = value?.postsTransaction ?? true
        page = .editor
    }
}

#if DEBUG
#Preview { KMFixturePreview("migration") { SettingsView() } }
#endif
