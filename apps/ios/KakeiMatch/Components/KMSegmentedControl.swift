import SwiftUI

/// style.css .segmented. Options use stable IDs rather than localized labels.
struct KMSegment: Identifiable {
    let id: String
    let label: String
}

struct KMSegmentedControl: View {
    let options: [KMSegment]
    @Binding var selection: String
    let identifier: String

    var body: some View {
        HStack(spacing: KMSpacing.space1) {
            ForEach(options) { option in
                Button { selection = option.id } label: {
                    Text(option.label)
                        .font(KMTypography.body(14, weight: selection == option.id ? .bold : .medium))
                        .foregroundStyle(selection == option.id ? KMColor.text : KMColor.muted)
                        .frame(maxWidth: .infinity, minHeight: 36)
                        .background(selection == option.id ? KMColor.surface : .clear,
                                    in: RoundedRectangle(cornerRadius: KMRadius.sm))
                        .frame(minHeight: KMLayout.minimumHit)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == option.id ? .isSelected : [])
                .accessibilityIdentifier(identifier + "." + option.id)
            }
        }
        .padding(KMSpacing.space1)
        .background(KMColor.sunken, in: RoundedRectangle(cornerRadius: KMRadius.lg))
    }
}
