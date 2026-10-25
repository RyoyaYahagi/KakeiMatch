import SwiftUI

/// Display-only toast. Lifecycle / expiry and undo logic belong to the owning feature.
/// PWA deletion expiry is 10 seconds; keep that policy out of this visual component.
struct KMToast: View {
    let message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: KMSpacing.space2) {
            Text(message).font(KMTypography.text).foregroundStyle(KMColor.text)
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(KMButtonStyle(role: .secondary))
            }
        }
        .padding(.horizontal, KMSpacing.space3)
        .padding(.vertical, KMSpacing.space2)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: KMRadius.md))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("feedback.toast")
    }
}

struct KMBanner: View {
    let status: KMStatus
    let title: String
    var detail: String? = nil
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            KMStatusLabel(status: status, message: title)
            if let detail { Text(detail).font(KMTypography.text).foregroundStyle(KMColor.text) }
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(KMButtonStyle(role: .secondary))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(KMSpacing.space4)
        .background(status.background, in: RoundedRectangle(cornerRadius: KMRadius.lg))
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: KMRadius.lg))
        .accessibilityIdentifier("feedback.banner")
    }
}
