import SwiftUI

/// Vector assets are verbatim ui-icons.ts paths: 24×24, 2pt round strokes.
/// Template rendering preserves currentColor semantics without replacing with SF Symbols.
struct KMIcon: View {
    let name: String
    var size: CGFloat = 24

    var body: some View {
        Image("km-\(name)")
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
