import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ReceiptView: View {
    var source: KMEntryDestination? = nil
    var receiptID: String? = nil
    var onSaved: (() -> Void)? = nil
    @Environment(\.repositories) private var repositories
    @State private var model = KMReceiptModel()
    @State private var photo: PhotosPickerItem?
    @State private var showsPhotos = false
    @State private var showsCamera = false
    @State private var showsImage = false
    @State private var confirmsReread = false
    @State private var optionalExpanded = false
    @FocusState private var focusedField: String?

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: KMSpacing.space3) {
                        Text("レシートを登録する").font(KMTypography.body(22, weight: .bold)).accessibilityAddTraits(.isHeader)
                        tabs
                        if model.loading { ProgressView("レシートを読み込んでいます。") }
                        else if model.pane == "overview" { overview }
                        else { itemList }
                    }
                    .foregroundStyle(KMColor.text)
                    .padding(.horizontal, KMSpacing.space4).padding(.bottom, KMSpacing.space3)
                }
                .onChange(of: focusedField) { _, field in
                    if let field { scroll.scrollTo(field, anchor: .center) }
                }
            }
            VStack(alignment: .leading, spacing: KMSpacing.space2) {
                if let totalError = model.totalError {
                    Text("! \(totalError)").font(KMTypography.note).foregroundStyle(KMColor.danger)
                }
                if let error = model.error {
                    Text("! \(error)").font(KMTypography.note).foregroundStyle(KMColor.danger)
                        .accessibilityIdentifier("receipt.error")
                }
                if let status = model.status {
                    Text(status).font(KMTypography.note).foregroundStyle(KMColor.muted)
                        .accessibilityIdentifier("receipt-save-state")
                }
                if model.didSave {
                    Button("記録一覧へ") { onSaved?() }.buttonStyle(KMButtonStyle(role: .primary))
                        .accessibilityIdentifier("receipt.recordsButton")
                } else if model.isReading {
                    Button(model.phase == .categorizing ? "分類を待っています…" : "読み取り中…") {}
                        .buttonStyle(KMButtonStyle(role: .primary)).disabled(true)
                    Button(model.phase == .categorizing ? "分類を待たずに自分で選ぶ" : "待たずに手で入力する") { model.stopWaiting() }
                        .buttonStyle(KMButtonStyle(role: .text)).accessibilityIdentifier("receipt.stopWaiting")
                } else if case .failed(let failure) = model.phase, KMReceiptPresentation.retryable(failure) {
                    Button("もう一度読み取る") { confirmsReread = model.receipt?.extraction != nil; if !confirmsReread { model.startReading() } }
                        .buttonStyle(KMButtonStyle(role: .primary)).accessibilityIdentifier("receipt.retryButton")
                    Button("手で入力して続ける") { model.stopWaiting(); model.error = nil }
                        .buttonStyle(KMButtonStyle(role: .text)).accessibilityIdentifier("receipt.manualButton")
                } else {
                    Button { focusedField = nil; Task { await model.save() } } label: {
                        Text(model.saving ? "登録しています…" : "登録する")
                            .font(KMTypography.body(17, weight: .bold)).frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .buttonStyle(KMButtonStyle(role: .primary)).accessibilityIdentifier("receipt.saveButton")
                    .disabled(model.saving || model.loading)
                }
            }
            .padding(.horizontal, KMSpacing.space4).padding(.vertical, KMSpacing.space3)
            .frame(maxWidth: .infinity, alignment: .leading).background(KMColor.bg)
            .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
        }
        .accessibilityElement(children: .contain).accessibilityIdentifier("receipt.screen")
        .task {
            await model.load(repositories, receiptID: receiptID)
            if receiptID == nil && repositories?.fixtureName != "receipt" { openSource() }
        }
        .onDisappear { if !showsImage && !showsCamera && !showsPhotos { model.stopWaiting() } }
        .onChange(of: model.phase) { _, phase in
            let message: String
            switch phase {
            case .reading: message = "文字を読み取っています"
            case .categorizing: message = "品目をカテゴリに分けています"
            case .failed: message = "写真から読み取れませんでした。手で入力して続けられます。"
            case .idle: message = model.status ?? "入力できます"
            }
            UIAccessibility.post(notification: .announcement, argument: message)
        }
        .alert("もう一度読み取りますか？", isPresented: $confirmsReread) {
            Button("読み取る") { model.startReading() }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("もう一度読み取るとAIの利用枠を消費し、入力内容を読み取り結果で置き換えます。続けますか？")
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name(KMAppSettingsPreferences.screenLockDidLockNotificationName))) { _ in
            showsCamera = false; showsPhotos = false; showsImage = false; model.stopWaiting()
        }
        .photosPicker(isPresented: $showsPhotos, selection: $photo, matching: .images, preferredItemEncoding: .current)
        .onChange(of: photo) { _, value in
            Task {
                do {
                    guard let value, let data = try await value.loadTransferable(type: Data.self) else { return }
                    let mime = value.supportedContentTypes.first?.preferredMIMEType ?? ""
                    model.selectImage(data, contentType: mime)
                } catch { model.error = "写真を開けませんでした。もう一度選んでください。" }
            }
        }
        .fullScreenCover(isPresented: $showsCamera) {
            KMReceiptCamera { data in
                showsCamera = false
                if let data { model.selectImage(data, contentType: "image/jpeg") }
            }
            .ignoresSafeArea()
        }
        .fullScreenCover(isPresented: $showsImage) {
            if let data = model.imageData, let image = UIImage(data: data) { KMReceiptImageViewer(image: image) }
        }
    }

    private var tabs: some View {
        HStack(spacing: KMSpacing.space1) {
            tab("全体", pane: "overview", identifier: "receipt.overviewTab")
            tab("品目一覧", pane: "items", identifier: "receipt.itemsTab")
        }
        .padding(.horizontal, KMSpacing.space1)
        .background(KMColor.sunken, in: RoundedRectangle(cornerRadius: KMRadius.lg))
    }
    private func tab(_ title: String, pane: String, identifier: String) -> some View {
        Button { focusedField = nil; model.pane = pane } label: {
            Text(title).font(KMTypography.body(14, weight: model.pane == pane ? .bold : .medium))
                .foregroundStyle(model.pane == pane ? KMColor.text : KMColor.muted)
                .frame(maxWidth: .infinity, minHeight: 36)
                .background(model.pane == pane ? KMColor.surface : .clear, in: RoundedRectangle(cornerRadius: KMRadius.sm))
                .frame(minHeight: 44)
        }.buttonStyle(.plain).accessibilityIdentifier(identifier)
            .accessibilityAddTraits(model.pane == pane ? .isSelected : [])
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            if let data = model.imageData, let image = UIImage(data: data) {
                GeometryReader { geometry in
                    let ratio = image.size.width / image.size.height
                    let width = min(geometry.size.width, 280 * ratio)
                    Button { showsImage = true } label: {
                        Image(uiImage: image).resizable().scaledToFit()
                            .frame(width: width, height: width / ratio)
                            .overlay(alignment: .bottomTrailing) {
                                Image(systemName: "magnifyingglass").padding(8).background(KMColor.surface, in: Circle()).padding(8)
                            }
                            .overlay(alignment: .topTrailing) {
                                if model.isReading { Text("読み取り中").font(KMTypography.note).padding(8).background(KMColor.primarySoft, in: Capsule()).padding(8) }
                            }
                            .clipShape(RoundedRectangle(cornerRadius: KMRadius.md))
                            .contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel("レシート画像を拡大して見る").accessibilityIdentifier("receipt.imagePreview")
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                }.frame(height: 280)
            } else if model.receipt?.image != nil {
                Text("レシート画像の原本はありません。原本の確認・再解析はできません。保存済みの内容は利用できます。")
                    .font(KMTypography.note).foregroundStyle(KMColor.muted)
            } else {
                HStack {
                    Button("レシートを撮る") { openCamera() }.accessibilityIdentifier("receipt.cameraButton")
                    Button("写真から") { showsPhotos = true }.accessibilityIdentifier("receipt.imageInput")
                }.buttonStyle(KMButtonStyle(role: .text))
            }
            warningBand
            if model.imageData != nil {
                Text("画像から店名・日付・金額・品目を読み取り、カテゴリを設定します。")
                    .font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
                if model.isReading || isFailed { progress }
                if case .failed(let failure) = model.phase {
                    VStack(alignment: .leading, spacing: KMSpacing.space2) {
                        Text("! 写真から読み取れませんでした").bold().foregroundStyle(KMColor.danger)
                        Text("ぼやけや反射があれば撮り直してください。")
                        Button("撮り直す") { openCamera() }
                        if !KMReceiptPresentation.retryable(failure) {
                            Button("手で入力して続ける") { model.stopWaiting(); model.error = nil }
                                .accessibilityIdentifier("receipt.manualButton")
                        }
                    }.font(KMTypography.note).foregroundStyle(KMColor.text)
                        .padding(KMSpacing.space3).background(KMColor.dangerSoft, in: RoundedRectangle(cornerRadius: KMRadius.lg))
                        .buttonStyle(KMButtonStyle(role: .text)).accessibilityElement(children: .contain).accessibilityIdentifier("receipt.failure")
                } else if !model.isReading {
                    Button(model.receipt?.extraction == nil ? "AIで読み取る" : "再読み取り") {
                        if model.receipt?.extraction != nil { confirmsReread = true } else { model.startReading() }
                    }
                        .buttonStyle(KMButtonStyle(role: .text)).accessibilityIdentifier("receipt.aiButton")
                        .disabled(!model.imageIsSaved || model.didSave)
                    if !model.imageIsSaved {
                        Text("写真はまだ保存されていません。画像は記録に添付されません。手入力した内容を登録できます。")
                            .font(KMTypography.note).foregroundStyle(KMColor.muted)
                    }
                }
            }
            VStack(spacing: 0) {
                row("金額", field: .totalAmountYen, id: "receipt-amount") {
                    TextField("", text: field($model.amount, review: .totalAmountYen))
                        .font(KMTypography.number(30, weight: .bold)).keyboardType(.numberPad)
                        .accessibilityLabel("金額（円）").accessibilityIdentifier("receipt-amount")
                        .focused($focusedField, equals: "receipt-amount")
                    if let check = model.totalCheck {
                        Text(check.label).font(KMTypography.note).foregroundStyle(check.matches ? KMColor.success : KMColor.warning)
                            .accessibilityLabel(check.accessibleLabel).accessibilityIdentifier("receipt-total-check")
                    }
                }
                row("店名", field: .merchant, id: "receipt-merchant") {
                    TextField("", text: field($model.merchant, review: .merchant)).textInputAutocapitalization(.never)
                        .accessibilityLabel("店名").accessibilityIdentifier("receipt-merchant").focused($focusedField, equals: "receipt-merchant")
                }
                row("日付", field: .purchasedDate, id: "receipt-date") {
                    DatePicker("日付", selection: dateBinding, displayedComponents: .date).labelsHidden()
                        .environment(\.timeZone, TimeZone(identifier: "Asia/Tokyo")!).environment(\.locale, Locale(identifier: "ja_JP"))
                        .accessibilityIdentifier("receipt-date")
                    Spacer(minLength: 0)
                }
                row("カテゴリ", id: "receipt-category") {
                    if !model.items.isEmpty {
                        Button("品目ごと · \(Set(model.items.compactMap(\.categoryId)).count)カテゴリ ›") { model.pane = "items" }
                            .accessibilityIdentifier("receipt.categoryItems")
                    } else {
                        Picker("カテゴリ", selection: $model.categoryId) {
                            Text("選択してください").tag("")
                            ForEach(model.categories) { Text($0.name).tag($0.id) }
                        }.accessibilityIdentifier("receipt-category")
                    }
                }
                row("支払元", id: "receipt-account") {
                    Picker("支払元", selection: $model.accountId) {
                        Text("選択してください").tag("")
                        ForEach(model.accounts) { Text($0.name).tag($0.id) }
                    }.accessibilityIdentifier("receipt-account")
                }
                DisclosureGroup("時刻・メモ", isExpanded: $optionalExpanded) {
                    row("時刻", field: .purchasedTime, id: "receipt-time") {
                        TextField("HH:MM", text: field($model.time, review: .purchasedTime)).keyboardType(.numbersAndPunctuation)
                            .accessibilityIdentifier("receipt-time").focused($focusedField, equals: "receipt-time")
                    }
                    row("メモ", id: "receipt-memo") {
                        TextField("", text: $model.memo, axis: .vertical).accessibilityLabel("メモ").accessibilityIdentifier("receipt-memo")
                    }
                }.padding(.vertical, KMSpacing.space2).frame(minHeight: 52).disabled(model.isReading)
                Button { model.pane = "items" } label: {
                    HStack { Text("品目").foregroundStyle(KMColor.muted); Spacer(); Text("\(model.items.count)品目"); Image(systemName: "chevron.right") }
                        .frame(minHeight: 52)
                }.buttonStyle(.plain).accessibilityIdentifier("receipt.itemsEntry")
                Toggle("支出の計算に含めない", isOn: $model.excluded).frame(minHeight: 52).disabled(model.isReading)
                    .accessibilityIdentifier("manual-transaction-excluded")
            }
            .disabled(model.saving || model.didSave)
        }
    }
    private var isFailed: Bool { if case .failed = model.phase { true } else { false } }

    private var progress: some View {
        TimelineView(.periodic(from: model.startedReading, by: 1)) { timeline in
            VStack(alignment: .leading, spacing: 0) {
                progressRow(model.imageIsSaved ? "✓" : "!", model.imageIsSaved ? "写真を保存しました" : "写真はまだ保存されていません", note: model.imageIsSaved ? "この端末に。読み取れなくても消えません" : "手で入力して続けられます")
                progressRow(isFailed ? "!" : model.phase == .categorizing ? "✓" : "○",
                    isFailed ? "読み取れませんでした" : model.phase == .categorizing ? "文字を読み取りました" : "文字を読み取っています",
                    note: isFailed ? (model.imageIsSaved ? "写真は残っています" : "入力した内容はそのままです") : model.phase == .reading ? KMReceiptPresentation.readingNote(elapsed: timeline.date.timeIntervalSince(model.startedReading)) : "")
                progressRow(model.phase == .categorizing ? "○" : "◌", model.phase == .categorizing ? "品目をカテゴリに分けています" : "品目をカテゴリに分けます", note: "")
            }
        }.accessibilityIdentifier("receipt.readingProgress")
    }
    private func progressRow(_ mark: String, _ title: String, note: String) -> some View {
        HStack(alignment: .top, spacing: KMSpacing.space3) {
            Text(mark).foregroundStyle(KMColor.primary).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(KMTypography.body(14)); if !note.isEmpty { Text(note).font(KMTypography.note).foregroundStyle(KMColor.muted) }
            }
            Spacer()
        }.padding(.vertical, KMSpacing.space2).overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    @ViewBuilder private var warningBand: some View {
        if !model.warnings.isEmpty {
            VStack(alignment: .leading, spacing: KMSpacing.space2) {
                Text("△ 画像と照らし合わせてほしいところが\(model.warnings.count)件あります")
                    .bold().accessibilityIdentifier("receipt-review-title")
                ForEach(model.warnings) { warning in
                    HStack(alignment: .top) {
                        Button { showWarning(warning) } label: {
                            VStack(alignment: .leading, spacing: 4) { Text(warning.label).bold(); Text(warning.message) }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.plain).accessibilityIdentifier("receipt.warning.\(warning.id)")
                        Button("確認した") { Task { await model.review(warning) } }
                            .accessibilityLabel("\(warning.label)を確認した").accessibilityIdentifier("receipt.warningDone.\(warning.id)")
                            .frame(minWidth: 44, minHeight: 44)
                    }
                }
            }.font(KMTypography.note).foregroundStyle(KMColor.text).padding(KMSpacing.space3)
                .background(KMColor.warningSoft, in: RoundedRectangle(cornerRadius: KMRadius.md))
                .disabled(model.isReading || model.saving || model.didSave)
        }
    }

    private var itemList: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            Text("購入内容").font(KMTypography.body(17, weight: .bold)).padding(.top, KMSpacing.space4)
            VStack(spacing: 0) {
            ForEach(model.items) { item in
                HStack {
                    VStack(alignment: .leading) {
                        Text(item.name)
                        if model.warnings.contains(where: { $0.field == .items && $0.index.flatMap { model.items.indices.contains($0) ? model.items[$0].id : nil } == item.id }) {
                            Text("△ 写真と確認").font(KMTypography.note).foregroundStyle(KMColor.warning)
                        }
                    }
                    Spacer()
                    if let yen = item.amountYen { KMAmount(yen: yen) } else { Text("未入力") }
                    Text(model.categories.first { $0.id == item.categoryId }?.name ?? "未分類").font(KMTypography.note).foregroundStyle(KMColor.muted)
                }
                .font(KMTypography.body(14)).frame(minHeight: 44).overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
                .accessibilityElement(children: .combine).accessibilityIdentifier("receipt.row.\(item.id)")
            }
            }
            Text("値引き・調整").font(KMTypography.body(17, weight: .bold))
            ForEach(model.adjustments) { adjustment in
                HStack { Text(adjustment.label); Spacer(); Text((adjustment.amountYen < 0 ? "−" : "+") + KMAmountFormatter.yen(adjustment.amountYen)) }
                    .frame(minHeight: 44)
            }
            row("税額（任意）", field: .taxAmountYen, id: "receipt-tax") {
                TextField("", text: field($model.tax, review: .taxAmountYen)).keyboardType(.numberPad)
                    .accessibilityLabel("税額（円・任意）").accessibilityIdentifier("receipt-tax").focused($focusedField, equals: "receipt-tax")
            }.disabled(model.isReading || model.saving || model.didSave)
            if let check = model.totalCheck, !check.matches {
                Text("購入内容との差額は\(check.difference < 0 ? "−" : "+")\(KMAmountFormatter.yen(check.difference))です。入力した合計金額を保ちます。値引きや税額を確認してください。")
                    .font(KMTypography.note).foregroundStyle(KMColor.warning).accessibilityIdentifier("receipt-difference")
            }
            Text("品目・カテゴリの修正は、今後の更新で利用できます。")
                .font(KMTypography.note).foregroundStyle(KMColor.muted).accessibilityIdentifier("receipt.itemsHandoff")
        }
    }

    private func row<Content: View>(_ title: String, field: KMReceiptExtraction.WarningField? = nil, id: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: KMSpacing.space3) {
            Text(title).font(KMTypography.note).foregroundStyle(KMColor.muted).frame(width: 72, alignment: .leading)
            content()
            if let field, model.warnings.contains(where: { $0.field == field }) {
                Text("△ 写真と確認").font(KMTypography.body(11)).foregroundStyle(KMColor.warning)
            }
        }.disabled(model.isReading && id != "receipt-account")
            .frame(minHeight: title == "金額" ? 64 : 52)
            .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }.id(id)
    }
    private func field(_ binding: Binding<String>, review: KMReceiptExtraction.WarningField) -> Binding<String> {
        Binding(get: { binding.wrappedValue }, set: { value in
            binding.wrappedValue = value; Task { await model.reviewField(review) }
        })
    }
    private var dateBinding: Binding<Date> {
        Binding(get: {
            let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
            formatter.timeZone = TimeZone(identifier: "Asia/Tokyo"); formatter.dateFormat = "yyyy-MM-dd"
            return formatter.date(from: model.date) ?? repositories?.referenceDate ?? Date()
        }, set: { value in model.date = KMDate(instant: value).rawValue; Task { await model.reviewField(.purchasedDate) } })
    }
    private func showWarning(_ warning: KMReceiptPresentation.Warning) {
        switch warning.field {
        case .items, .adjustments: model.pane = "items"
        case .taxAmountYen: model.pane = "items"; focusedField = "receipt-tax"
        case .merchant: focusedField = "receipt-merchant"
        case .totalAmountYen: focusedField = "receipt-amount"
        case .purchasedDate: focusedField = "receipt-date"
        case .purchasedTime: optionalExpanded = true; focusedField = "receipt-time"
        case nil: showsImage = model.imageData != nil
        }
    }
    private func openSource() { if source == .photo { showsPhotos = true } else if source == .receipt { openCamera() } }
    private func openCamera() {
        if UIImagePickerController.isSourceTypeAvailable(.camera) { showsCamera = true }
        else { model.error = "この端末では撮影できません。「写真から」で画像を選んでください。"; showsPhotos = true }
    }
}
