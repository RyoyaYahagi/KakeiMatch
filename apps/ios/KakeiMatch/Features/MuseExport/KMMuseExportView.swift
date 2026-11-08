import SwiftUI

/// iOS-only settings page for the read-only Muse snapshot (docs/MUSE_SNAPSHOT.md). It follows
/// the BackupView flow: build a temporary file, then let the user save it with ShareLink.
/// There is no import path back into the app.
struct KMMuseExportView: View {
    let onBack: () -> Void
    @Environment(\.repositories) private var repositories
    @State private var model: KMMuseExportModel

    init(now: @escaping () -> Date = { Date() }, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _model = State(initialValue: KMMuseExportModel(now: now))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            backButton
            Text(KMMuseExportPresentation.title)
                .font(KMTypography.heading)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("museExport.title")

            Text(KMMuseExportPresentation.description)
                .font(KMTypography.text)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("museExport.description")

            Text(KMMuseExportPresentation.sensitiveNotice)
                .font(KMTypography.text)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("museExport.sensitiveNotice")

            Text(KMMuseExportPresentation.readOnlyNotice)
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("museExport.readOnlyNotice")

            periodSection

            Button {
                Task { await model.export(repositories) }
            } label: {
                Text(KMMuseExportPresentation.exportButton)
                    .frame(maxWidth: .infinity, minHeight: 52)
            }
            .buttonStyle(KMButtonStyle(role: .primary))
            .disabled(!model.canExport)
            .accessibilityLabel(KMMuseExportPresentation.exportButton)
            .accessibilityIdentifier("museExport.exportButton")

            if let status = model.status {
                statusText(status, isFailure: model.isFailure)
            }
            if let cleanupError = model.cleanupError {
                statusText(cleanupError, isFailure: true, id: "museExport.cleanupStatus")
            }
            if let url = model.exportedFileURL {
                share(url)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("museExport.screen")
        .task { model.prepare() }
    }

    private var backButton: some View {
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
    }

    private var periodSection: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text(KMMuseExportPresentation.periodTitle)
                .font(KMTypography.body(16, weight: .bold))
                .foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("museExport.periodTitle")

            monthRow(KMMuseExportPresentation.fromLabel,
                year: Binding(get: { model.fromMonth.year }, set: { model.setFromYear($0) }),
                month: Binding(get: { model.fromMonth.month }, set: { model.setFromMonthNumber($0) }),
                yearID: "museExport.fromYear", monthID: "museExport.fromMonth")
            monthRow(KMMuseExportPresentation.toLabel,
                year: Binding(get: { model.toMonth.year }, set: { model.setToYear($0) }),
                month: Binding(get: { model.toMonth.month }, set: { model.setToMonthNumber($0) }),
                yearID: "museExport.toYear", monthID: "museExport.toMonth")

            if let error = model.rangeError {
                Text("! \(error)")
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("museExport.rangeError")
            } else {
                Text(model.rangeSummary)
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("museExport.rangeSummary")
            }

            Text(KMMuseExportPresentation.periodNote)
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("museExport.periodNote")
        }
        .padding(.vertical, KMSpacing.space3)
        .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private func monthRow(_ label: String, year: Binding<Int>, month: Binding<Int>,
                          yearID: String, monthID: String) -> some View {
        HStack(spacing: KMSpacing.space2) {
            Text(label)
                .font(KMTypography.text)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: KMSpacing.space2)
            Picker("\(label)の年", selection: year) {
                ForEach(model.selectableYears, id: \.self) { value in
                    Text("\(value)年").tag(value)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(minHeight: 48)
            .accessibilityLabel("\(label)の年")
            .accessibilityIdentifier(yearID)
            .disabled(model.isWorking)
            Picker("\(label)の月", selection: month) {
                ForEach(model.selectableMonths(for: year.wrappedValue), id: \.self) { value in
                    Text("\(value)月").tag(value)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(minHeight: 48)
            .accessibilityLabel(label)
            .accessibilityIdentifier(monthID)
            .disabled(model.isWorking)
        }
        .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
    }

    private func share(_ url: URL) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space1) {
            Text(KMMuseExportPresentation.notSaved)
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
            ShareLink(item: url, preview: SharePreview(KMMuseExportPresentation.shareTitle)) {
                HStack(spacing: KMSpacing.space1) {
                    KMIcon(name: "upload", size: 18)
                    Text(KMMuseExportPresentation.shareButton)
                }
                .frame(minHeight: KMLayout.minimumHit)
            }
            .buttonStyle(KMButtonStyle(role: .secondary))
            .accessibilityLabel("書き出したファイルを保存・共有する")
            .accessibilityIdentifier("museExport.shareLink")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func statusText(_ value: String, isFailure: Bool,
                            id: String = "museExport.status") -> some View {
        Text(isFailure ? "! \(value)" : value)
            .font(KMTypography.note)
            .foregroundStyle(isFailure ? KMColor.danger : KMColor.primary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(id)
    }
}

#if DEBUG
#Preview { KMFixturePreview("migration") { KMMuseExportView(onBack: {}) } }
#endif
