import SwiftUI

enum KMRecordKind: String, CaseIterable, Sendable {
    case expense, income, transfer
}

/// record-row.ts signedAmount: sign is taken from the integer, not the kind.
/// magnitude handles Int.min without overflow; no Double or locale-dependent currency spacing.
enum KMAmountFormatter {
    static func yen(_ value: Int) -> String {
        let digits = Array(String(value.magnitude))
        return "¥" + digits.enumerated().map { index, digit in
            (index > 0 && (digits.count - index).isMultiple(of: 3) ? "," : "") + String(digit)
        }.joined()
    }

    static func signed(_ value: Int, kind: KMRecordKind) -> String {
        let sign = kind == .transfer ? "" : value < 0 ? "−" : "+"
        return sign + yen(value)
    }
}

struct KMAmount: View {
    let yen: Int
    var kind: KMRecordKind? = nil
    var size: CGFloat = KMTypography.bodySize

    var body: some View {
        Text(kind.map { KMAmountFormatter.signed(yen, kind: $0) } ?? KMAmountFormatter.yen(yen))
            .font(KMTypography.number(size, weight: kind == .transfer ? .medium : .semibold))
            .foregroundStyle(kind == .income ? KMColor.income : kind == .transfer ? KMColor.muted : KMColor.text)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
    }
}
