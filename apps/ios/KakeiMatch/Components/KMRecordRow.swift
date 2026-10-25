import SwiftUI

/// UI-only input; this is not a persistence model. Date is an explicit local ISO day (Asia/Tokyo).
struct KMRecordSummary {
    let kind: KMRecordKind
    let amountYen: Int
    let date: String
    var payeeName: String? = nil
    var categoryName: String? = nil
    var categoryID: String? = nil
    var accountName: String? = nil
    var memo: String? = nil
    var excludedFromSpending = false
    var hasReceipt = false
    var needsReview = false
    var showDate = true
    var expenseMemoTitle = false

    private var trimmedMemo: String? {
        guard let memo = memo?.trimmingCharacters(in: .whitespacesAndNewlines), !memo.isEmpty else { return nil }
        return memo
    }
    private var kindLabel: String? { kind == .transfer ? "振替" : kind == .income ? "収入" : nil }
    var shortDate: String {
        let parts = date.split(separator: "-")
        guard parts.count == 3, let month = Int(parts[1]), let day = Int(parts[2]) else { return date }
        return "\(month)/\(day)"
    }
    var title: String {
        if kind == .expense && expenseMemoTitle { return trimmedMemo ?? categoryName ?? "支出" }
        return payeeName.flatMap { $0.isEmpty ? nil : $0 } ?? (kind == .transfer ? "口座間振替" : kindLabel ?? "支出")
    }
    private var noteParts: [String] {
        var parts: [String?] = [showDate ? shortDate : nil]
        if kind == .expense && expenseMemoTitle {
            parts += [payeeName, accountName]
        } else {
            parts += [kindLabel ?? categoryName, kind == .transfer ? accountName : trimmedMemo ?? accountName]
        }
        parts += [excludedFromSpending ? "支出集計の対象外" : nil, hasReceipt ? "レシート" : nil]
        return parts.compactMap { $0 }.filter { !$0.isEmpty }
    }
    var note: String { noteParts.joined(separator: " · ") }
    var accessibilityLabel: String {
        ([title] + (showDate ? [] : [shortDate]) + noteParts + (needsReview ? ["要確認"] : [])
         + [KMAmountFormatter.signed(amountYen, kind: kind)]).joined(separator: " · ")
    }
    var visual: (foreground: Color, background: Color, icon: String) {
        if kind == .income { return (KMColor.income, KMColor.primarySoft, "income") }
        if kind == .transfer { return (KMColor.cOther, KMColor.cOtherSoft, "transfer") }
        let visual = KMCategoryTone.visual(name: categoryName ?? "", id: categoryID)
        return (visual.tone.foreground, visual.tone.background, visual.icon)
    }
}

struct KMRecordRow: View {
    let record: KMRecordSummary
    let identifier: String
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: KMSpacing.space3) {
                KMIcon(name: record.visual.icon, size: 20)
                    .foregroundStyle(record.visual.foreground)
                    .frame(width: KMLayout.recordIcon, height: KMLayout.recordIcon)
                    .background(record.visual.background, in: Circle())
                VStack(alignment: .leading, spacing: 0) {
                    Text(record.title).font(KMTypography.body(16, weight: .medium))
                        .foregroundStyle(KMColor.text).lineLimit(1)
                    (Text(record.needsReview ? "△ 要確認" + (record.note.isEmpty ? "" : " · ") : "")
                        .foregroundColor(KMColor.warning) + Text(record.note).foregroundColor(KMColor.muted))
                        .font(KMTypography.note).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                KMAmount(yen: record.amountYen, kind: record.kind)
            }
            .padding(.vertical, KMSpacing.space2)
            .frame(minHeight: KMLayout.recordHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(record.accessibilityLabel)
        .accessibilityIdentifier(identifier)
    }
}
