import SwiftUI
import UniformTypeIdentifiers

struct ReconciliationImporter: View {
    @Bindable var model: KMReconciliationModel
    var repositories: KMRepositories?
    @State private var provider: KMStatementProvider = .paypayCard
    @State private var showsFiles = false
    @State private var selectedData: Data?
    @State private var filename: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("PayPayカード、三井住友カード、楽天カードのCSVに対応しています。ファイルはこの端末で処理します。")
                .font(KMTypography.body(14)).foregroundStyle(KMColor.muted).lineSpacing(5)
            Text("明細サービス")
            Menu {
                Picker("明細サービス", selection: $provider) {
                    ForEach(KMStatementDownload.providers, id: \.self) { value in Text(KMStatementDownload.label(value)).tag(value) }
                }
            } label: {
                HStack { Text(KMStatementDownload.label(provider)); Spacer(); KMIcon(name: "chevronDown", size: 18) }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }.foregroundStyle(KMColor.text).accessibilityLabel("明細サービス、\(KMStatementDownload.label(provider))")
                .accessibilityIdentifier("statement-provider")
                .padding(.horizontal, 12).background(KMColor.surface, in: RoundedRectangle(cornerRadius: 12))
                .overlay { RoundedRectangle(cornerRadius: 12).stroke(KMColor.borderStrong, lineWidth: 1) }
            VStack(alignment: .leading, spacing: 4) {
                Text("CSVをお持ちでない場合").foregroundStyle(KMColor.muted).font(KMTypography.body(14))
                Link(destination: KMStatementDownload.help(provider).url) {
                    Text("公式サイトで明細CSVを取得 ↗").underline().foregroundStyle(KMColor.primary)
                }.frame(minHeight: 44).accessibilityIdentifier("statement-download-link")
                Text(KMStatementDownload.help(provider).note)
                    .font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
                    .accessibilityIdentifier("statement-download-note")
            }
            if provider == .aeonCard {
                Text("イオンカードのCSV形式を確認中です。現在、KakeiMatchへの取り込みには対応していません。")
                    .font(KMTypography.note).foregroundStyle(KMColor.muted).accessibilityIdentifier("statement-import-availability")
            }
            Text("CSVファイル")
            Button { showsFiles = true } label: {
                HStack { Text("ファイルを選択"); Text(filename ?? "選択されていません").foregroundStyle(KMColor.muted).lineLimit(1) }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }.buttonStyle(.plain).accessibilityIdentifier("statement-file")
                .disabled(provider == .aeonCard)
                .padding(.horizontal, 12).background(KMColor.surface, in: RoundedRectangle(cornerRadius: 12))
                .overlay { RoundedRectangle(cornerRadius: 12).stroke(KMColor.borderStrong, lineWidth: 1) }
            Button(model.isBusy ? "取り込み中…" : "取り込んで照合") {
                guard let data = selectedData else { model.errorMessage = "CSVファイルを選択してください。"; return }
                Task {
                    await model.importCSV(data, provider: provider, repositories: repositories)
                    if model.errorMessage == nil { selectedData = nil; filename = nil }
                }
            }.buttonStyle(KMButtonStyle(role: .primary)).fixedSize(horizontal: true, vertical: false)
                .accessibilityIdentifier("reconciliation.importButton")
                .disabled(provider == .aeonCard || model.isBusy)
            if !model.statements.isEmpty { Text("取り込み済み \(model.statements.count)件").font(KMTypography.note).foregroundStyle(KMColor.muted) }
            ForEach(model.imports) { record in
                if let rows = record.value.needsReviewRows, !rows.isEmpty {
                    DisclosureGroup("\(KMStatementDownload.label(record.value.provider)) CSVの要確認 \(rows.count)件") {
                        ForEach(rows, id: \.rowNumber) { row in
                            Text("\(row.rowNumber)行目: \(row.reason)").font(KMTypography.note).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
        .foregroundStyle(KMColor.text).padding(.bottom, 16)
        .fileImporter(isPresented: $showsFiles, allowedContentTypes: [.commaSeparatedText, .plainText, .data]) { result in
            do {
                let url = try result.get()
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= KMStatementParser.maxBytes else { throw KMDataError.invalidData("CSVファイルが大きすぎます。ファイルを確認してください。") }
                selectedData = try Data(contentsOf: url); filename = url.lastPathComponent
                model.errorMessage = nil
            } catch { model.errorMessage = "CSVファイルを読み込めませんでした。\(error.localizedDescription)" }
        }
    }
}
