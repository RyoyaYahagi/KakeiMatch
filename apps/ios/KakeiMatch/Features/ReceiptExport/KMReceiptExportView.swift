import SwiftUI

/// Settings sub-page for sending food receipts to the user's own inventory/menu app.
/// Off by default. The only primary action is "今すぐ送信".
struct KMReceiptExportView: View {
    var onBack: () -> Void
    @Environment(\.repositories) private var repositories
    @State private var model = KMReceiptExportModel()

    var body: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            Button(action: onBack) {
                HStack(spacing: 2) {
                    KMIcon(name: "chevronLeft", size: 20)
                    Text("設定")
                }
                .frame(minHeight: KMLayout.minimumHit)
            }
            .buttonStyle(KMButtonStyle(role: .text))
            .accessibilityLabel("設定へ戻る")
            .accessibilityIdentifier("settings.back")

            Text(KMReceiptExportPresentation.title)
                .font(KMTypography.heading)
                .foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("receiptExport.title")

            note(KMReceiptExportPresentation.description)

            Toggle(isOn: Binding(get: { model.settings.isEnabled }, set: { model.setEnabled($0) })) {
                Text("送信する")
                    .font(KMTypography.text)
                    .foregroundStyle(KMColor.text)
            }
            .tint(KMColor.primary)
            .frame(minHeight: KMLayout.minimumHit)
            .disabled(!model.loaded)
            .accessibilityIdentifier("receiptExport.enabled")

            sectionTitle("送信先")
            KMInputRow(label: "URL", value: $model.baseURLText, identifier: "receiptExport.url",
                       hint: "https://example-host:8443", error: model.endpointError)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            VStack(alignment: .leading, spacing: KMSpacing.space1) {
                HStack(spacing: KMSpacing.space3) {
                    Text("トークン")
                        .font(KMTypography.body(13, weight: .medium))
                        .foregroundStyle(KMColor.muted)
                        .frame(width: KMLayout.entryKeyWidth, alignment: .leading)
                    SecureField(model.hasSavedToken ? "保存済み（変更時のみ入力）" : "未設定", text: $model.tokenText)
                        .textFieldStyle(.plain)
                        .font(KMTypography.body(16, weight: .medium))
                        .foregroundStyle(KMColor.text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .frame(minHeight: KMLayout.minimumHit)
                        .accessibilityLabel(model.hasSavedToken ? "トークン、保存済み" : "トークン、未設定")
                        .accessibilityIdentifier("receiptExport.token")
                }
                .frame(minHeight: KMLayout.entryHeight)
                .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
            }
            HStack(spacing: KMSpacing.space2) {
                Button("送信先を保存") { model.saveConnection() }
                    .buttonStyle(KMButtonStyle(role: .secondary))
                    .disabled(!model.canSaveConnection)
                    .accessibilityIdentifier("receiptExport.saveConnection")
                if model.hasSavedToken {
                    Button("トークンを削除") { model.deleteToken() }
                        .buttonStyle(KMButtonStyle(role: .destructive))
                        .accessibilityIdentifier("receiptExport.deleteToken")
                }
            }
            note("https のみ使えます。トークンはこの端末のキーチェーンに保存します。")

            sectionTitle("送信するカテゴリ")
            note("選んだカテゴリの品目だけを送ります。未分類の品目は送りません。")
            VStack(spacing: 0) {
                ForEach(model.expenseCategories) { category in
                    categoryRow(category)
                    Rectangle().fill(KMColor.border).frame(height: 1)
                }
            }

            sectionTitle("送信結果")
            Text(KMReceiptExportPresentation.statusText(model.status))
                .font(KMTypography.note)
                .foregroundStyle(KMReceiptExportPresentation.isFailure(model.status) ? KMColor.danger : KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("receiptExport.status")

            Button(model.isSending ? "送信中…" : "今すぐ送信") {
                Task { await model.sendNow(repositories) }
            }
            .buttonStyle(KMButtonStyle(role: .primary))
            .disabled(!model.canSend)
            .accessibilityIdentifier("receiptExport.sendNow")
            if !model.settings.isEnabled {
                note("送信するには、上の「送信する」をオンにしてください。")
            }

            if let message = model.message {
                note(message).accessibilityIdentifier("receiptExport.message")
            }
            if let error = model.error {
                Text("! \(error)")
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("receiptExport.error")
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("receiptExport.screen")
        .task { if !model.loaded { await model.load(repositories) } }
    }

    private func categoryRow(_ category: KMCategory) -> some View {
        let selected = model.selectedCategoryIds.contains(category.id)
        return Button { model.toggleCategory(category.id) } label: {
            HStack(spacing: KMSpacing.space2) {
                Text(category.name)
                    .font(KMTypography.text)
                    .foregroundStyle(KMColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: KMSpacing.space2)
                Text(selected ? "✓ 送信" : "送信しない")
                    .font(KMTypography.body(14))
                    .foregroundStyle(selected ? KMColor.primary : KMColor.muted)
            }
            .frame(maxWidth: .infinity, minHeight: KMLayout.minimumHit, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(category.name)
        .accessibilityValue(selected ? "送信する" : "送信しない")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("receiptExport.category.\(category.id)")
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(KMTypography.body(13, weight: .bold))
            .foregroundStyle(KMColor.muted)
            .padding(.top, KMSpacing.space3)
            .accessibilityAddTraits(.isHeader)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(KMTypography.note)
            .foregroundStyle(KMColor.muted)
            .fixedSize(horizontal: false, vertical: true)
    }
}
