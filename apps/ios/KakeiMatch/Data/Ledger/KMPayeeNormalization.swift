import Foundation

/// Actual 26.9.0 accounts/title + accounts/payees. Import title-casing is deliberately NOT NFKC.
/// The PWA's edit/readback comparison uses a different, ASCII-only lowercasing key.
enum KMPayeeNormalization {
    static func merchantKey(_ value: String) -> String {
        let normalized = value.precomposedStringWithCompatibilityMapping
            .split(whereSeparator: { $0.isWhitespace || $0 == "\u{FEFF}" }).joined(separator: " ")
        return String(normalized.unicodeScalars.map { scalar -> Character in
            Character(String(UnicodeScalar((65...90).contains(scalar.value) ? scalar.value + 32 : scalar.value)!))
        })
    }
    static func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}")))
    }
    private struct Rules: Decodable {
        var character: String
        var lowerCaseWords: [String]
        var specials: [String]
    }
    static func importedName(_ input: String) throws -> String {
        guard let url = Bundle.main.url(forResource: "payee-normalization", withExtension: "json") else {
            throw KMDataError.invalidData("支払先の正規化設定を読み込めません。")
        }
        let rules = try JSONDecoder().decode(Rules.self, from: Data(contentsOf: url))
        let character = rules.character
        let pattern = "(?:(?:(\\s?(?:^|[.\\(\\)!?;:\"-])\\s*)(\(character)))|(\(character)))(\(character)*[’']*\(character)*)"
        let regex = try NSRegularExpression(pattern: pattern)
        var result = trimmed(input).lowercased()
        let original = result as NSString
        for match in regex.matches(in: result, range: NSRange(location: 0, length: original.length)).reversed() {
            func group(_ index: Int) -> String {
                let range = match.range(at: index)
                return range.location == NSNotFound ? "" : original.substring(with: range)
            }
            let full = group(0), lead = group(1), forced = group(2), lower = group(3), rest = group(4)
            let replacement: String
            if full.first?.isWhitespace == true { replacement = String(full.dropFirst()) }
            else if full.first == "(" || full.first == ")" { continue }
            else { replacement = full }
            let value = forced.isEmpty && rules.lowerCaseWords.contains(lower + rest)
                ? replacement : lead + (lower.isEmpty ? forced : lower).uppercased() + rest
            result = (result as NSString).replacingCharacters(in: match.range, with: value)
        }
        for special in rules.specials {
            // JS \b is ASCII word-boundary, unlike Foundation's Unicode \b.
            let regex = try NSRegularExpression(pattern: "(?<![A-Za-z0-9_])" + NSRegularExpression.escapedPattern(for: special) + "(?![A-Za-z0-9_])", options: .caseInsensitive)
            result = regex.stringByReplacingMatches(in: result, range: NSRange(location: 0, length: (result as NSString).length), withTemplate: special)
        }
        return result
    }
}
