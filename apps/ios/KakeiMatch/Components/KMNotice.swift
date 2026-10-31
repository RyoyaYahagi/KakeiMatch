import SwiftUI

/// Display-only toast. Lifecycle / expiry and undo logic belong to the owning feature.
/// PWA deletion expiry is 10 seconds; keep that policy out of this visual component.
struct KMToast: View {
    let message: String
    var actionTitle: String? = nil
    /// PWA's deletion toast places this after the undo button.
    var trailingMessage: String? = nil
    var isBusy = false
    var action: (() -> Void)? = nil

    var body: some View {
        // PWA uses flex-wrap: at 390px the hint moves to the second line.
        KMWrappingHStack(spacing: KMSpacing.space2) {
            Text(message).font(KMTypography.text).foregroundStyle(KMColor.text)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(KMButtonStyle(role: .secondary))
                    .disabled(isBusy)
            }
            if let trailingMessage {
                Text(trailingMessage).font(KMTypography.text).foregroundStyle(KMColor.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, KMSpacing.space3)
        .padding(.vertical, KMSpacing.space2)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: KMRadius.md))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("feedback.toast")
    }
}

/// Minimal flex-wrap layout: items keep their ideal size and move to the next line.
private struct KMWrappingHStack: Layout {
    var spacing: CGFloat

    private struct Line {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        let lines = lines(subviews: subviews, maxWidth: maxWidth)
        let width = lines.map(\.width).max() ?? 0
        let height = lines.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, lines.count - 1))
        return CGSize(width: min(width, maxWidth), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in lines(subviews: subviews, maxWidth: bounds.width) {
            var x = bounds.minX
            for index in line.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(
                    at: CGPoint(x: x, y: y + (line.height - size.height) / 2),
                    proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += line.height + spacing
        }
    }

    private func lines(subviews: Subviews, maxWidth: CGFloat) -> [Line] {
        var result: [Line] = []
        var current = Line()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if !current.indices.isEmpty && current.width + spacing + size.width > maxWidth {
                result.append(current)
                current = Line()
            }
            if !current.indices.isEmpty { current.width += spacing }
            current.indices.append(index)
            current.width += size.width
            current.height = max(current.height, size.height)
        }
        if !current.indices.isEmpty { result.append(current) }
        return result
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
