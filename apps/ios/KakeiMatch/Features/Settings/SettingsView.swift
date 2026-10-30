import LocalAuthentication
import SwiftUI

private enum KMSettingsPage {
    case root
    case theme
    case screenLock
    case budget
    case recurring
    case contact
    case categoryRules
    case categories
    case accounts
    case backup
}

struct SettingsView: View {
    var initialBudgetMonth: KMYearMonth? = nil
    var onBudgetBack: () -> Void = {}
    var onOpenMoneyForward: () -> Void = {}
    @Environment(\.repositories) private var repositories
    @State private var model = KMSettingsModel()
    @State private var page = KMSettingsPage.root
    @AppStorage(KMSettingsPresentation.screenLockEnabledKey) private var screenLockEnabled = false
    @State private var isAuthenticating = false
    @State private var screenLockMessage: String?

    init(initialBudgetMonth: KMYearMonth? = nil, onBudgetBack: @escaping () -> Void = {}, onOpenMoneyForward: @escaping () -> Void = {}) {
        self.initialBudgetMonth = initialBudgetMonth
        self.onBudgetBack = onBudgetBack
        self.onOpenMoneyForward = onOpenMoneyForward
        _page = State(initialValue: initialBudgetMonth == nil ? .root : .budget)
    }

    var body: some View {
        Group {
            switch page {
            case .root: settingsRoot
            case .theme: themePage
            case .screenLock: screenLockPage
            case .budget: KMBudgetView(initialMonth: initialBudgetMonth, onBack: { page = .root; onBudgetBack() })
            case .recurring: KMRecurringView(onBack: { page = .root })
            case .contact: ContactView(onBackToSettings: { page = .root })
            case .categoryRules: KMMasterManagementView(initialPage: .rules, onBack: { page = .root })
            case .categories: KMMasterManagementView(initialPage: .categories, onBack: { page = .root })
            case .accounts: KMMasterManagementView(initialPage: .accounts, onBack: { page = .root })
            case .backup: KMBackupView(onBack: { page = .root }, onDataRestored: {
                Task { await model.load(repositories) }
            }, onOpenMoneyForward: onOpenMoneyForward)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { if !model.loaded { await model.load(repositories) } }
    }

    private var settingsRoot: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("設定")
                .font(KMTypography.body(22, weight: .black))
                .foregroundStyle(KMColor.text)
                .padding(.top, KMSpacing.space2)
                .padding(.bottom, KMSpacing.space2)
                .accessibilityAddTraits(.isHeader)

            let sections = KMSettingsPresentation.sections(theme: model.settings.theme, screenLockEnabled: screenLockEnabled)
            ForEach(sections) { section in
                Text(section.title)
                    .font(KMTypography.body(13, weight: .bold))
                    .foregroundStyle(KMColor.muted)
                    .padding(.horizontal, KMSpacing.space1)
                    .padding(.top, KMSpacing.space5)
                    .padding(.bottom, KMSpacing.space2)
                    .accessibilityAddTraits(.isHeader)

                if section.title == "データ",
                   KMSettingsPresentation.shouldRemindBackup(lastExportAt: model.settings.lastExportAt, now: Date()) {
                    Text(KMSettingsPresentation.backupReminder)
                        .font(KMTypography.body(14))
                        .foregroundStyle(KMColor.warning)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, KMSpacing.space3)
                        .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
                        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
                        .accessibilityIdentifier("backup-reminder")
                }

                VStack(spacing: 0) {
                    Rectangle().fill(KMColor.border).frame(height: 1)
                    ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
                        settingsRow(row)
                        if index < section.rows.count - 1 {
                            Rectangle().fill(KMColor.border).frame(height: 1)
                        }
                    }
                    Rectangle().fill(KMColor.border).frame(height: 1)
                }
            }

            Text(KMSettingsPresentation.settingsFooter)
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, KMSpacing.space1)
                .padding(.vertical, KMSpacing.space4)
                .accessibilityIdentifier("settings.footer")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.screen")
    }

    private func settingsRow(_ row: KMSettingsRow) -> some View {
        Button {
            switch row.destination {
            case .theme: page = .theme
            case .screenLock: page = .screenLock
            case .budget: page = .budget
            case .recurring: page = .recurring
            case .contact:
                KMContactDiagnosticRecorder.shared.recordAction(.openContact, screen: .settings)
                KMContactDiagnosticRecorder.shared.recordScreen(.contact)
                page = .contact
            case .categoryRules: page = .categoryRules
            case .categories: page = .categories
            case .accounts: page = .accounts
            case .backup: page = .backup
            case .unimplemented: break
            }
        } label: {
            HStack(spacing: KMSpacing.space2) {
                Text(row.title)
                    .font(KMTypography.text)
                    .foregroundStyle(row.isDestructive ? KMColor.danger : KMColor.text)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: KMSpacing.space2)
                if let value = row.value {
                    Text(value)
                        .font(KMTypography.body(14))
                        .foregroundStyle(KMColor.muted)
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier(row.id == "settings.theme" ? "theme-row-value" : row.id == "settings.screenLock" ? "screen-lock-row-value" : row.id)
                }
                Text("›")
                    .font(KMTypography.body(22, weight: .regular))
                    .foregroundStyle(KMColor.muted)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(row.id)
        .accessibilityHint(row.destination == .unimplemented ? "移動先は別の画面の実装待ちです。" : "")
    }

    private var themePage: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            backButton
            Text("外観")
                .font(KMTypography.heading)
                .foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("settings-page-theme-title")

            Text("表示モード")
                .font(KMTypography.body(14))
                .foregroundStyle(KMColor.text)
                .padding(.top, KMSpacing.space2)

            Picker("表示モード", selection: Binding(
                get: { model.settings.theme },
                set: { selected in Task { await model.setTheme(selected) } }
            )) {
                ForEach(KMThemePreference.allCases, id: \.rawValue) { preference in
                    Text(KMSettingsPresentation.themeLabel(preference)).tag(preference)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .padding(.horizontal, KMSpacing.space3)
            .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.md))
            .overlay(RoundedRectangle(cornerRadius: KMRadius.md).stroke(KMColor.borderStrong, lineWidth: 1))
            .accessibilityLabel("表示モード")
            .accessibilityIdentifier("theme-preference")

            Text("「システム」は端末の外観設定に合わせて切り替えます。この設定はこの端末に保存されます。")
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("theme-description")

            if let error = model.error {
                Text(error)
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("theme-status")
            }
            Spacer(minLength: 0)
        }
    }

    private var screenLockPage: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            backButton
            Text("画面ロック")
                .font(KMTypography.heading)
                .foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("settings-page-lock-title")

            Text("端末内の画面ロック")
                .font(KMTypography.body(16, weight: .bold))
                .foregroundStyle(KMColor.text)
                .padding(.top, KMSpacing.space2)
                .accessibilityIdentifier("screen-lock-settings-title")

            Text("起動時と、1分以上アプリを離れた後に解除を求めます。オフラインで使えます。この機能は通常画面へのアクセスを防ぐもので、家計データの暗号化ではありません。iOSでは、この端末のFace IDまたはパスコードで本人確認します。")
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)

            Text(KMSettingsPresentation.screenLockStatus(isEnabled: screenLockEnabled))
                .font(KMTypography.text)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("screen-lock-settings-status")

            if screenLockEnabled {
                Button("今すぐロック") {
                    NotificationCenter.default.post(name: Notification.Name(KMSettingsPresentation.screenLockRequestNotificationName), object: nil)
                }
                .buttonStyle(KMButtonStyle(role: .text))
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("screen-lock-now")

                Button("画面ロックを無効にする") { authenticateScreenLockChange(enable: false) }
                    .buttonStyle(KMButtonStyle(role: .primary))
                    .disabled(isAuthenticating)
                    .accessibilityIdentifier("screen-lock-disable")
            } else {
                Button("画面ロックを有効にする") { authenticateScreenLockChange(enable: true) }
                    .buttonStyle(KMButtonStyle(role: .primary))
                    .disabled(isAuthenticating)
                    .accessibilityIdentifier("screen-lock-enable")
            }

            if let screenLockMessage {
                Text(screenLockMessage)
                    .font(KMTypography.note)
                    .foregroundStyle(screenLockMessage.contains("できません") || screenLockMessage.contains("キャンセル") ? KMColor.danger : KMColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("screen-lock-settings-message")
            }
            Spacer(minLength: 0)
        }
    }

    private var backButton: some View {
        Button { page = .root } label: {
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

    private func authenticateScreenLockChange(enable: Bool) {
        guard !isAuthenticating else { return }
        let context = LAContext()
        context.localizedCancelTitle = "キャンセル"
        var evaluationError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &evaluationError) else {
            screenLockMessage = screenLockUnavailableMessage(evaluationError)
            return
        }
        isAuthenticating = true
        screenLockMessage = nil
        Task {
            defer { isAuthenticating = false }
            do {
                let authenticated = try await context.evaluatePolicy(
                    .deviceOwnerAuthentication,
                    localizedReason: enable ? "画面ロックを有効にします" : "画面ロックを無効にします"
                )
                guard authenticated else {
                    screenLockMessage = "本人確認を完了できませんでした。設定は変更していません。"
                    return
                }
                screenLockEnabled = enable
                screenLockMessage = enable ? "画面ロックを有効にしました。" : "画面ロックを無効にしました。家計データは保持されています。"
            } catch {
                screenLockMessage = screenLockFailureMessage(error)
            }
        }
    }

    private func screenLockUnavailableMessage(_ error: NSError?) -> String {
        if let error, error.code == LAError.Code.passcodeNotSet.rawValue {
            return "この端末にパスコードが設定されていないため、画面ロックを使えません。端末の設定を確認してください。"
        }
        return "この端末では本人確認を利用できません。設定は変更していません。"
    }

    private func screenLockFailureMessage(_ error: Error) -> String {
        guard let authenticationError = error as? LAError else {
            return "本人確認を完了できませんでした。設定は変更していません。"
        }
        switch authenticationError.code {
        case .userCancel, .systemCancel, .appCancel:
            return "本人確認をキャンセルしました。設定は変更していません。"
        case .biometryLockout:
            return "Face IDを続けて確認できませんでした。パスコードでやり直してください。"
        default:
            return "本人確認を完了できませんでした。設定は変更していません。"
        }
    }
}

#Preview { KMFixturePreview("migration") { SettingsView() } }
