import SwiftUI

struct KMBottomNavigationBoundsKey: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil

    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = nextValue() ?? value
    }
}

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

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            tab(.home)
            tab(.records)
            ZStack(alignment: .top) {
                Color.clear.frame(maxWidth: .infinity, minHeight: KMLayout.navHeight)
                    .accessibilityHidden(true)
                    .allowsHitTesting(false)
                Text("追加").font(KMTypography.body(12, weight: .bold))
                    .foregroundStyle(KMColor.primary)
                    .padding(.top, 38)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: KMLayout.navHeight, alignment: .top)
            tab(.reconciliation)
            tab(.settings)
        }
        .padding(.horizontal, KMSpacing.space2)
        .frame(height: KMLayout.navHeight)
        .anchorPreference(key: KMBottomNavigationBoundsKey.self, value: .bounds) { $0 }
        // Keep the bar material in its original row; the raised tile owns its glass surface.
        .overlay(alignment: .top) {
            Rectangle().fill(KMColor.border).frame(height: 1)
        }
        .background {
            Color.clear
                .glassEffect(.regular, in: Rectangle())
                .ignoresSafeArea(edges: .bottom)
                .accessibilityHidden(true)
        }
    }

    private func tab(_ tab: KMTab) -> some View {
        Button { selection = tab } label: {
            VStack(spacing: 2) {
                KMIcon(name: tab.icon).padding(.top, 10)
                Text(tab.label).font(KMTypography.body(12, weight: selection == tab ? .bold : .regular))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
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
        .accessibilitySortPriority(tab.accessibilityOrder)
    }
}

private extension KMTab {
    var accessibilityOrder: Double {
        switch self {
        case .home: 5
        case .records: 4
        case .reconciliation: 2
        case .settings: 1
        }
    }
}
