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
                .padding(KMSpacing.space4)
                .padding(.bottom, KMSpacing.space8)
                .frame(maxWidth: KMLayout.contentMax, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                KMBottomNavigation(selection: $tab, add: { showsChooser = true })
                    .frame(maxWidth: KMLayout.contentMax)
            }
            .accessibilityHidden(showsChooser)
            if showsChooser {
                KMBottomSheet(title: "何を記録しますか？", isPresented: $showsChooser) {
                    RecordChooserView { destination in
                        entry = destination
                        showsChooser = false
                    }
                }
                .zIndex(1)
            }
        }
        .font(KMTypography.text)
        .tint(KMColor.primary)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: showsChooser)
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
