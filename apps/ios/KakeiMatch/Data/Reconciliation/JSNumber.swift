import Foundation

/// The non-negative finite binary64 arithmetic used by the TS scoring formula, implemented
/// with integers so neither monetary values nor scores pass through Swift Double.
/// Each operation rounds to 53 significant bits (nearest, ties to even), in TS order.
/// This is deliberately not a general JavaScript runtime: inputs are bounded safe integers
/// and scoring constants; subnormals, infinities and NaN cannot occur in this formula.
struct KMJSNumber: Comparable, Equatable, Sendable, ExpressibleByIntegerLiteral {
    private var significand: UInt64
    private var exponent: Int
    private var negative: Bool
    init(integerLiteral value: Int) { self.init(value) }
    init(_ value: Int) {
        self = Self.normalized(UInt128(value.magnitude), exponent: 0, negative: value < 0)
    }
    init(_ decimal: String) {
        let parts = decimal.split(separator: ".")
        let digits = parts.joined()
        let scale = parts.count == 1 ? 0 : parts[1].count
        var denominator = 1
        for _ in 0..<scale { denominator *= 10 }
        self = Self(Int(digits)!) / Self(denominator)
    }
    private init(significand: UInt64, exponent: Int, negative: Bool) {
        self.significand = significand; self.exponent = exponent; self.negative = negative && significand != 0
    }
    private static func normalized(_ value: UInt128, exponent: Int, negative: Bool = false, sticky: Bool = false) -> Self {
        guard value != 0 else { return Self(significand: 0, exponent: 0, negative: false) }
        let bits = 128 - value.leadingZeroBitCount
        if bits <= 53 {
            let shift = 53 - bits
            return Self(significand: UInt64(value << shift), exponent: exponent - shift, negative: negative)
        }
        var shift = bits - 53
        var kept = value >> shift
        let remainder = value - (kept << shift), half = UInt128(1) << (shift - 1)
        if remainder > half || remainder == half && (sticky || kept & 1 == 1) { kept += 1 }
        if kept == UInt128(1) << 53 { kept >>= 1; shift += 1 }
        return Self(significand: UInt64(kept), exponent: exponent + shift, negative: negative)
    }
    static func + (lhs: Self, rhs: Self) -> Self {
        if lhs.significand == 0 { return rhs }; if rhs.significand == 0 { return lhs }
        let exponent = min(lhs.exponent, rhs.exponent)
        let ld = lhs.exponent - exponent, rd = rhs.exponent - exponent
        // More than 74 exponent bits cannot affect a 53-bit nearest-even result.
        if ld > 74 { return lhs }; if rd > 74 { return rhs }
        let l = UInt128(lhs.significand) << ld, r = UInt128(rhs.significand) << rd
        if lhs.negative == rhs.negative { return normalized(l + r, exponent: exponent, negative: lhs.negative) }
        return l >= r ? normalized(l - r, exponent: exponent, negative: lhs.negative) : normalized(r - l, exponent: exponent, negative: rhs.negative)
    }
    static func - (lhs: Self, rhs: Self) -> Self {
        var rhs = rhs; if rhs.significand != 0 { rhs.negative.toggle() }; return lhs + rhs
    }
    static func * (lhs: Self, rhs: Self) -> Self {
        normalized(UInt128(lhs.significand) * UInt128(rhs.significand), exponent: lhs.exponent + rhs.exponent, negative: lhs.negative != rhs.negative)
    }
    static func / (lhs: Self, rhs: Self) -> Self {
        precondition(rhs.significand != 0)
        let numerator = UInt128(lhs.significand) << 64
        let divisor = UInt128(rhs.significand)
        return normalized(numerator / divisor, exponent: lhs.exponent - rhs.exponent - 64,
            negative: lhs.negative != rhs.negative, sticky: numerator % divisor != 0)
    }
    static func < (lhs: Self, rhs: Self) -> Bool {
        if lhs.negative != rhs.negative { return lhs.negative }
        if lhs.significand == 0 || rhs.significand == 0 {
            return lhs.negative ? lhs.significand > rhs.significand : lhs.significand < rhs.significand
        }
        let magnitudeLess = lhs.exponent == rhs.exponent ? lhs.significand < rhs.significand : lhs.exponent < rhs.exponent
        return lhs.negative ? lhs != rhs && !magnitudeLess : magnitudeLess
    }
    func roundedMillion() -> (binary: Self, decimal: Decimal) {
        let scaled = self * Self(1_000_000)
        precondition(!scaled.negative)
        let integer: UInt64
        if scaled.significand == 0 { integer = 0 }
        else if scaled.exponent >= 0 { integer = scaled.significand << scaled.exponent }
        else {
            let shift = -scaled.exponent
            if shift > 53 { integer = 0 }
            else {
                let whole = scaled.significand >> shift
                let remainder = scaled.significand - (whole << shift)
                integer = whole + (remainder >= UInt64(1) << (shift - 1) ? 1 : 0)
            }
        }
        return (Self(Int(integer)) / Self(1_000_000), Decimal(integer) / 1_000_000)
    }
    var decimalApproximation: Decimal {
        var result = Decimal(significand)
        if exponent < 0 { for _ in 0..<(-exponent) { result /= 2 } }
        else { for _ in 0..<exponent { result *= 2 } }
        return negative ? -result : result
    }
}
