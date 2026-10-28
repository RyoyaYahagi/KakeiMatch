import SwiftUI

enum KMEntryDestination: String, CaseIterable {
    case receipt, photo, expense, income, transfer
    var title: String {
        switch self {
        case .receipt: "レシートを撮る"
        case .photo: "写真から"
        case .expense: "支出を手入力"
        case .income: "収入"
        case .transfer: "口座間の振替"
        }
    }
    var hint: String {
        switch self {
        case .receipt: "写真を残して、品目まで読み取れます"
        case .photo: "保存したレシート"
        case .expense: "レシートなし"
        case .income: "給与・臨時収入"
        case .transfer: "現金の引き出しなど"
        }
    }
    var icon: String {
        switch self { case .receipt: "camera"; case .photo: "image"; case .expense: "pencil"; case .income: "income"; case .transfer: "transfer" }
    }
}

/// Entry destinations share the current household repositories.
struct RecordChooserView: View {
    let choose: (KMEntryDestination) -> Void
    var body: some View {
        VStack(spacing: KMSpacing.space3) {
            Button { choose(.receipt) } label: {
                HStack(spacing: KMSpacing.space4) {
                    KMIcon(name: "camera", size: 28)
                        .foregroundStyle(KMColor.onPrimary)
                        .frame(width: 52, height: 52)
                        .background(KMColor.primary, in: RoundedRectangle(cornerRadius: KMRadius.md))
                    VStack(alignment: .leading, spacing: 0) {
                        Text(KMEntryDestination.receipt.title).font(KMTypography.body(18, weight: .bold))
                            .foregroundStyle(KMColor.text)
                        Text(KMEntryDestination.receipt.hint).font(KMTypography.note)
                            .foregroundStyle(KMColor.muted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    KMIcon(name: "chevronRight").foregroundStyle(KMColor.muted)
                }
                .padding(KMSpacing.space4).frame(minHeight: 84)
                .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.lg))
                .overlay(RoundedRectangle(cornerRadius: KMRadius.lg).stroke(KMColor.border, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("レシートを撮る")
            .accessibilityIdentifier("chooser.receipt")
            LazyVGrid(columns: [GridItem(.flexible(), spacing: KMSpacing.space2), GridItem(.flexible())], spacing: KMSpacing.space2) {
                ForEach(KMEntryDestination.allCases.filter { $0 != .receipt }, id: \.self) { destination in
                    Button { choose(destination) } label: {
                        HStack(spacing: KMSpacing.space3) {
                            KMIcon(name: destination.icon, size: 22).foregroundStyle(KMColor.primary)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(destination.title).font(KMTypography.body(16, weight: .bold)).foregroundStyle(KMColor.text)
                                Text(destination.hint).font(KMTypography.body(12)).foregroundStyle(KMColor.muted)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, KMSpacing.space3)
                        .padding(.vertical, KMSpacing.space2)
                        .frame(maxWidth: .infinity, minHeight: 64)
                        .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.lg))
                        .overlay(RoundedRectangle(cornerRadius: KMRadius.lg).stroke(KMColor.border, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(destination.title)
                    .accessibilityIdentifier("chooser." + destination.rawValue)
                }
            }
            Text("写真と入力内容はこの端末に保存します。読み取りは「AIで読み取る」を選んだ時だけ行います。")
                .font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
