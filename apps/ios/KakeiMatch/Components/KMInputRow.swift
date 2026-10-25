import SwiftUI

/// Ruled entry row, not a rounded system Form field. Callers provide a stable identifier.
struct KMInputRow: View {
    let label: String
    @Binding var value: String
    let identifier: String
    var hint: String = "任意"
    var isAmount = false
    var error: String? = nil
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space1) {
            HStack(spacing: KMSpacing.space3) {
                Text(label)
                    .font(KMTypography.body(13, weight: .medium))
                    .foregroundStyle(KMColor.muted)
                    .frame(width: KMLayout.entryKeyWidth, alignment: .leading)
                TextField(hint, text: $value)
                    .textFieldStyle(.plain)
                    .font(isAmount ? KMTypography.number(30, weight: .bold) : KMTypography.body(16, weight: .medium))
                    .keyboardType(isAmount ? .numberPad : .default)
                    .foregroundStyle(KMColor.text)
                    .focused($focused)
                    .accessibilityLabel(label)
                    .accessibilityIdentifier(identifier)
                    .frame(minHeight: KMLayout.minimumHit)
            }
            .frame(minHeight: isAmount ? 64 : KMLayout.entryHeight)
            .overlay(alignment: .bottom) {
                Rectangle().fill(error != nil ? KMColor.danger : focused ? KMColor.primary : KMColor.border)
                    .frame(height: focused || error != nil ? 2 : 1)
            }
            if let error {
                Text("! \(error)").font(KMTypography.note).foregroundStyle(KMColor.danger)
                    .accessibilityIdentifier(identifier + ".error")
            }
        }
    }
}
