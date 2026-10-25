import SwiftUI

enum KMTab: String, CaseIterable {
    case home, records, reconciliation, settings
    var label: String {
        switch self { case .home: "ホーム"; case .records: "記録"; case .reconciliation: "照合"; case .settings: "設定" }
    }
    var icon: String { rawValue }
    /// The PWA uses DOM ids, not data-testid, on these buttons.
    var identifier: String {
        switch self {
        case .home: "home-tab"
        case .records: "receipt-tab"
        case .reconciliation: "reconciliation-tab"
        case .settings: "settings-tab"
        }
    }
}

/// Five equal slots, four destinations. Add never changes the active tab.
struct KMBottomNavigation: View {
    @Binding var selection: KMTab
    var reviewCount = 0
    let add: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            tab(.home)
            tab(.records)
            Button(action: add) {
                ZStack(alignment: .top) {
                    KMIcon(name: "add", size: 28)
                        .foregroundStyle(KMColor.onPrimary)
                        .frame(width: KMLayout.addSize, height: KMLayout.addSize)
                        .glassEffect(.regular.tint(KMColor.primary).interactive(),
                                     in: RoundedRectangle(cornerRadius: KMRadius.xl))
                        .offset(y: -22)
                    Text("追加").font(KMTypography.body(12, weight: .bold))
                        .foregroundStyle(KMColor.primary).padding(.top, 38)
                }
                .frame(maxWidth: .infinity, minHeight: KMLayout.navHeight, alignment: .top)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("記録を追加")
            .accessibilityIdentifier("add-record")
            tab(.reconciliation)
            tab(.settings)
        }
        .padding(.horizontal, KMSpacing.space2)
        .frame(height: KMLayout.navHeight)
        .glassEffect(.regular, in: Rectangle())
        .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("アプリ")
    }

    private func tab(_ tab: KMTab) -> some View {
        Button { selection = tab } label: {
            VStack(spacing: 2) {
                KMIcon(name: tab.icon).padding(.top, 10)
                Text(tab.label).font(KMTypography.body(12, weight: selection == tab ? .bold : .regular))
            }
            .foregroundStyle(selection == tab ? KMColor.primary : KMColor.muted)
            .frame(maxWidth: .infinity, minHeight: 58, alignment: .top)
            .overlay(alignment: .top) {
                if selection == tab { RoundedRectangle(cornerRadius: 3).fill(KMColor.primary).frame(width: 24, height: 3) }
            }
            .overlay(alignment: .top) {
                if tab == .reconciliation && reviewCount > 0 {
                    Text(String(reviewCount)).font(KMTypography.number(12, weight: .bold))
                        .foregroundStyle(KMColor.surface)
                        .padding(.horizontal, 6).frame(minWidth: 20, minHeight: 20)
                        .background(KMColor.warning, in: Capsule())
                        .offset(x: 16, y: 2).accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tab == .reconciliation && reviewCount > 0 ? "照合（確認が必要 \(reviewCount)件）" : tab.label)
        .accessibilityAddTraits(selection == tab ? .isSelected : [])
        .accessibilityIdentifier(tab.identifier)
    }
}
