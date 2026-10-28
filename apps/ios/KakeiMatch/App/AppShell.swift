import SwiftUI

struct AppShell: View {
    @State private var tab: KMTab = .home
    @State private var showsChooser = false
    @State private var entry: KMEntryDestination? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.repositories) private var repositories
    @State private var reviewCount = 0
    @State private var reviewCountError: String?

    var body: some View {
        ZStack {
            KMColor.bg.ignoresSafeArea()
            VStack(spacing: 0) {
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
                            case .home: HomeView(onNavigate: { tab = $0 })
                            case .records: RecordsView()
                            case .reconciliation: ReconciliationView()
                            case .settings: SettingsView()
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
                KMBottomNavigation(selection: Binding(get: { tab }, set: { destination in
                    tab = destination
                    entry = nil // Reselecting the current tab also leaves an entry, like PWA.
                }), reviewCount: reviewCount, add: { showsChooser = true })
                    .frame(maxWidth: KMLayout.contentMax)
            }
        }
        .font(KMTypography.text)
        .tint(KMColor.primary)
        // A transparent native modal host traps accessibility focus without changing
        // the PWA-shaped sheet or removing the underlying page from the screen.
        .fullScreenCover(isPresented: $showsChooser) {
            KMBottomSheet(title: "何を記録しますか？", isPresented: $showsChooser) {
                RecordChooserView { destination in
                    entry = destination
                    showsChooser = false
                }
            }
            .presentationBackground(.clear)
        }
        .transaction { if reduceMotion { $0.disablesAnimations = true } }
        .onChange(of: tab) { _, _ in
            entry = nil
            Task { await refreshReviewCount() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await refreshReviewCount() } }
        }
        .task { await refreshReviewCount() }
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

    @ViewBuilder private func entryScreen(_ destination: KMEntryDestination) -> some View {
        switch destination {
        case .receipt, .photo: ReceiptView()
        case .expense: ManualEntryView()
        case .income: IncomeView()
        case .transfer: TransferView()
        }
    }
}
