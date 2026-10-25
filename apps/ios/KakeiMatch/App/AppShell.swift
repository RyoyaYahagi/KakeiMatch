import SwiftUI

struct AppShell: View {
    @State private var tab: KMTab = .home
    @State private var showsChooser = false
    @State private var entry: KMEntryDestination? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            KMColor.bg.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: KMSpacing.space3) {
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
                        case .home: HomeView()
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
            .safeAreaInset(edge: .bottom, spacing: 0) {
                KMBottomNavigation(selection: Binding(get: { tab }, set: { destination in
                    tab = destination
                    entry = nil // Reselecting the current tab also leaves an entry, like PWA.
                }), add: { showsChooser = true })
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
        .onChange(of: tab) { _, _ in entry = nil }
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
