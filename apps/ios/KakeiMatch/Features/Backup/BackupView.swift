import SwiftUI
import UniformTypeIdentifiers

private struct KMBackupPendingImport: Identifiable {
    let id = UUID()
    let url: URL
    let displayName: String
}

/// PWA `settings-page-ledger` backup/restore page. The PWA exports `.kmb`; iOS exports an
/// iOS-only `.kmib` and can import both `.kmib` and PWA `.kmb`. Device-to-device sync is
/// intentionally absent. See apps/pwa/src/local-backup-ui.ts and docs/UX.md.
struct KMBackupView: View {
    let onBack: () -> Void
    var onDataRestored: () -> Void = {}
    var onOpenMoneyForward: () -> Void = {}
    @Environment(\.repositories) private var repositories
    @State private var model = KMBackupModel()
    @State private var showsAbout = false
    @State private var showsImporter = false
    @State private var pendingImport: KMBackupPendingImport?
    @State private var showsRestoreConfirm = false
    @State private var showsPreviousConfirm = false
    @State private var importError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            backButton
            Text(KMBackupPresentation.title)
                .font(KMTypography.heading)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("backup.title")

            Text(KMBackupPresentation.lastExportText(model.lastExportAt))
                .font(KMTypography.body(14))
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("backup.lastExport")

            actions

            if let importError {
                statusText(importError, isFailure: true, id: "backup.importError")
            }
            if model.isWorking {
                statusText(KMBackupPresentation.processing, isFailure: false, id: "backup.progress")
            }
            if let status = model.exportStatus {
                statusText(status, isFailure: status != KMBackupPresentation.exported, id: "backup.status")
            }
            if let status = model.importStatus {
                statusText(status, isFailure: status != KMBackupPresentation.restored, id: "backup.restoreStatus")
            }
            if let url = model.exportedFileURL {
                share(url)
            }

            aboutSection
                .alert("確認", isPresented: $showsPreviousConfirm) {
                    Button("キャンセル", role: .cancel) {}
                    Button("戻す") {
                        Task {
                            let restored = await model.restorePrevious(repositories)
                            if restored { onDataRestored() }
                        }
                    }
                } message: {
                    Text(KMBackupPresentation.previousConfirm)
                }

            storageSection
            moneyForwardEntry
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("backup.screen")
        .task { await model.load(repositories) }
        .fileImporter(isPresented: $showsImporter, allowedContentTypes: [.data], allowsMultipleSelection: false) { result in
            handlePickedFile(result)
        }
        .alert("復元の確認", isPresented: $showsRestoreConfirm, presenting: pendingImport) { item in
            Button("キャンセル", role: .cancel) { discardPendingImport() }
            Button("復元する") {
                Task {
                    let restored = await model.restore(from: item.url, repositories: repositories, confirmed: true)
                    discardPendingImport()
                    if restored { onDataRestored() }
                }
            }
        } message: { item in
            Text("\(KMBackupPresentation.restoreConfirm)\n\(item.displayName)")
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

    private var actions: some View {
        HStack(alignment: .center, spacing: KMSpacing.space2) {
            Button {
                Task { await model.export(repositories) }
            } label: {
                Text(KMBackupPresentation.exportButton)
                    .frame(maxWidth: .infinity, minHeight: 52)
            }
            .buttonStyle(KMButtonStyle(role: .primary))
            .disabled(model.isWorking)
            .accessibilityIdentifier("backup.export")

            Button {
                importError = nil
                showsImporter = true
            } label: {
                HStack(spacing: KMSpacing.space1) {
                    KMIcon(name: "upload", size: 18)
                    Text(KMBackupPresentation.restoreButton)
                }
                .frame(minHeight: KMLayout.minimumHit)
            }
            .buttonStyle(KMButtonStyle(role: .secondary))
            .disabled(model.isWorking)
            .accessibilityLabel("バックアップを復元する")
            .accessibilityIdentifier("backup.import")
        }
    }

    private func share(_ url: URL) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space1) {
            Text(KMBackupPresentation.exportNotSaved)
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
            ShareLink(item: url, preview: SharePreview(KMBackupPresentation.title)) {
                HStack(spacing: KMSpacing.space1) {
                    KMIcon(name: "upload", size: 18)
                    Text(KMBackupPresentation.shareButton)
                }
                .frame(minHeight: KMLayout.minimumHit)
            }
            .buttonStyle(KMButtonStyle(role: .secondary))
            .accessibilityIdentifier("backup.share")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var aboutSection: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            if model.canRestorePrevious {
                Button {
                    showsPreviousConfirm = true
                } label: {
                    HStack(spacing: KMSpacing.space1) {
                        KMIcon(name: "repeat", size: 18)
                        Text(KMBackupPresentation.previousButton)
                    }
                    .frame(minHeight: KMLayout.minimumHit)
                }
                .buttonStyle(KMButtonStyle(role: .secondary))
                .disabled(model.isWorking)
                .accessibilityIdentifier("backup.restorePrevious")
            }
            if let status = model.previousStatus {
                statusText(status, isFailure: status != KMBackupPresentation.previousRestored, id: "backup.previousStatus")
            }

            VStack(spacing: 0) {
                if model.canRestorePrevious || model.previousStatus != nil {
                    Rectangle().fill(KMColor.border).frame(height: 1).padding(.bottom, KMSpacing.space2)
                }
                Button {
                    showsAbout.toggle()
                } label: {
                    HStack(spacing: KMSpacing.space2) {
                        Text(showsAbout ? "▾" : "▸")
                            .font(KMTypography.body(15, weight: .bold))
                            .foregroundStyle(KMColor.primary)
                            .frame(width: 16)
                            .accessibilityHidden(true)
                        Text(KMBackupPresentation.aboutSummary)
                            .font(KMTypography.body(16, weight: .medium))
                            .foregroundStyle(KMColor.primary)
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, minHeight: KMLayout.minimumHit, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("backup.about")
            }
            .padding(.top, model.canRestorePrevious || model.previousStatus != nil ? KMSpacing.space2 : 0)

            if showsAbout {
                VStack(alignment: .leading, spacing: KMSpacing.space2) {
                    disclosureText(KMBackupPresentation.exportedContent, id: "backup.about.exportedContent")
                    disclosureText(KMBackupPresentation.formatNotice, id: "backup.about.format")
                    disclosureText(KMBackupPresentation.iosOnlyNotice, id: "backup.about.iosOnly")
                    disclosureText(KMBackupPresentation.restoreNotice, id: "backup.about.restore")
                    disclosureText(KMBackupPresentation.restoreFormats, id: "backup.about.restoreFormats")
                }
            }
        }
        .padding(.vertical, KMSpacing.space3)
        .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private var storageSection: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text(KMBackupPresentation.storageTitle)
                .font(KMTypography.body(16, weight: .bold))
                .foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("backup.storage-title")
            HStack(spacing: KMSpacing.space2) {
                KMIcon(name: "phone", size: 24)
                    .foregroundStyle(KMColor.primary)
                Text(KMBackupPresentation.storageDevice)
                    .font(KMTypography.body(18, weight: .bold))
                    .foregroundStyle(KMColor.text)
                    .accessibilityIdentifier("backup.storage-device")
            }
            Text(KMBackupPresentation.storageDescription)
                .font(KMTypography.text)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
            Text(KMBackupPresentation.storageCloud)
                .font(KMTypography.text)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
            Text(KMBackupPresentation.storageRisk)
                .font(KMTypography.text)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, KMSpacing.space1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, KMSpacing.space4)
        .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    /// PWA appends the MoneyForward entry to the backup page, below the storage section.
    private var moneyForwardEntry: some View {
        Button(action: onOpenMoneyForward) {
            HStack(spacing: KMSpacing.space2) {
                Text("マネーフォワードから移行")
                    .font(KMTypography.text)
                    .foregroundStyle(KMColor.text)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                Text("›")
                    .font(KMTypography.body(22, weight: .regular))
                    .foregroundStyle(KMColor.muted)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
        .accessibilityIdentifier("settings.moneyforward")
    }

    private func disclosureText(_ value: String, id: String) -> some View {
        Text(value)
            .font(KMTypography.body(14))
            .foregroundStyle(KMColor.muted)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(id)
    }

    private func statusText(_ value: String, isFailure: Bool, id: String) -> some View {
        Text(value)
            .font(KMTypography.note)
            .foregroundStyle(isFailure ? KMColor.danger : KMColor.primary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(id)
    }

    /// The picker URL is security-scoped; copy it into our temp directory while the scope is
    /// open, so the confirmation alert can wait without holding Files access. The original
    /// file is never modified or deleted.
    private func handlePickedFile(_ result: Result<[URL], any Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let directory = FileManager.default.temporaryDirectory
                    .appendingPathComponent("KakeiMatchImport-\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
                let copy = directory.appendingPathComponent(url.lastPathComponent)
                try FileManager.default.copyItem(at: url, to: copy)
                importError = nil
                pendingImport = KMBackupPendingImport(url: copy, displayName: url.lastPathComponent)
                showsRestoreConfirm = true
            } catch {
                importError = KMBackupPresentation.importFailure(error)
            }
        case .failure(let error):
            if (error as? CocoaError)?.code == .userCancelled { return }
            importError = KMBackupPresentation.importFailure(error)
        }
    }

    private func discardPendingImport() {
        if let pendingImport {
            try? FileManager.default.removeItem(at: pendingImport.url.deletingLastPathComponent())
        }
        pendingImport = nil
    }
}

#Preview { KMFixturePreview("migration") { KMBackupView(onBack: {}) } }
