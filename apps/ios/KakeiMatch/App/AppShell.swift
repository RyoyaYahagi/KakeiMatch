import SwiftUI

struct AppShell: View {
    @State private var tab: KMTab = .home
    @State private var showsChooser = false
    @State private var entry: KMEntryDestination? = nil
    @State private var entryInitialValues: KMEntryInitialValues?
    @State private var budgetRouteMonth: KMYearMonth?
    @State private var settingsAccountsRoute = false
    @State private var settingsAIRoute = false
    @State private var recordsRefreshToken = 0
    @State private var deletionNotice = KMDeletionNoticeModel()
    @State private var moneyForwardRoute = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.repositories) private var repositories
    @Environment(\.driveSync) private var driveSync
    @State private var reviewCount = 0
    @State private var reviewCountError: String?
    @AppStorage(KMAppSettingsPreferences.themePreferenceKey) private var themePreferenceRaw = KMThemePreference.system.rawValue
    @State private var networkMonitor = KMNetworkMonitor()
    @State private var recordedInitialDiagnostic = false

    var body: some View {
        ZStack {
            KMColor.bg.ignoresSafeArea()
            VStack(spacing: 0) {
                deletionFeedback
                if let entry {
                    VStack(spacing: 0) {
                        if let reviewCountError {
                            KMBanner(status: .danger, title: "照合の確認件数を読み込めませんでした", detail: reviewCountError)
                                .accessibilityIdentifier("shell.reviewCountError")
                                .padding(.horizontal, KMSpacing.space4)
                        }
                        HStack {
                            Button("キャンセル") { self.entry = nil; entryInitialValues = nil; showsChooser = true }
                                .buttonStyle(KMButtonStyle(role: .text))
                                .accessibilityIdentifier("entry.cancel")
                            Spacer()
                        }
                        .padding(.horizontal, KMSpacing.space4)
                        entryScreen(entry)
                    }
                    .padding(.bottom, KMSpacing.space8)
                    .frame(maxWidth: KMLayout.contentMax, alignment: .leading)
                    .frame(maxWidth: .infinity)
                } else {
                    // The import screen pins its actions with safeAreaInset, so it needs its own
                    // scroll view instead of the shared ScrollView. Keep the settings page alive
                    // underneath so going back returns to the backup page, as in PWA.
                    ZStack(alignment: .top) {
                        ScrollView {
                            VStack(alignment: .leading, spacing: KMSpacing.space3) {
                                if let reviewCountError {
                                    KMBanner(status: .danger, title: "照合の確認件数を読み込めませんでした", detail: reviewCountError)
                                        .accessibilityIdentifier("shell.reviewCountError")
                                }
                                if let entry {
                                    HStack {
                                        Button("キャンセル") { self.entry = nil; entryInitialValues = nil; showsChooser = true }
                                            .buttonStyle(KMButtonStyle(role: .text))
                                            .accessibilityIdentifier("entry.cancel")
                                        Spacer()
                                    }
                                    entryScreen(entry)
                                } else {
                                    switch tab {
                                    case .home: HomeView(onNavigate: { tab = $0 }, onOpenBudget: { month in
                                        budgetRouteMonth = month
                                        tab = .settings
                                    })
                                    case .records: RecordsView(refreshToken: recordsRefreshToken,
                                        onOpenAccounts: { settingsAccountsRoute = true; tab = .settings },
                                        onDeleted: { deletionNotice.show($0) })
                                    case .reconciliation: ReconciliationView(onCreateRecord: { initialValues in
                                        entryInitialValues = initialValues
                                        entry = .expense
                                    })
                                    case .settings: SettingsView(initialBudgetMonth: budgetRouteMonth,
                                        initialAccounts: settingsAccountsRoute,
                                        initialAI: settingsAIRoute,
                                        onBudgetBack: { budgetRouteMonth = nil },
                                        onAccountsBack: { settingsAccountsRoute = false },
                                        onAIBack: { settingsAIRoute = false },
                                        onOpenMoneyForward: { moneyForwardRoute = true },
                                        onShowHome: { tab = .home })
                                    }
                                }
                            }
                            // On portrait iPhones the OS top inset already exceeds 16pt:
                            // PWA main uses max(16px, safe-area-inset-top), not their sum.
                            .padding(.horizontal, KMSpacing.space4)
                            .padding(.bottom, KMSpacing.space8)
                            .frame(maxWidth: KMLayout.contentMax, alignment: .leading)
                            .frame(maxWidth: .infinity)
                        }
                        .opacity(moneyForwardRoute ? 0 : 1)
                        .allowsHitTesting(!moneyForwardRoute)
                        .accessibilityHidden(moneyForwardRoute)

                        if moneyForwardRoute {
                            KMMoneyForwardView(onBack: { moneyForwardRoute = false })
                                .padding(.horizontal, KMSpacing.space4)
                                .frame(maxWidth: KMLayout.contentMax, alignment: .leading)
                                .frame(maxWidth: .infinity)
                                .background(KMColor.bg)
                        }
                    }
                }
                KMBottomNavigation(selection: Binding(get: { tab }, set: { destination in
                    if destination != .settings { settingsAccountsRoute = false; settingsAIRoute = false }
                    deletionNotice.clearTransientStatus()
                    tab = destination
                    entry = nil; entryInitialValues = nil // Reselecting the current tab also leaves an entry, like PWA.
                    moneyForwardRoute = false
                }), reviewCount: reviewCount, add: { showsChooser = true })
                    .frame(maxWidth: KMLayout.contentMax)
            }
        }
        .font(KMTypography.text)
        .tint(KMColor.primary)
        .preferredColorScheme(selectedColorScheme)
        // A transparent native modal host traps accessibility focus without changing
        // the PWA-shaped sheet or removing the underlying page from the screen.
        .fullScreenCover(isPresented: $showsChooser) {
            KMBottomSheet(title: "何を記録しますか？", isPresented: $showsChooser) {
                RecordChooserView { destination in
                    tab = .records
                    entryInitialValues = nil
                    entry = destination
                    showsChooser = false
                }
            }
            .presentationBackground(.clear)
        }
        .transaction { if reduceMotion { $0.disablesAnimations = true } }
        .onChange(of: tab) { _, newTab in
            let target = Self.diagnosticTarget(for: newTab)
            KMContactDiagnosticRecorder.shared.recordAction(target.action, screen: target.screen)
            KMContactDiagnosticRecorder.shared.recordScreen(target.screen)
            Task { await refreshReviewCount() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await refreshReviewCount() }
                Task { await driveSync?.syncIfNeeded(repositories: repositories) }
            }
        }
        .task {
            networkMonitor.start { online in
                Task { @MainActor in KMContactDiagnosticRecorder.shared.recordNetwork(online) }
            }
            if !recordedInitialDiagnostic {
                recordedInitialDiagnostic = true
                KMContactDiagnosticRecorder.shared.recordAction(.navigateHome, screen: .home)
                KMContactDiagnosticRecorder.shared.recordScreen(.home)
            }
            await refreshReviewCount()
            await deletionNotice.configure(repositories)
            // OFF returns before any repository read, so the default install
            // behaves exactly as before this feature existed. Running it in a
            // child task keeps a slow Drive request from delaying the first screen.
            Task { await driveSync?.syncIfNeeded(repositories: repositories) }
        }
    }

    /// PWA keeps the deletion notice above the tab content, so it remains while tabs change.
    @ViewBuilder private var deletionFeedback: some View {
        if deletionNotice.deletion != nil || deletionNotice.restored || deletionNotice.failure != nil {
            VStack(alignment: .leading, spacing: KMSpacing.space1) {
                if deletionNotice.deletion != nil {
                    KMToast(message: KMDeletionNoticeText.deleted,
                            actionTitle: KMDeletionNoticeText.undo,
                            trailingMessage: KMDeletionNoticeText.hint,
                            isBusy: deletionNotice.busy) {
                        Task { await undoDeletion() }
                    }
                    .accessibilityIdentifier("shell.deletionToast")
                } else if deletionNotice.restored {
                    // PWA replaces the toast text with this, and it has no timer.
                    KMToast(message: KMDeletionNoticeText.restored)
                        .accessibilityIdentifier("shell.deletionRestored")
                }
                if let failure = deletionNotice.failure {
                    Text(failure).font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("shell.deletionStatus")
                }
            }
            .padding(.horizontal, KMSpacing.space4)
            .padding(.top, KMSpacing.space2)
            .frame(maxWidth: KMLayout.contentMax, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    @MainActor private func undoDeletion() async {
        guard await deletionNotice.undo() else { return }
        // PWA's undo handler returns to the records page after restoring.
        entry = nil
        settingsAccountsRoute = false
        recordsRefreshToken += 1
        tab = .records
    }

    private static func diagnosticTarget(for tab: KMTab)
        -> (action: KMContactPresentation.DiagnosticAction, screen: KMContactPresentation.DiagnosticScreen) {
        switch tab {
        case .home: return (action: .navigateHome, screen: .home)
        case .records: return (action: .navigateRecords, screen: .records)
        case .reconciliation: return (action: .navigateReconciliation, screen: .reconciliation)
        case .settings: return (action: .navigateSettings, screen: .settings)
        }
    }

    private var selectedColorScheme: ColorScheme? {
        #if DEBUG
        if let override = testColorSchemeOverride { return override }
        #endif
        return switch KMThemePreference(rawValue: themePreferenceRaw) ?? .system {
        case .light: .light
        case .dark: .dark
        case .system: nil
        }
    }

    #if DEBUG
    private var testColorSchemeOverride: ColorScheme? {
        switch ProcessInfo.processInfo.environment["KM_UI_TEST_APPEARANCE"] {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }
    #endif

    @MainActor private func refreshReviewCount() async {
        guard let repositories else {
            reviewCountError = "家計簿を読み込めません。アプリを開き直してください。"
            return
        }
        do {
            let run = try await repositories.reconciliation.latestRun()
            let resolutions = try await repositories.reconciliation.resolutions()
            let suspected = try await repositories.reconciliation.suspectedStatements()
            reviewCount = KMReconciliationBadgeCount.calculate(run: run, resolutions: resolutions, suspected: suspected)
            reviewCountError = nil
        } catch {
            reviewCountError = "照合情報を再取得してください。\(error.localizedDescription)"
        }
    }

    @MainActor private func rerunAfterUnmatchedEntry() {
        Task {
            guard let repositories else {
                reviewCountError = "記録は保存されましたが、照合情報を読み込めませんでした。"
                entry = nil; entryInitialValues = nil
                return
            }
            do {
                let at = repositories.fixtureName == nil ? Date() : repositories.referenceDate
                _ = try await repositories.reconciliation.runReconciliation(id: UUID().uuidString, at: at)
                reviewCountError = nil
            } catch {
                reviewCountError = "記録は保存されましたが、照合をやり直せませんでした。\(error.localizedDescription)"
            }
            entry = nil; entryInitialValues = nil
            await refreshReviewCount()
        }
    }

    private func manualEntryKind(_ destination: KMEntryDestination) -> KMEntryKind? {
        switch destination {
        case .expense: .expense
        case .income: .income
        case .transfer: .transfer
        case .receipt, .photo, .payroll: nil
        }
    }

    @ViewBuilder private func entryScreen(_ destination: KMEntryDestination) -> some View {
        switch destination {
        case .receipt, .photo:
            ReceiptView(source: destination,
                onSaved: { entry = nil; tab = .records },
                onOpenAccount: { entry = nil; settingsAccountsRoute = false; settingsAIRoute = true; tab = .settings })
        case .expense: ManualEntryView(initialValues: entryInitialValues,
            onSaved: entryInitialValues == nil ? nil : rerunAfterUnmatchedEntry)
        case .income: IncomeView(onPayroll: { entry = .payroll })
        case .transfer: TransferView()
        case .payroll: PayrollView(onCancel: { entry = .income }, onSaved: { entry = nil; tab = .records })
        }
    }
}
