import Foundation

/// ECMAScript WhiteSpace + LineTerminator, not Foundation's broader whitespace set.
/// In particular JS includes BOM (FEFF) and excludes NEXT LINE (0085).
enum KMJSString {
    static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A,
             0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
        default: false
        }
    }

    static func trim(_ value: String) -> String {
        let scalars = value.unicodeScalars
        let start = scalars.firstIndex { !isWhitespace($0) } ?? scalars.endIndex
        let end = scalars.lastIndex { !isWhitespace($0) }.map { scalars.index(after: $0) } ?? start
        return String(scalars[start..<end])
    }

    static func normalizedLearningName(_ value: String) -> String {
        let trimmed = trim(value.precomposedStringWithCompatibilityMapping)
        var result = "", pendingSpace = false
        for scalar in trimmed.unicodeScalars {
            if isWhitespace(scalar) { pendingSpace = true; continue }
            if pendingSpace { result.append(" "); pendingSpace = false }
            result.unicodeScalars.append((65...90).contains(scalar.value) ? UnicodeScalar(scalar.value + 32)! : scalar)
        }
        return result.utf16.count <= 1_000 ? result : ""
    }
}
