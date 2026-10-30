#if DEBUG
import Foundation

/// Synthetic CSV for XCUITest only. Never used for a persistent household.
enum KMMoneyForwardFixture {
    static var scenario: String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-MoneyForwardScenario"), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    static let csv = """
    計算対象,日付,内容,金額（円）,保有金融機関,大項目,中項目,メモ,振替,ID
    1,2026/10/01,架空スーパー,-1200,合成口座,食費,食料品,合成メモ,0,mf-expense
    1,2026/10/02,架空給与,200000,合成口座,給与,給与,,0,mf-income
    1,2026/10/03,架空カフェ,-300,合成口座,独自用途,試験,,0,mf-unknown
    """
}
#endif
