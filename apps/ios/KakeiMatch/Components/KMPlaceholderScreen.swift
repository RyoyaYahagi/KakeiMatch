import SwiftUI

/// Explicitly not a migrated screen or a real empty-data state.
struct KMPlaceholderScreen: View {
    let title: String
    let identifier: String
    var body: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space6) {
            Text(title).font(KMTypography.heading).foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader)
            Text("準備中です。").font(KMTypography.text).foregroundStyle(KMColor.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, KMSpacing.space2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}
