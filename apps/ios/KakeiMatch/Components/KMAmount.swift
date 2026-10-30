import SwiftUI

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
