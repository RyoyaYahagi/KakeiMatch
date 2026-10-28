import SwiftUI

struct KMRecordDetailView: View {
    @Bindable var model: KMRecordsModel
    @Environment(\.repositories) private var repositories
    @State private var confirmsDeletion = false
    @State private var showsItems = false
    @State private var showsImage = false
    @State private var image: UIImage?
    @State private var imageError: String?
    @FocusState private var focus: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { focus = nil; Task { await model.backFromDetail() } } label: {
                HStack(spacing: 2) {
                    KMIcon(name: "chevronLeft", size: 20)
                    Text(model.searchOrigin ? "検索結果へ戻る" : "記録一覧へ戻る")
                }
            }
            .buttonStyle(KMButtonStyle(role: .text)).accessibilityIdentifier("records.detailBack")
            .padding(.bottom, KMSpacing.space2)
            if let row = model.selected, let draft = model.draft {
                Text(row.kind == .income ? "収入の記録" : row.kind == .transfer ? "振替の記録" : "支出の記録")
                    .font(KMTypography.body(18, weight: .bold)).padding(.top, KMSpacing.space1).padding(.bottom, KMSpacing.space3)
                    .onTapGesture { collapse() }
                VStack(spacing: 0) {
                    detailRow("金額", id: "amount", value: KMAmountFormatter.yen(Int(draft.amount) ?? 0), amount: true)
                    detailRow(model.selectedReceipt?.confirmedValue?.purchasedTime == nil ? "日付" : "日時", id: "date",
                        value: draft.date + (model.selectedReceipt?.confirmedValue?.purchasedTime.map { " " + $0 } ?? ""))
                    if row.kind == .transfer {
                        detailRow("振替元口座", id: "account", value: accountName(draft.accountId))
                        detailRow("振替先口座", id: "destination", value: accountName(draft.destinationId))
                    } else {
                        detailRow(row.kind == .income ? "入金元・内容" : "店名・支払先", id: "payee", value: draft.payee.isEmpty ? "未設定" : draft.payee)
                        detailRow("カテゴリ", id: "category", value: categoryName(draft.categoryId))
                        detailRow(row.kind == .income ? "入金先口座" : "支払元", id: "account", value: accountName(draft.accountId))
                    }
                    detailRow("メモ", id: "memo", value: draft.memo.isEmpty ? "なし" : draft.memo)
                    if model.selectedReceipt != nil {
                        HStack {
                            Text("状態").font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
                            Spacer()
                            Text("✓ 家計簿へ登録済みです。").foregroundStyle(KMColor.success)
                        }.padding(.vertical, KMSpacing.space3)
                    }
                }
                .padding(.vertical, KMSpacing.space4)
                .overlay(alignment: .top) { rule }
                .overlay(alignment: .bottom) { rule }
                .padding(.bottom, KMSpacing.space4)
                if row.kind == .expense && row.amountYen < 0 {
                    Toggle("支出の計算に含めない", isOn: Binding(get: { model.selected?.excludedFromSpending == true }, set: { value in
                        collapse(); Task { await model.setExcluded(value) }
                    }))
                    .toggleStyle(.switch).font(KMTypography.body(13)).frame(minHeight: 52)
                    .accessibilityIdentifier("records.excluded").padding(.bottom, KMSpacing.space3)
                }
                if let receipt = model.selectedReceipt { receiptDetails(receipt) }
                if model.canEdit && row.kind != .transfer || model.editing == "transfer" {
                    Button("変更を保存する") { collapse(); Task { await model.save() } }
                        .buttonStyle(KMButtonStyle(role: .primary)).disabled(!model.changed)
                        .accessibilityIdentifier("records.save").padding(.bottom, KMSpacing.space2)
                }
                if row.kind == .transfer && model.editing != "transfer" {
                    Button("編集する") { model.editing = "transfer" }
                        .buttonStyle(KMButtonStyle(role: .primary)).accessibilityIdentifier("records.editTransfer")
                        .padding(.bottom, KMSpacing.space2)
                }
                Button("削除する") { collapse(); confirmsDeletion = true }
                    .buttonStyle(KMButtonStyle(role: .destructive)).frame(maxWidth: .infinity)
                    .accessibilityIdentifier("records.delete")
            }
        }
        .foregroundStyle(KMColor.text).disabled(model.busy)
        .accessibilityElement(children: .contain).accessibilityIdentifier("records.detailScreen")
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name(KMAppSettingsPreferences.screenLockDidLockNotificationName))) { _ in
            confirmsDeletion = false
        }
        .alert("この取引を削除しますか？レシート画像などの原本は残ります。", isPresented: $confirmsDeletion) {
            Button("削除する", role: .destructive) { Task { await model.remove() } }
            Button("キャンセル", role: .cancel) { }
        }
    }

    private var rule: some View { Rectangle().fill(KMColor.border).frame(height: 1) }
    private func collapse() { focus = nil; model.editing = nil }
    private func accountName(_ id: String) -> String { model.accounts.first { $0.id == id }?.name ?? "利用不可" }
    private func categoryName(_ id: String) -> String { model.categories.first { $0.id == id }?.name ?? "未設定" }
    private var hasItems: Bool { model.selectedReceipt?.confirmedValue?.items?.isEmpty == false }

    private func detailRow(_ label: String, id: String, value: String, amount: Bool = false) -> some View {
        VStack(spacing: 0) {
            let editing = model.editing == id || model.editing == "transfer"
            if editing {
                HStack(spacing: KMSpacing.space3) {
                    Text(label).font(KMTypography.body(13)).foregroundStyle(KMColor.muted).frame(width: 72, alignment: .leading)
                    editor(id, label: label)
                }.frame(minHeight: 44)
            } else if model.canEdit && model.selected?.kind != .transfer {
                Button {
                    if id == "category" && hasItems { showsItems = true; collapse() }
                    else { model.editing = id; focus = id }
                } label: { detailValue(label, value: value, amount: amount, editable: true) }
                .buttonStyle(.plain).accessibilityLabel("\(label)を編集: \(value)")
                .accessibilityIdentifier("records.detail.\(id)")
            } else {
                detailValue(label, value: value, amount: amount, editable: false)
            }
        }
        .padding(.vertical, KMSpacing.space3).overlay(alignment: .bottom) { rule }
    }

    private func detailValue(_ label: String, value: String, amount: Bool, editable: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: KMSpacing.space4) {
            Text(label).font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
            Spacer(minLength: 0)
            Text(value).font(amount ? KMTypography.number(28, weight: .bold) : KMTypography.text)
                .multilineTextAlignment(.trailing).foregroundStyle(KMColor.text)
            if editable { KMIcon(name: "chevronRight", size: 18).foregroundStyle(KMColor.muted) }
        }.frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
    }

    private func binding(_ key: WritableKeyPath<KMRecordEditDraft, String>) -> Binding<String> {
        Binding(get: { model.draft?[keyPath: key] ?? "" }, set: { model.draft?[keyPath: key] = $0 })
    }

    @ViewBuilder private func editor(_ id: String, label: String) -> some View {
        switch id {
        case "category":
            if hasItems {
                Button("購入内容を確認する") { showsItems = true; collapse() }.buttonStyle(KMButtonStyle(role: .text))
            } else {
                Picker(label, selection: binding(\.categoryId)) {
                    Text("未設定").tag("")
                    ForEach(model.categories.filter { !$0.hidden && $0.isIncome == (model.selected?.kind == .income) || $0.id == model.draft?.categoryId }) { category in
                        Text(category.name).tag(category.id)
                    }
                }.pickerStyle(.menu).labelsHidden().accessibilityIdentifier("records.editor.category")
            }
        case "account", "destination":
            Picker(label, selection: binding(id == "account" ? \.accountId : \.destinationId)) {
                ForEach(model.accounts.filter { !$0.closed || $0.id == (id == "account" ? model.draft?.accountId : model.draft?.destinationId) }) { account in
                    Text(account.name).tag(account.id)
                }
            }.pickerStyle(.menu).labelsHidden().accessibilityIdentifier("records.editor.\(id)")
        default:
            TextField(label, text: binding(id == "amount" ? \.amount : id == "date" ? \.date : id == "payee" ? \.payee : \.memo), axis: id == "memo" ? .vertical : .horizontal)
                .font(id == "amount" ? KMTypography.number(30, weight: .bold) : KMTypography.text)
                .keyboardType(id == "amount" ? .numberPad : id == "date" ? .asciiCapable : .default)
                .focused($focus, equals: id).accessibilityLabel(label).accessibilityIdentifier("records.editor.\(id)")
                .frame(minHeight: 44)
        }
    }

    @ViewBuilder private func receiptDetails(_ receipt: KMReceipt) -> some View {
        if let rules = receipt.aiSuggestion.categoryRules, !rules.isEmpty {
            DisclosureGroup("分類の理由") {
                VStack(alignment: .leading, spacing: KMSpacing.space2) {
                    Text("レシートを読み取った時に適用した、いつもの分類です。")
                    ForEach(Array(rules.enumerated()), id: \.offset) { _, rule in
                        Text("\(rule.targetType == .item ? "品目" : "店舗")「\(rule.normalizedName)」→「\(rule.categoryName)」で分類しました。")
                        Text("適用時は過去\(rule.receipts)件中\(rule.matchingReceipts)件が「\(rule.categoryName)」でした（一致率 \(rule.agreementPercent)%）。")
                            .foregroundStyle(KMColor.muted)
                    }
                }.font(KMTypography.body(14)).padding(.vertical, KMSpacing.space3)
            }.padding(.bottom, KMSpacing.space3)
        }
        if let image = receipt.image {
            DisclosureGroup("レシート画像", isExpanded: $showsImage) {
                if let image = self.image { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 280).accessibilityLabel("保存したレシート") }
                else if let imageError { Text(imageError).font(KMTypography.note).foregroundStyle(KMColor.muted) }
                else { ProgressView("レシート画像を読み込んでいます。") }
            }
            .padding(.bottom, KMSpacing.space3)
            .task(id: showsImage) {
                guard showsImage, self.image == nil else { return }
                do {
                    if let data = try await repositories?.receipts.receiptImage(blobId: image.blobId), let decoded = UIImage(data: data) { self.image = decoded }
                    else { imageError = "レシート画像の原本はありません。" }
                } catch { imageError = "画像を読み込めませんでした。閉じてからもう一度お試しください。" }
            }
        }
        if let value = receipt.confirmedValue {
            if let items = value.items, !items.isEmpty {
                DisclosureGroup("購入内容", isExpanded: $showsItems) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(items) { item in
                            Text("\(item.name) · \(item.amountYen.map(KMAmountFormatter.yen) ?? "金額未入力") · \(categoryName(item.categoryId ?? value.categoryId))")
                                .font(KMTypography.body(14)).frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, KMSpacing.space3).overlay(alignment: .bottom) { rule }
                        }
                    }
                }.accessibilityIdentifier("records.receiptItems").padding(.bottom, KMSpacing.space3)
            }
            if let adjustments = value.adjustments, !adjustments.isEmpty {
                DisclosureGroup("値引き・調整") {
                    ForEach(adjustments) { adjustment in
                        Text("\(adjustment.label) · \(KMAmountFormatter.signed(adjustment.amountYen, kind: .expense))")
                            .font(KMTypography.body(14)).padding(.vertical, KMSpacing.space3)
                    }
                }.padding(.bottom, KMSpacing.space3)
            }
        }
    }
}
