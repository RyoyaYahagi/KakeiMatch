import SwiftUI

/// Settings page for the optional Google Drive snapshot save. The page never
/// imports the file back; it only shows connection state and sends once or
/// automatically. Copy follows KMMuseExportView and the settings list rules.
struct KMDriveSyncView: View {
    let onBack: () -> Void
    @Environment(\.repositories) private var repositories
    @State private var model: KMDriveSyncModel

    init(model: KMDriveSyncModel, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _model = State(initialValue: model)
    }

    /// Used by previews and by the settings page when no shared model was
    /// injected; the app root always injects one.
    init(now: @escaping () -> Date = { Date() }, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _model = State(initialValue: KMDriveSyncModel(now: now))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            backButton
            Text(KMDriveSyncPresentation.title)
                .font(KMTypography.heading)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("driveSync.title")

            Text(KMDriveSyncPresentation.description)
                .font(KMTypography.text)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("driveSync.description")

            Text(KMDriveSyncPresentation.sensitiveNotice)
                .font(KMTypography.text)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("driveSync.sensitiveNotice")

            Text(KMDriveSyncPresentation.readOnlyNotice)
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("driveSync.readOnlyNotice")

            autoSaveRow
            accountSection

            Button {
                Task { await model.syncNow(repositories: repositories) }
            } label: {
                Text(model.isSyncing ? KMDriveSyncPresentation.sending : KMDriveSyncPresentation.sendNow)
                    .frame(maxWidth: .infinity, minHeight: 52)
            }
            .buttonStyle(KMButtonStyle(role: .primary))
            .disabled(!model.canSendNow)
            .accessibilityLabel("今すぐGoogle Driveへ保存")
            .accessibilityIdentifier("driveSync.sendNow")

            if let status = model.statusText {
                Text(status)
                    .font(KMTypography.note)
                    .foregroundStyle(model.isFailureStatus ? KMColor.danger : KMColor.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("driveSync.status")
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("driveSync.screen")
        .task { await model.prepare() }
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

    private var autoSaveRow: some View {
        // The visible label belongs to the Toggle so the whole row is a 44pt
        // target, not just the switch at the trailing edge.
        Toggle(isOn: Binding(
            get: { model.isEnabled },
            set: { value in Task { await model.setEnabled(value) } })) {
            Text(KMDriveSyncPresentation.autoSaveTitle)
                .font(KMTypography.text)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
        .padding(.vertical, KMSpacing.space1)
        .accessibilityLabel("Google Driveへの自動保存")
        .accessibilityIdentifier("driveSync.toggle")
        .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    @ViewBuilder private var accountSection: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            if model.isSignedIn {
                VStack(alignment: .leading, spacing: 2) {
                    Text(KMDriveSyncPresentation.accountHeading)
                        .font(KMTypography.note)
                        .foregroundStyle(KMColor.muted)
                    if let email = model.accountEmail, !email.isEmpty {
                        Text(email)
                            .font(KMTypography.text)
                            .foregroundStyle(KMColor.text)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("driveSync.account")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Button {
                    model.signOut()
                } label: {
                    Text(KMDriveSyncPresentation.signOut)
                        .frame(minHeight: KMLayout.minimumHit)
                }
                .buttonStyle(KMButtonStyle(role: .secondary, width: .intrinsic))
                .accessibilityLabel("Google アカウントからサインアウト")
                .accessibilityIdentifier("driveSync.signOut")

                if !model.hasDriveScope {
                    Text("! \(KMDriveSyncPresentation.missingScope)")
                        .font(KMTypography.note)
                        .foregroundStyle(KMColor.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("driveSync.missingScope")
                }
            } else {
                Text(KMDriveSyncPresentation.noAccount)
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    Task { await model.signIn() }
                } label: {
                    Text(KMDriveSyncPresentation.signIn)
                        .frame(minHeight: KMLayout.minimumHit)
                }
                .buttonStyle(KMButtonStyle(role: .secondary, width: .intrinsic))
                .disabled(model.isAuthenticating)
                .accessibilityLabel("Google アカウントでサインイン")
                .accessibilityIdentifier("driveSync.signIn")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct KMDriveSyncModelKey: EnvironmentKey {
    static let defaultValue: KMDriveSyncModel? = nil
}

extension EnvironmentValues {
    /// One model for the process, injected at the app root. The optional value
    /// keeps previews and unit tests from needing Google Sign-In.
    var driveSync: KMDriveSyncModel? {
        get { self[KMDriveSyncModelKey.self] }
        set { self[KMDriveSyncModelKey.self] = newValue }
    }
}

#if DEBUG
#Preview { KMFixturePreview("migration") { KMDriveSyncView(onBack: {}) } }
#endif
