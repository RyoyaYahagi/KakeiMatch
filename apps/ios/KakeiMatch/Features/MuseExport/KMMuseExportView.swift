import Combine
import SwiftUI

/// iOS-only settings page for the read-only Muse snapshot (docs/MUSE_SNAPSHOT.md). It follows
/// the BackupView flow: build a temporary file, then let the user save it with ShareLink.
/// There is no import path back into the app.
struct KMMuseExportView: View {
    let onBack: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.repositories) private var repositories
    @Environment(\.scenePhase) private var scenePhase
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
        .onAppear { model.refreshCurrentMonth() }
        .task { model.prepare() }
        // The upper limit is "this month", so a screen left open across midnight has to re-read it
        // when the app returns to the foreground and when the calendar day changes.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            model.refreshCurrentMonth()
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in
            model.refreshCurrentMonth()
        }
        // The day-change notice follows the device's time zone, so the page also wakes at the next
        // Asia/Tokyo month start. The task is cancelled when the page goes away.
        .task(id: model.currentMonth) {
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(model.secondsUntilNextMonth() + 1)) } catch { return }
                model.refreshCurrentMonth()
            }
        }
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

    @ViewBuilder
    private func monthRow(_ label: String, year: Binding<Int>, month: Binding<Int>,
                          yearID: String, monthID: String) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            // At accessibility sizes the label, year, and month no longer fit on one line, so they
            // stack in reading order instead of pushing past the screen edge.
            VStack(alignment: .leading, spacing: KMSpacing.space2) {
                monthLabel(label)
                yearPicker(label, year, id: yearID)
                monthPicker(label, month, year: year.wrappedValue, id: monthID)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            HStack(spacing: KMSpacing.space2) {
                monthLabel(label)
                Spacer(minLength: KMSpacing.space2)
                yearPicker(label, year, id: yearID)
                monthPicker(label, month, year: year.wrappedValue, id: monthID)
            }
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
        }
    }

    private func monthLabel(_ label: String) -> some View {
        Text(label)
            .font(KMTypography.text)
            .foregroundStyle(KMColor.text)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func yearPicker(_ label: String, _ year: Binding<Int>, id: String) -> some View {
        Picker("\(label)の年", selection: year) {
            ForEach(model.selectableYears, id: \.self) { value in
                Text("\(value)年").tag(value)
            }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .frame(minHeight: 48)
        .accessibilityLabel("\(label)の年")
        .accessibilityIdentifier(id)
        .disabled(model.isWorking)
    }

    private func monthPicker(_ label: String, _ month: Binding<Int>, year: Int, id: String) -> some View {
        Picker("\(label)の月", selection: month) {
            ForEach(model.selectableMonths(for: year), id: \.self) { value in
                Text("\(value)月").tag(value)
            }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .frame(minHeight: 48)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
        .disabled(model.isWorking)
    }

    private func share(_ url: URL) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space1) {
            Text(KMMuseExportPresentation.notSaved)
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
            // A running export will replace what the link points at, and the previous file may still
            // be open in the share sheet, so the link stays visible but cannot be used until it ends.
            ShareLink(item: url, preview: SharePreview(KMMuseExportPresentation.shareTitle)) {
                HStack(spacing: KMSpacing.space1) {
                    KMIcon(name: "upload", size: 18)
                    Text(KMMuseExportPresentation.shareButton)
                }
                .frame(minHeight: KMLayout.minimumHit)
            }
            .buttonStyle(KMButtonStyle(role: .secondary))
            .disabled(!model.canShare)
            .accessibilityLabel(model.canShare
                ? "書き出したファイルを保存・共有する"
                : "書き出し中は保存・共有できません")
            .accessibilityIdentifier("museExport.shareLink")
            if !model.canShare {
                Text(KMMuseExportPresentation.shareUnavailableWhileWorking)
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("museExport.shareUnavailable")
            }
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
