import Foundation

/// PWA receipt-warnings.ts and local-ui.ts:updateDifference. No persistence, networking, or schema validation.
enum KMReceiptPresentation {
    struct Warning: Identifiable, Equatable {
        let id: Int
        let field: KMReceiptExtraction.WarningField?
        let index: Int?
        let label: String
        let message: String
    }

    struct TotalCheck: Equatable {
        let difference: Int
        let taxMatches: Bool
        var matches: Bool { difference == 0 || taxMatches }
        var label: String { matches ? "✓ 一致" : "△ 差額あり" }
        var accessibleLabel: String {
            taxMatches ? "品目と値引きと税額の合計と一致" : matches ? "品目と値引きの合計と一致" : "品目と値引きの合計と\(KMAmountFormatter.yen(abs(difference)))違います"
        }
    }

    static func totalCheck(total: Int?, items: [KMReceiptItem], adjustments: [KMReceiptAdjustment], tax: Int?) throws -> TotalCheck? {
        guard let total, !items.isEmpty, items.allSatisfy({ $0.amountYen != nil }) else { return nil }
        let itemSum = try items.reduce(0) { try KMYen.add($0, $1.amountYen!) }
        let sum = try adjustments.reduce(itemSum) { try KMYen.add($0, $1.amountYen) }
        let difference = try KMYen.add(total, -sum)
        return TotalCheck(difference: difference, taxMatches: difference != 0 && (tax ?? 0) > 0 && difference == tax)
    }

    static func warnings(_ extraction: KMReceiptExtraction?, reviewed: [Int]) -> [Warning] {
        guard let extraction else { return [] }
        let labels: [KMReceiptExtraction.WarningField: String] = [.merchant: "店名", .purchasedDate: "購入日", .purchasedTime: "時刻", .totalAmountYen: "合計金額", .taxAmountYen: "税額", .items: "品目", .adjustments: "値引き・調整"]
        return extraction.warnings.enumerated().compactMap { index, warning in
            guard !reviewed.contains(index) else { return nil }
            var label = warning.field.flatMap { labels[$0] } ?? "レシート全体"
            var targetIndex: Int?
            if warning.field == .items, let i = warning.index, extraction.items.indices.contains(i) {
                label = "品目\(i + 1)「\(shorten(extraction.items[i].name, max: 24))」"; targetIndex = i
            } else if warning.field == .adjustments, let i = warning.index, let values = extraction.adjustments, values.indices.contains(i) {
                label = "値引き・調整「\(shorten(values[i].label, max: 24))」"; targetIndex = i
            }
            let japanese = warning.message.range(of: "[ぁ-んァ-ヶ一-龠]", options: .regularExpression) != nil
            let message = japanese ? shorten(warning.message, max: 120) : "画像の\(label == "レシート全体" ? "内容" : label)と照らし合わせてください。"
            return Warning(id: index, field: warning.field, index: targetIndex, label: label, message: message)
        }
    }

    private static func shorten(_ text: String, max: Int) -> String {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.utf16.count > max ? String(decoding: Array(value.utf16.prefix(max - 1)), as: UTF16.self) + "…" : value
    }

    static func readingNote(elapsed: TimeInterval) -> String {
        elapsed >= 10 ? "品目が多いレシートは時間がかかります" : "数秒かかります"
    }
}
