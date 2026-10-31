#if DEBUG
import UIKit

/// Synthetic, opt-in UI test states. Never enabled for persistent household repositories.
extension KMReceiptModel {
    func configureFixture() async throws {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-ReceiptScenario"), arguments.indices.contains(index + 1) else { return }
        let scenario = arguments[index + 1]
        try await loadFixtureReceipt(warning: scenario == "warnings")
        guard let repositories, let original = receipt,
              let png = Self.syntheticImage(merchant: merchant, items: items).pngData() else { return }
        // Store the photo through the real repository so the screen shows a saved original.
        var saved = try await repositories.receipts.saveReceiptImage(data: png, contentType: "image/png",
            replacingReceiptId: original.id, at: now)
        saved.extraction = original.extraction
        saved.reviewedWarnings = original.reviewedWarnings
        saved.itemCategories = original.itemCategories
        saved.aiSuggestion = original.aiSuggestion
        if scenario == "initial" || scenario == "loading" {
            saved.extraction = nil; saved.reviewedWarnings = []; saved.itemCategories = nil
            saved.aiSuggestion = KMReceipt.AISuggestion(source: .unclassified)
        }
        try await repositories.receipts.saveReceipt(saved)
        try await display(saved)
        if scenario == "initial" || scenario == "loading" {
            merchant = ""; amount = ""; categoryId = ""; items = []; adjustments = []; tax = ""
        }
        if scenario == "loading" { phase = .reading; startedReading = Date() }
        if scenario == "failure" {
            phase = .failed(.nativeUnsupported); error = KMReceiptPresentation.failureMessage(.nativeUnsupported)
        }
    }

    private static func syntheticImage(merchant: String, items: [KMReceiptItem]) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 390, height: 840))
        return renderer.image { context in
            UIColor(red: 0.85, green: 0.83, blue: 0.80, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 390, height: 840))
            UIColor.white.setFill(); context.fill(CGRect(x: 55, y: 275, width: 280, height: 310))
            let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 16), .foregroundColor: UIColor.black]
            let text = "スーパーみどり\n2026年10月14日 12:31\n\n" + items.map { "\($0.name)  ¥\($0.amountYen ?? 0)" }.joined(separator: "\n") + "\n\n合計  ¥2,138"
            (text as NSString).draw(in: CGRect(x: 70, y: 292, width: 255, height: 290), withAttributes: attributes)
        }
    }
}
#endif
