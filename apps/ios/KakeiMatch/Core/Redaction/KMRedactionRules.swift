import Foundation

enum KMRedactionRules {
    private static let sensitiveLabel = #"(?:会員(?:番号|No\.?|ID)|承認(?:番号|No\.?)|レシート(?:番号|No\.?)|端末(?:番号|No\.?|ID)|取引(?:番号|No\.?)|伝票(?:番号|No\.?)|カード番号|下4桁|電話番号|郵便番号|(?<![A-Z])Member\s*(?:ID|No\.?)|(?<![A-Z])TEL)"#
    private static let labelSeparator = #"[\h:#]*"#
    private static let labeledValue = #"[A-Z0-9+(*][A-Z0-9+() *./-]*"#
    private static let sensitive = [
        #"(?i)(?:https?://|www\.)[^\s]+"#,
        #"(?i)[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}"#,
        #"(?i)\b[a-z0-9\-]+(?:\.[a-z0-9\-]+)*\.(?:jp|com|net|org|co|io)(?:/\S*)?\b"#,
        #"(?<!\d)(?:(?:\+81[ -]?\d|0\d{1,4})[ -]?(?:\(\s*\d{1,4}\s*\)[ -]*|\d{1,4}[ -])|\(\s*0\d{1,4}\s*\)[ -]*\d{1,4}[ -]*)\d{4}(?!\d)"#,
        #"(?<!\d)\d{3}[-－]\d{4}(?!\d)"#,
        #"[^\s:：]+(?:[ 　][^\s:：]+)?(?=[ 　]*[様殿](?:\s|$))"#,
        #"[*＊Xx●•]{2,}(?:[ -]*[*＊Xx●•]+)*[ -]*\d{1,6}"#,
        #"(?i)(?:(?<=visa)|(?<=mastercard)|(?<=jcb)|(?<=amex)|(?<=diners)|(?<=カード))[ :：#*＊Xx・-]*\d{4}(?!\d)"#,
        sensitiveLabel + labelSeparator + labeledValue,
    ]
    private static let labelOnly = sensitiveLabel + labelSeparator + #"$"#
    private static let allowed = #"(?i)\d{2,4}(?:\s*[/.-]\s*\d{1,2}){2}(?!\d)|\d{2,4}年\s*\d{1,2}月\s*\d{1,2}日|\d{1,2}:\d{2}(?::\d{2})?|[¥￥]\s*\d[\d,]*|\d[\d,]*\s*(?:円|点|個|本|枚)|\d{1,3}(?:,\d{3})+|^\s*(?:合計|小計|total|subtotal)\s*[:：]?\s*[¥￥]?\s*\d{1,7}\s*(?:円)?\s*$"#
    private static let numeric = #"\d(?:[ -]?\d)*"#

    static func expectsValue(_ text: String) -> Bool {
        normalized(text).range(of: labelOnly, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func ranges(in text: String, confidence: Float, afterLabel: Bool) -> [Range<String.Index>] {
        let value = normalized(text)
        guard value.utf16.count == text.utf16.count else {
            return [text.startIndex..<text.endIndex]
        }
        let allowedRanges = matches(allowed, in: value)
        var found = sensitive.flatMap { matches($0, in: value) }
        if afterLabel {
            found += matches(#"^\s*"# + labeledValue, in: value)
        }
        found += matches(numeric, in: value).filter { range in
            let digits = (value as NSString).substring(with: range).compactMap(\.wholeNumberValue)
            if (13...19).contains(digits.count), passesLuhn(digits) { return true }
            if allowedRanges.contains(where: { NSLocationInRange(range.location, $0) && NSMaxRange(range) <= NSMaxRange($0) }) {
                return false
            }
            return digits.count >= 8 || (digits.count >= 2 && confidence < 0.6)
        }
        return found.map { Range($0, in: text) ?? text.startIndex..<text.endIndex }
    }

    private static func normalized(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.map { scalar in
            if scalar.value == 0x3000 { return Unicode.Scalar(0x20)! }
            return (0xff01...0xff5e).contains(scalar.value) ? Unicode.Scalar(scalar.value - 0xfee0)! : scalar
        }))
    }

    private static func matches(_ pattern: String, in text: String) -> [NSRange] {
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return [NSRange(text.startIndex..., in: text)]
        }
        return expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).map(\.range)
    }

    private static func passesLuhn(_ digits: [Int]) -> Bool {
        digits.reversed().enumerated().reduce(0) { sum, entry in
            let doubled = entry.element * 2
            return sum + (entry.offset.isMultiple(of: 2) ? entry.element : (doubled > 9 ? doubled - 9 : doubled))
        }.isMultiple(of: 10)
    }
}
