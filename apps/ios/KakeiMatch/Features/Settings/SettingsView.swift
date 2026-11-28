import SwiftUI
import UIKit

private enum KMSettingsPage: Equatable {
    case root
    case theme
    case budget
    case recurring
    case categoryRules
    case categories
    case accounts
    case reconciliationAutoMatch
    case backup
    case museExport
    case driveSync
    case ai
    case appInfo
}

struct SettingsView: View {
    var initialBudgetMonth: KMYearMonth? = nil
    var initialAccounts = false
    var onBudgetBack: () -> Void = {}
    var onAccountsBack: () -> Void = {}
    var onOpenMoneyForward: () -> Void = {}
    @Environment(\.repositories) private var repositories
    @Environment(\.driveSync) private var driveSync
    @State private var model = KMSettingsModel()
    @State private var auth = KMNativeAuthModel()
    @State private var page = KMSettingsPage.root
    @State private var supportIdCopied = false

    init(initialBudgetMonth: KMYearMonth? = nil, initialAccounts: Bool = false,
         onBudgetBack: @escaping () -> Void = {}, onAccountsBack: @escaping () -> Void = {},
         onOpenMoneyForward: @escaping () -> Void = {}) {
        self.initialBudgetMonth = initialBudgetMonth
        self.initialAccounts = initialAccounts
        self.onBudgetBack = onBudgetBack
        self.onAccountsBack = onAccountsBack
        self.onOpenMoneyForward = onOpenMoneyForward
        let initialPage: KMSettingsPage = initialAccounts ? .accounts
            : (initialBudgetMonth == nil ? .root : .budget)
        _page = State(initialValue: initialPage)
    }

    var body: some View {
        Group {
            switch page {
            case .root: settingsRoot
            case .theme: themePage
            case .reconciliationAutoMatch: reconciliationAutoMatchPage
            case .appInfo: KMAppInformationView(onBack: { page = .root })
            case .budget: KMBudgetView(initialMonth: initialBudgetMonth, onBack: { page = .root; onBudgetBack() })
            case .recurring: KMRecurringView(onBack: { page = .root })
            case .categoryRules: KMMasterManagementView(initialPage: .rules, onBack: { page = .root })
            case .categories: KMMasterManagementView(initialPage: .categories, onBack: { page = .root })
            case .accounts: KMMasterManagementView(initialPage: .accounts, onBack: { page = .root; onAccountsBack() })
            case .backup: KMBackupView(onBack: { page = .root }, onDataRestored: {
                Task { await model.load(repositories) }
            }, onOpenMoneyForward: onOpenMoneyForward)
            case .museExport: KMMuseExportView(now: museExportNow, onBack: { page = .root })
            case .driveSync:
                if let driveSync {
                    KMDriveSyncView(model: driveSync, onBack: { page = .root })
                } else {
                    KMDriveSyncView(now: museExportNow, onBack: { page = .root })
                }
            case .ai: KMNativeAuthView(model: auth, onBack: { page = .root })
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task {
            if !model.loaded { await model.load(repositories) }
            await auth.refresh()
        }
        .onChange(of: page) { _, value in
            guard value == .root else { return }
            supportIdCopied = false
            Task { await auth.refresh() }
        }
        .onChange(of: auth.supportId) { _, _ in
            supportIdCopied = false
        }
    }

    /// UI fixtures keep the bundled reference date; a normal launch uses the real clock so a
    /// screen opened after a month or year rollover does not show the launch month as "today".
    private var museExportNow: () -> Date {
        guard let repositories, repositories.fixtureName != nil else { return { Date() } }
        let reference = repositories.referenceDate
        return { KMFixtureClock.now(reference: reference) }
    }

    private var settingsRoot: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("設定")
                .font(KMTypography.body(22, weight: .black))
                .foregroundStyle(KMColor.text)
                .padding(.top, KMSpacing.space2)
                .padding(.bottom, KMSpacing.space2)
                .accessibilityAddTraits(.isHeader)

            let sections = KMSettingsPresentation.sections(
                theme: model.settings.theme,
                aiUsageValue: auth.settingsRowValue,
                driveSyncValue: KMSettingsPresentation.driveSyncValue(isEnabled: driveSync?.isEnabled == true),
                reconciliationAutoMatchValue: KMSettingsPresentation.reconciliationAutoMatchValue(
                    requireSamePaymentSource: model.settings.requireSamePaymentSourceForAutoMatch),
                supportId: auth.supportId
            )
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
            case .reconciliationAutoMatch: page = .reconciliationAutoMatch
            case .budget: page = .budget
            case .recurring: page = .recurring
            case .categoryRules: page = .categoryRules
            case .categories: page = .categories
            case .accounts: page = .accounts
            case .backup: page = .backup
            case .museExport: page = .museExport
            case .driveSync: page = .driveSync
            case .ai: page = .ai
            case .appInfo: page = .appInfo
            case .copySupportId:
                if let value = row.value {
                    UIPasteboard.general.string = value
                    supportIdCopied = true
                }
            case .unimplemented: break
            }
        } label: {
            if row.destination == .copySupportId, let value = row.value {
                VStack(alignment: .leading, spacing: KMSpacing.space1) {
                    HStack(spacing: KMSpacing.space2) {
                        Text(row.title)
                            .font(KMTypography.text)
                            .foregroundStyle(KMColor.text)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: KMSpacing.space2)
                        Text(supportIdCopied ? "コピーしました" : "コピー")
                            .font(KMTypography.body(14, weight: .medium))
                            .foregroundStyle(supportIdCopied ? KMColor.success : KMColor.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(value)
                        .font(KMTypography.number(13, weight: .regular))
                        .foregroundStyle(KMColor.muted)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, KMSpacing.space2)
                .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                .contentShape(Rectangle())
            } else {
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
                            .accessibilityIdentifier(row.id == "settings.theme" ? "theme-row-value" : row.id)
                    }
                    Text("›")
                        .font(KMTypography.body(22, weight: .regular))
                        .foregroundStyle(KMColor.muted)
                        .accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(row.id)
        .accessibilityHint(row.destination == .unimplemented ? "移動先は別の画面の実装待ちです。" : row.destination == .copySupportId ? "タップしてサポートIDをコピーします" : "")
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

    private var reconciliationAutoMatchPage: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            backButton
            Text("照合の自動一致")
                .font(KMTypography.heading)
                .foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("settings-page-reconciliation-title")

            Toggle("支払元が一致した記録だけ自動で一致させる", isOn: Binding(
                get: { model.settings.requireSamePaymentSourceForAutoMatch },
                set: { enabled in Task { await model.setRequireSamePaymentSourceForAutoMatch(enabled) } }
            ))
            .tint(KMColor.primary)
            .frame(minHeight: KMLayout.minimumHit)
            .accessibilityIdentifier("reconciliation-auto-match-toggle")

            Text("オフのときは、金額・日付・店名が合えば自動で一致させます。オンにすると、支払元が一致した記録だけを自動で一致させ、ほかは確認へ回します。候補の表示と手動の照合は変わりません。変更は次に照合したときに反映されます。")
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("reconciliation-auto-match-description")

            if let error = model.error {
                Text(error)
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("reconciliation-auto-match-status")
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
}

#if DEBUG
#Preview { KMFixturePreview("migration") { SettingsView() } }
#endif
