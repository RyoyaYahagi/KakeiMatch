import SwiftUI

enum KMStatus: CaseIterable {
    case success, warning, missing, danger
    var label: String {
        switch self {
        case .success: "済"
        case .warning: "要確認"
        case .missing: "記録なし"
        case .danger: "反映できませんでした"
        }
    }
    var symbol: String {
        switch self { case .success: "✓"; case .warning: "△"; case .missing, .danger: "!" }
    }
    var foreground: Color {
        switch self {
        case .success: KMColor.success
        case .warning: KMColor.warning
        case .missing: KMColor.missing
        case .danger: KMColor.danger
        }
    }
    var background: Color {
        switch self {
        case .success: KMColor.successSoft
        case .warning: KMColor.warningSoft
        case .missing: KMColor.missingSoft
        case .danger: KMColor.dangerSoft
        }
    }
}

struct KMStatusLabel: View {
    let status: KMStatus
    var message: String? = nil
    var body: some View {
        HStack(spacing: KMSpacing.space1) {
            Text(status.symbol)
                .font(KMTypography.body(13, weight: .bold))
                .frame(width: 20, height: 20)
                .background(status.background, in: Circle())
            Text(message ?? status.label).font(KMTypography.note)
        }
        .foregroundStyle(status.foreground)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(message ?? status.label)
    }
}

struct KMCompletedStamp: View {
    var body: some View {
        Text("済")
            .font(KMTypography.body(13, weight: .bold))
            .foregroundStyle(KMColor.success)
            .frame(width: 26, height: 26)
            .overlay(Circle().stroke(KMColor.success, lineWidth: 1.5))
            .rotationEffect(.degrees(-10))
            .accessibilityLabel("一致")
    }
}
