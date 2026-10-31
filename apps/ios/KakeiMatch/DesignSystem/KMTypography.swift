import SwiftUI

/// A PWA-sized font token that scales with Dynamic Type.
///
/// The PWA size is the base. At the default (Large) content size the base is
/// rendered unchanged, smaller user settings never shrink below it, and larger
/// settings scale the base with the text style that matches the role.
struct KMFont: Sendable {
    let size: CGFloat
    let weight: Font.Weight
    let design: Font.Design
    let monospacedDigits: Bool
    let relativeTo: Font.TextStyle

    init(size: CGFloat, weight: Font.Weight = .regular,
         design: Font.Design = .default, monospacedDigits: Bool = false) {
        self.size = size
        self.weight = weight
        self.design = design
        self.monospacedDigits = monospacedDigits
        self.relativeTo = Self.textStyle(for: size)
    }

    func weight(_ weight: Font.Weight) -> KMFont {
        KMFont(size: size, weight: weight, design: design, monospacedDigits: monospacedDigits)
    }

    /// Maps PWA pixel sizes to the nearest system text style. Large styles scale
    /// less aggressively at accessibility sizes, which keeps display numbers and
    /// the hero amount from outgrowing the screen.
    private static func textStyle(for size: CGFloat) -> Font.TextStyle {
        switch size {
        case 34...: .largeTitle
        case 28..<34: .title
        case 20..<28: .title3
        case 17..<20: .body
        case 16..<17: .callout
        case 15..<16: .subheadline
        case 13..<15: .footnote
        case 12..<13: .caption
        default: .caption2
        }
    }
}

private struct KMFontModifier: ViewModifier {
    private let base: CGFloat
    private let weight: Font.Weight
    private let design: Font.Design
    private let monospacedDigits: Bool
    @ScaledMetric private var scaledSize: CGFloat

    init(_ font: KMFont) {
        base = font.size
        weight = font.weight
        design = font.design
        monospacedDigits = font.monospacedDigits
        _scaledSize = ScaledMetric(wrappedValue: font.size, relativeTo: font.relativeTo)
    }

    func body(content: Content) -> some View {
        // PWA sizes are the floor: a smaller system setting must look like Large.
        let size = max(base, scaledSize)
        let resolved = Font.system(size: size, weight: weight, design: design)
        content.font(monospacedDigits ? resolved.monospacedDigit() : resolved)
    }
}

extension View {
    /// Keeps the existing `.font(KMTypography…)` call sites while scaling them.
    /// The separate `KMFont` argument selects this overload over SwiftUI's `Font`.
    nonisolated func font(_ font: KMFont) -> some View {
        modifier(KMFontModifier(font))
    }
}

/// --font-body: -apple-system maps to .system (SF / Japanese system fallback).
/// --font-num: ui-monospace / SF Mono maps to .system(design: .monospaced).
/// CSS rem is 16 pt. Sizes below mirror the actual component selectors.
enum KMTypography {
    static let heroSize: CGFloat = 40
    static let inputAmountSize: CGFloat = 30
    static let headingSize: CGFloat = 22
    static let bodySize: CGFloat = 16
    static let noteSize: CGFloat = 13
    static let navSize: CGFloat = 12
    static let heading = body(headingSize, weight: .black)
    static let text = body(bodySize)
    static let note = body(noteSize)

    static func body(_ size: CGFloat, weight: Font.Weight = .regular) -> KMFont {
        KMFont(size: size, weight: weight)
    }

    static func number(_ size: CGFloat = bodySize, weight: Font.Weight = .semibold) -> KMFont {
        KMFont(size: size, weight: weight, design: .monospaced, monospacedDigits: true)
    }
}
