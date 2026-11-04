import SwiftUI
import UIKit

/// Native counterpart of PWA's settings-page-app. Reads only bundled metadata and
/// the existing allowlisted, memory-only recorder; never reads household repositories.
struct KMAppInformationView: View {
    let onBack: () -> Void
    @State private var diagnosticText = ""
    @State private var showsDiagnostics = false
    @State private var status = ""
    @State private var licenses: [(name: String, text: String)] = []
    @State private var licenseError: String?

    private var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "不明" }
    private var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "不明" }

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

            Text("アプリ情報")
                .font(KMTypography.heading)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("settings-page-app-title")
            Text("KakeiMatch \(version)（ビルド \(build)）")
                .font(KMTypography.text)
                .accessibilityIdentifier("app-info-version")

            heading("端末内の診断")
            Text("不具合を調べるためのアプリの版と処理結果です。家計内容・入力文字・認証情報は含めません。自動送信せず、アプリを開いている間の直近15分・最大40件だけをメモリに保持します。アプリの終了でも消えます。表示・共有する操作履歴は直近20件までです。")
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)

            DisclosureGroup(isExpanded: $showsDiagnostics) {
                VStack(alignment: .leading, spacing: KMSpacing.space3) {
                    Text(diagnosticText)
                        .font(.system(size: 12, design: .monospaced))
                        .textSelection(.enabled)
                        .accessibilityIdentifier("diagnostics-preview")
                    Button("表示を更新") {
                        refreshDiagnostics()
                        status = "表示を更新しました。"
                    }
                    .accessibilityIdentifier("diagnostics-refresh")
                    Button("表示内容をコピー") {
                        UIPasteboard.general.string = diagnosticText
                        status = "診断内容をコピーしました。"
                    }
                    .accessibilityIdentifier("diagnostics-copy")
                    ShareLink("表示内容を共有", item: diagnosticText)
                        .accessibilityIdentifier("diagnostics-export")
                    Button("診断記録を消す") {
                        KMContactDiagnosticRecorder.shared.clear()
                        refreshDiagnostics()
                        status = "診断記録を消しました。家計データは残っています。"
                    }
                    .accessibilityIdentifier("diagnostics-clear")
                    if !status.isEmpty {
                        Text(status)
                            .font(KMTypography.note)
                            .accessibilityIdentifier("diagnostics-status")
                    }
                }
                .buttonStyle(KMButtonStyle(role: .secondary))
            } label: {
                Text("診断内容を確認する").frame(minHeight: KMLayout.minimumHit)
            }
            .accessibilityIdentifier("diagnostics-disclosure")

            heading("オープンソースライセンス")
            ForEach(licenses, id: \.name) { license in
                DisclosureGroup {
                    Text(license.text)
                        .font(KMTypography.note)
                        .textSelection(.enabled)
                } label: {
                    Text(license.name).frame(minHeight: KMLayout.minimumHit)
                }
            }
            if let licenseError {
                Text(licenseError)
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.danger)
            }
        }
        .foregroundStyle(KMColor.text)
        .tint(KMColor.primary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.appInfoScreen")
        .onChange(of: showsDiagnostics) { _, expanded in
            if expanded { refreshDiagnostics() }
        }
        .onAppear {
            refreshDiagnostics()
            loadLicenses()
        }
    }

    private func heading(_ title: String) -> some View {
        Text(title)
            .font(KMTypography.body(16, weight: .bold))
            .padding(.top, KMSpacing.space3)
            .accessibilityAddTraits(.isHeader)
    }

    private func refreshDiagnostics() {
        struct Report: Encodable {
            let appVersion: String
            let build: String
            let diagnostic: KMContactDiagnosticContext
        }
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let report = Report(appVersion: version, build: build,
                                diagnostic: KMContactDiagnosticRecorder.shared.snapshot())
            diagnosticText = String(decoding: try encoder.encode(report), as: UTF8.self)
        } catch {
            diagnosticText = "診断内容を表示できませんでした。"
        }
    }

    private func loadLicenses() {
        licenses = []
        licenseError = nil
        for (name, resource) in [("Actual Budget", "ActualLicense"), ("ZIPFoundation・Zod", "ThirdPartyLicenses")] {
            do {
                guard let url = Bundle.main.url(forResource: resource, withExtension: "txt") else {
                    throw CocoaError(.fileNoSuchFile)
                }
                licenses.append((name: name, text: try String(contentsOf: url, encoding: .utf8)))
            } catch {
                licenseError = "ライセンスを読み込めませんでした。"
            }
        }
    }
}
