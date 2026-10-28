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
    static func checkedSum(_ values: [Int]) throws -> Int {
        try values.reduce(0) { try KMYen.add($0, $1) }
    }
}
