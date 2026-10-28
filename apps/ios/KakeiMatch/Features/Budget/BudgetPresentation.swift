import Foundation

enum KMBudgetPresentation {
    static func parseYen(_ input: String, label: String) throws -> Int {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, let number = Double(value), number.isFinite, number >= 0,
              number.rounded(.towardZero) == number, number <= Double(KMYen.maxSafe) else {
            throw KMDataError.invalidData("\(label)は0円以上の整数で入力してください。")
        }
        let amount = Int(number)
        guard KMMonthlyBudgetSettings.validAmount(amount) else { throw KMDataError.invalidData("\(label)は0円以上の整数で入力してください。") }
        return amount
    }

    static func monthLabel(_ month: KMYearMonth) -> String { "\(month.year)年\(month.month)月" }

    static func amountLine(budget: Int, spent: Int, remaining: Int, usageRatio: Decimal?) -> String {
        let remainingText = remaining < 0 ? "超過 \(KMAmountFormatter.yen(-remaining))" : "残り \(KMAmountFormatter.yen(remaining))"
        let ratioText = usageRatio.map { " · \(percentage($0))" } ?? ""
        return "\(signedYen(spent)) / \(KMAmountFormatter.yen(budget)) · \(remainingText)\(ratioText)"
    }

    private static func signedYen(_ amount: Int) -> String {
        "\(amount < 0 ? "−" : "")\(KMAmountFormatter.yen(amount))"
    }

    private static func percentage(_ ratio: Decimal) -> String {
        var tenths = ratio * 1_000
        var rounded = Decimal()
        NSDecimalRound(&rounded, &tenths, 0, .plain)
        let value = NSDecimalNumber(decimal: rounded).intValue
        let magnitude = abs(value)
        return "\(value < 0 ? "−" : "")\(magnitude / 10).\(magnitude % 10)%"
    }

    static func checkedSum(_ values: [Int]) throws -> Int {
        try values.reduce(0) { try KMYen.add($0, $1) }
    }
}
