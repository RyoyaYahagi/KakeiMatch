import SwiftUI

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

    static func body(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }

    static func number(_ size: CGFloat = bodySize, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .monospaced).monospacedDigit()
    }
}
