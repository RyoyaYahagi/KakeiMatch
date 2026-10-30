import LocalAuthentication
import SwiftUI

struct AppShell: View {
    @State private var tab: KMTab = .home
    @State private var showsChooser = false
    @State private var entry: KMEntryDestination? = nil
    @State private var budgetRouteMonth: KMYearMonth?
    @State private var moneyForwardRoute = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.repositories) private var repositories
    @State private var reviewCount = 0
    @State private var reviewCountError: String?
    @AppStorage(KMAppSettingsPreferences.themePreferenceKey) private var themePreferenceRaw = KMThemePreference.system.rawValue
    @AppStorage(KMAppSettingsPreferences.screenLockEnabledKey) private var screenLockEnabled = false
    @State private var isScreenLocked: Bool
    @State private var backgroundedAt: Date?
    @State private var isAuthenticatingForUnlock = false
    @State private var screenLockError: String?

    init() {
        _isScreenLocked = State(initialValue:
            UserDefaults.standard.bool(forKey: KMAppSettingsPreferences.screenLockEnabledKey) || Self.uiTestScreenLockOverride)
    }

    var body: some View {
        ZStack {
            KMColor.bg.ignoresSafeArea()
            VStack(spacing: 0) {
                if let entry {
                    VStack(spacing: 0) {
                        if let reviewCountError {
                            KMBanner(status: .danger, title: "照合の確認件数を読み込めませんでした", detail: reviewCountError)
                                .accessibilityIdentifier("shell.reviewCountError")
                                .padding(.horizontal, KMSpacing.space4)
                        }
                        HStack {
                            Button("キャンセル") { self.entry = nil; showsChooser = true }
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
                                        Button("キャンセル") { self.entry = nil; showsChooser = true }
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
                                    case .records: RecordsView()
                                    case .reconciliation: ReconciliationView()
                                    case .settings: SettingsView(initialBudgetMonth: budgetRouteMonth, onBudgetBack: { budgetRouteMonth = nil }, onOpenMoneyForward: { moneyForwardRoute = true })
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
                    tab = destination
                    entry = nil // Reselecting the current tab also leaves an entry, like PWA.
                    moneyForwardRoute = false
                }), reviewCount: reviewCount, add: { showsChooser = true })
                    .frame(maxWidth: KMLayout.contentMax)
            }
            .opacity(isScreenLocked ? 0 : 1)
            .allowsHitTesting(!isScreenLocked)
            .accessibilityHidden(isScreenLocked)

            if isScreenLocked {
                screenLockOverlay
                    .zIndex(1)
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
                    entry = destination
                    showsChooser = false
                }
            }
            .presentationBackground(.clear)
        }
        .transaction { if reduceMotion { $0.disablesAnimations = true } }
        .onChange(of: tab) { _, _ in
            Task { await refreshReviewCount() }
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name(KMAppSettingsPreferences.screenLockRequestNotificationName))) { _ in
            lockScreen()
        }
        .onChange(of: screenLockEnabled) { _, enabled in
            if enabled {
                lockScreen()
            } else {
                isScreenLocked = false
                screenLockError = nil
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                backgroundedAt = Date()
            } else if phase == .active {
                if KMAppLockPresentation.shouldLock(isEnabled: screenLockEnabledForShell, backgroundedAt: backgroundedAt, now: Date()) {
                    lockScreen()
                }
                backgroundedAt = nil
                Task { await refreshReviewCount() }
            }
        }
        .task {
            if screenLockEnabledForShell { lockScreen() }
            await refreshReviewCount()
        }
    }

    private var screenLockOverlay: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            Text("画面をロックしています")
                .font(KMTypography.heading)
                .foregroundStyle(KMColor.text)
                .accessibilityIdentifier("shell.screen-lock-title")

            Text("続けるには、この端末のFace IDまたはパスコードで本人確認してください。")
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)

            if let screenLockError {
                Text(screenLockError)
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("shell.screen-lock-status")
            }

            Button("Face IDまたはパスコードで解除") {
                Task { await authenticateToUnlockScreen() }
            }
            .buttonStyle(KMButtonStyle(role: .primary))
            .disabled(isAuthenticatingForUnlock)
            .accessibilityIdentifier("screen-lock-unlock")
        }
        .padding(.horizontal, KMSpacing.space4)
        .padding(.top, KMSpacing.space6)
        .frame(maxWidth: KMLayout.contentMax, maxHeight: .infinity, alignment: .topLeading)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(KMColor.bg.ignoresSafeArea())
        .accessibilityElement(children: .contain)
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

    private var screenLockEnabledForShell: Bool {
        screenLockEnabled || Self.uiTestScreenLockOverride
    }

    private static var uiTestScreenLockOverride: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["KM_UI_TEST_SCREEN_LOCK_ENABLED"] == "1"
        #else
        false
        #endif
    }

    private func lockScreen() {
        guard screenLockEnabledForShell else { return }
        showsChooser = false
        isScreenLocked = true
        screenLockError = nil
        NotificationCenter.default.post(name: Notification.Name(KMAppSettingsPreferences.screenLockDidLockNotificationName), object: nil)
    }

    @MainActor private func authenticateToUnlockScreen() async {
        guard !isAuthenticatingForUnlock else { return }
        let context = LAContext()
        context.localizedCancelTitle = "キャンセル"
        var evaluationError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &evaluationError) else {
            screenLockError = screenLockUnavailableMessage(evaluationError)
            return
        }

        isAuthenticatingForUnlock = true
        screenLockError = nil
        defer { isAuthenticatingForUnlock = false }
        do {
            let authenticated = try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "KakeiMatchの画面ロックを解除します"
            )
            if authenticated {
                isScreenLocked = false
                screenLockError = nil
            } else {
                screenLockError = "本人確認を完了できませんでした。もう一度お試しください。"
            }
        } catch {
            screenLockError = screenLockFailureMessage(error)
        }
    }

    private func screenLockUnavailableMessage(_ error: NSError?) -> String {
        if let error, error.code == LAError.Code.passcodeNotSet.rawValue {
            return "この端末にパスコードが設定されていないため、画面ロックを解除できません。端末の設定を確認してください。"
        }
        return "この端末では本人確認を利用できません。画面ロックは有効なままです。"
    }

    private func screenLockFailureMessage(_ error: Error) -> String {
        guard let authenticationError = error as? LAError else {
            return "本人確認を完了できませんでした。画面ロックは有効なままです。"
        }
        switch authenticationError.code {
        case .userCancel, .systemCancel, .appCancel:
            return "本人確認をキャンセルしました。画面ロックは有効なままです。"
        case .biometryLockout:
            return "Face IDを続けて確認できませんでした。パスコードでやり直してください。"
        default:
            return "本人確認を完了できませんでした。画面ロックは有効なままです。"
        }
    }

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
            ReceiptView(source: destination, onSaved: { entry = nil; tab = .records })
        case .expense: ManualEntryView()
        case .income: IncomeView(onPayroll: { entry = .payroll })
        case .transfer: TransferView()
        case .payroll: PayrollView(onCancel: { entry = .income }, onSaved: { entry = nil; tab = .records })
        }
    }
}
