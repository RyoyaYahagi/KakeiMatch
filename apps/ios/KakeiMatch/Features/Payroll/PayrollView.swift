import PhotosUI
import SwiftUI

struct PayrollView: View {
    var onCancel: () -> Void = {}
    var onSaved: () -> Void = {}
    @Environment(\.repositories) private var repositories
    @State private var model = KMPayrollModel()
    @State private var photo: PhotosPickerItem?
    @State private var showsCamera = false
    @State private var showsDetails = false
    @State private var showsDuplicateConfirmation = false
    @FocusState private var focusedField: String?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: KMSpacing.space3) {
                    Text("給与明細から入力")
                        .font(KMTypography.body(22, weight: .bold)).foregroundStyle(KMColor.text)
                        .accessibilityAddTraits(.isHeader)
                    Text("写真は保存しません。氏名・社員番号・マイナンバー・住所・生年月日・口座番号・支店番号・QRコードを隠してから読み取ります。")
                        .font(KMTypography.body(14)).foregroundStyle(KMColor.muted).fixedSize(horizontal: false, vertical: true)
                    if model.loading {
                        ProgressView("給与明細を読み込んでいます。")
                    } else {
                        photoControls
                        if let image = model.image {
                            maskingPreview(image)
                            Toggle("不要な個人情報を隠しました。必要な部分をAIへ送信します", isOn: $model.reviewed)
                                .font(KMTypography.body(14)).tint(KMColor.primary)
                                .accessibilityIdentifier("payroll.maskingConsent")
                            Button(model.reading ? "読み取り中…" : "AIで読み取る") { model.readImage() }
                                .buttonStyle(KMButtonStyle(role: .secondary)).disabled(model.reading)
                                .accessibilityIdentifier("payroll.aiButton")
                        }
                        if let warning = model.warningText {
                            Text(warning).font(KMTypography.note).foregroundStyle(KMColor.warning)
                                .accessibilityIdentifier("payroll.warning")
                        }
                        if model.image == nil { form }
                    }
                }
                .foregroundStyle(KMColor.text)
                .padding(.horizontal, KMSpacing.space4).padding(.bottom, KMSpacing.space3)
            }
            .scrollBounceBehavior(.basedOnSize)

            footer
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("payroll.screen")
        .task { await model.load(repositories) }
        .onDisappear { if !showsCamera { model.cancel() } }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name(KMAppSettingsPreferences.screenLockDidLockNotificationName))) { _ in
            showsCamera = false
            model.cancel()
        }
        .onChange(of: photo) { _, item in
            Task {
                do {
                    guard let item, let data = try await item.loadTransferable(type: Data.self) else { return }
                    let type = item.supportedContentTypes.first?.preferredMIMEType ?? ""
                    guard ["image/jpeg", "image/png", "image/webp"].contains(type) else {
                        model.error = "写真を開けませんでした。JPEG・PNG・WebPを選んでください。"
                        return
                    }
                    model.selectImage(data, contentType: type)
                } catch {
                    model.error = "写真を開けませんでした。JPEG・PNG・WebPを選んでください。"
                }
                photo = nil
            }
        }
        .fullScreenCover(isPresented: $showsCamera) {
            KMReceiptCamera { data in
                showsCamera = false
                if let data { model.selectImage(data, contentType: "image/jpeg") }
            }
            .ignoresSafeArea()
        }
        .confirmationDialog("同じ月の給与・定期給与を確認してください。", isPresented: $showsDuplicateConfirmation, titleVisibility: .visible) {
            Button("それでも登録", role: .destructive) { Task { await model.save(allowDuplicate: true) } }
            Button("キャンセル", role: .cancel) {}
        } message: { Text(model.duplicateMessage ?? "") }
    }

    private var photoControls: some View {
        HStack(spacing: KMSpacing.space4) {
            Button("給与明細を撮る") { showsCamera = true }
                .buttonStyle(KMButtonStyle(role: .text)).accessibilityIdentifier("payroll.cameraButton")
            PhotosPicker(selection: $photo, matching: .images, photoLibrary: .shared()) {
                Text("写真を選ぶ").font(KMTypography.body(16, weight: .bold)).foregroundStyle(KMColor.primary)
                    .frame(minHeight: KMLayout.minimumHit)
            }
            .accessibilityIdentifier("payroll.photoButton")
        }
    }

    private func maskingPreview(_ image: UIImage) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text("隠す範囲の左上と右下を順にタップしてください。複数箇所を隠せます。")
                .font(KMTypography.note).foregroundStyle(KMColor.muted).fixedSize(horizontal: false, vertical: true)
            GeometryReader { geometry in
                ZStack(alignment: .topLeading) {
                    Image(uiImage: image).resizable().scaledToFit()
                    ForEach(Array(model.masks.enumerated()), id: \.offset) { _, rect in
                        Rectangle().fill(.black)
                            .frame(width: max(4, rect.width * geometry.size.width), height: max(4, rect.height * geometry.size.height))
                            .offset(x: rect.minX * geometry.size.width, y: rect.minY * geometry.size.height)
                    }
                    if let point = model.firstMaskPoint {
                        Circle().fill(KMColor.primary).frame(width: 12, height: 12)
                            .position(x: point.x * geometry.size.width, y: point.y * geometry.size.height)
                    }
                }
                .frame(width: geometry.size.width, height: geometry.size.height)
                .clipped().contentShape(Rectangle())
                .gesture(SpatialTapGesture().onEnded { value in
                    model.addMaskPoint(CGPoint(x: min(1, max(0, value.location.x / geometry.size.width)),
                                               y: min(1, max(0, value.location.y / geometry.size.height))))
                })
                .accessibilityLabel("給与明細の写真。隠す範囲の左上と右下を順にタップ")
                .accessibilityIdentifier("payroll.maskingImage")
            }
            .aspectRatio(image.size, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .clipped()
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            KMInputRow(label: "勤務先", value: $model.employerName, identifier: "payroll.employerName", hint: "入力してください")
            HStack(spacing: KMSpacing.space3) {
                Text("支給日").font(KMTypography.body(13, weight: .medium)).foregroundStyle(KMColor.muted)
                    .frame(width: KMLayout.entryKeyWidth, alignment: .leading)
                DatePicker("支給日", selection: dateSelection, displayedComponents: .date)
                    .labelsHidden().environment(\.calendar, tokyoCalendar)
                    .accessibilityLabel("支給日").accessibilityIdentifier("payroll.paymentDate")
                Spacer(minLength: 0)
            }
            .frame(minHeight: KMLayout.entryHeight)
            .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
            KMInputRow(label: "手取り（円）", value: $model.netPay, identifier: "payroll.netPayYen", hint: "必須", isAmount: true)
            pickerRow("カテゴリ", selection: $model.categoryId, choices: model.categories.map { ($0.id, $0.name) }, prompt: "選択してください", id: "payroll.category")
            pickerRow("入金先", selection: $model.accountId, choices: model.accounts.map { ($0.id, $0.name) }, prompt: "銀行口座を選んでください", id: "payroll.account")

            DisclosureGroup("内訳", isExpanded: $showsDetails) {
                VStack(spacing: 0) {
                    Picker("種類", selection: $model.payType) {
                        Text("給与").tag(KMPayrollRecord.Confirmed.PayType.salary)
                        Text("賞与").tag(KMPayrollRecord.Confirmed.PayType.bonus)
                        Text("その他").tag(KMPayrollRecord.Confirmed.PayType.other)
                    }
                    .accessibilityIdentifier("payroll.payType")
                    KMInputRow(label: "対象期間", value: $model.payPeriod, identifier: "payroll.payPeriod")
                    KMInputRow(label: "総支給（円）", value: $model.grossPay, identifier: "payroll.grossPayYen", isAmount: true)
                    ForEach(KMPayrollPresentation.deductionFields, id: \.key) { item in
                        KMInputRow(label: "\(item.label)（円）", value: deductionBinding(item.key), identifier: "payroll.\(item.key)", isAmount: true)
                    }
                    ForEach($model.allowances) { $allowance in
                        KMInputRow(label: "支給項目", value: $allowance.name, identifier: "payroll.allowance.\(allowance.id).name")
                        KMInputRow(label: "金額（円）", value: $allowance.amount, identifier: "payroll.allowance.\(allowance.id).amount", isAmount: true)
                    }
                }
            }
            .font(KMTypography.body(15, weight: .bold))
            .accessibilityIdentifier("payroll.details")

            Text("手取りだけを収入に登録します。控除から支出は作りません。写真と照らし合わせて、違うところを直してください。")
                .font(KMTypography.body(14)).foregroundStyle(KMColor.muted).fixedSize(horizontal: false, vertical: true)
            Toggle("勤務先・支給日・手取りと内訳を確認しました", isOn: $model.reviewed)
                .font(KMTypography.body(14)).tint(KMColor.primary).accessibilityIdentifier("payroll.reviewed")
        }
        .disabled(model.hasPendingRecord || model.saved)
    }

    private func pickerRow(_ label: String, selection: Binding<String>, choices: [(String, String)], prompt: String, id: String) -> some View {
        HStack(spacing: KMSpacing.space3) {
            Text(label).font(KMTypography.body(13, weight: .medium)).foregroundStyle(KMColor.muted)
                .frame(width: KMLayout.entryKeyWidth, alignment: .leading)
            Picker(label, selection: selection) {
                Text(prompt).tag("")
                ForEach(choices, id: \.0) { value in Text(value.1).tag(value.0) }
            }
            .pickerStyle(.menu).accessibilityIdentifier(id)
            Spacer(minLength: 0)
        }
        .frame(minHeight: KMLayout.entryHeight)
        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private func deductionBinding(_ key: String) -> Binding<String> {
        Binding(get: { model.deductions[key, default: ""] }, set: { model.deductions[key] = $0 })
    }

    private var tokyoCalendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return value
    }

    private var dateSelection: Binding<Date> {
        Binding(get: {
            let parts = model.paymentDate.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return repositories?.referenceDate ?? Date() }
            return tokyoCalendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) ?? Date()
        }, set: { date in
            let parts = tokyoCalendar.dateComponents([.year, .month, .day], from: date)
            if let year = parts.year, let month = parts.month, let day = parts.day {
                model.paymentDate = String(format: "%04d-%02d-%02d", year, month, day)
            }
        })
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            if let message = model.duplicateMessage {
                Text(message).font(KMTypography.note).foregroundStyle(KMColor.warning)
                    .accessibilityIdentifier("payroll.duplicateWarning")
            }
            if let error = model.error {
                Text("! \(error)").font(KMTypography.note).foregroundStyle(KMColor.danger)
                    .accessibilityIdentifier("payroll.error")
            }
            if let status = model.status {
                Text(status).font(KMTypography.note).foregroundStyle(KMColor.muted)
                    .accessibilityIdentifier("payroll.status")
            }
            if model.saved {
                Button("記録一覧へ", action: onSaved).buttonStyle(KMButtonStyle(role: .primary))
                    .accessibilityIdentifier("payroll.recordsButton")
            } else {
                Button(model.saving ? "登録しています…" : model.hasPendingRecord ? "登録結果を確認する" : "登録する") {
                    Task {
                        await model.save()
                        if model.duplicateMessage != nil { showsDuplicateConfirmation = true }
                    }
                }
                .font(KMTypography.body(17, weight: .bold)).frame(maxWidth: .infinity, minHeight: 52)
                .buttonStyle(KMButtonStyle(role: .primary))
                .disabled(model.saving || model.loading || model.reading || model.image != nil)
                .accessibilityIdentifier("payroll.saveButton")
            }
        }
        .padding(.horizontal, KMSpacing.space4).padding(.vertical, KMSpacing.space3)
        .frame(maxWidth: KMLayout.contentMax).frame(maxWidth: .infinity)
        .background(KMColor.bg).overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }
}
