import Foundation

/// apps/pwa/src/local-receipts.ts receiptAllocations / distributeProportionally.
/// Order is first item appearance; full-width UInt multiplication mirrors TS BigInt exactly.
enum KMReceiptAllocation {
    struct Allocation: Equatable, Sendable {
        var categoryId: String
        var amountYen: Int
    }
    private static func fail() -> KMDataError {
        .invalidData("カテゴリ配分を確認してください。品目と値引きの合計を入力した合計金額に合わせてください。")
    }
    static func validate(_ value: KMConfirmedReceipt, allowZero: Bool) throws {
        let items = value.items ?? [], adjustments = value.adjustments ?? []
        guard !KMPayeeNormalization.trimmed(value.merchant).isEmpty, value.merchant.utf16.count <= 200,
              !value.categoryId.isEmpty, !value.accountId.isEmpty, (value.memo?.utf16.count ?? 0) <= 2000,
              try KMYen.checked(value.totalAmountYen) >= (allowZero ? 0 : 1), items.count <= 100, adjustments.count <= 100,
              Set(items.map(\.id) + adjustments.map(\.id)).count == items.count + adjustments.count else { throw fail() }
        if let time = value.purchasedTime {
            guard time.range(of: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$", options: .regularExpression) != nil else { throw fail() }
        }
        if let tax = value.taxAmountYen { guard try KMYen.checked(tax) >= 0 else { throw fail() } }
        for item in items {
            guard !item.id.isEmpty, !KMPayeeNormalization.trimmed(item.name).isEmpty, item.categoryId != "" else { throw fail() }
            if let amount = item.amountYen { guard try KMYen.checked(amount) >= 0 else { throw fail() } }
            if let price = item.unitPriceYen { guard try KMYen.checked(price) >= 0 else { throw fail() } }
            if let quantity = item.quantity { guard !quantity.isNaN, quantity > 0 else { throw fail() } }
        }
        for adjustment in adjustments {
            guard !adjustment.id.isEmpty, !KMPayeeNormalization.trimmed(adjustment.label).isEmpty else { throw fail() }
            _ = try KMYen.checked(adjustment.amountYen)
            if let target = adjustment.targetItemId { guard items.contains(where: { $0.id == target }) else { throw fail() } }
        }
    }
    static func allocations(_ value: KMConfirmedReceipt) throws -> [Allocation] {
        if value.totalAmountYen == 0 { return [.init(categoryId: value.categoryId, amountYen: 0)] }
        let items = value.items ?? []
        var keys: [String] = []
        for item in items {
            let key = item.categoryId ?? value.categoryId
            if !keys.contains(key) { keys.append(key) }
        }
        if keys.count <= 1 { return [.init(categoryId: keys.first ?? value.categoryId, amountYen: value.totalAmountYen)] }
        var totals = keys.map { Allocation(categoryId: $0, amountYen: 0) }
        for item in items {
            guard let amount = item.amountYen, let index = keys.firstIndex(of: item.categoryId ?? value.categoryId) else { throw fail() }
            totals[index].amountYen = try KMYen.add(totals[index].amountYen, amount)
        }
        var untargeted = 0
        for adjustment in value.adjustments ?? [] {
            guard let target = adjustment.targetItemId else { untargeted = try KMYen.add(untargeted, adjustment.amountYen); continue }
            guard let item = items.first(where: { $0.id == target }), let index = keys.firstIndex(of: item.categoryId ?? value.categoryId) else { throw fail() }
            totals[index].amountYen = try KMYen.add(totals[index].amountYen, adjustment.amountYen)
            guard totals[index].amountYen >= 0 else { throw fail() }
        }
        if untargeted != 0 { try distribute(&totals, amount: untargeted) }
        let sum = try totals.reduce(0) { try KMYen.add($0, $1.amountYen) }
        if sum != value.totalAmountYen {
            guard sum > 0, let tax = value.taxAmountYen, tax > 0, value.totalAmountYen - sum == tax else { throw fail() }
            try distribute(&totals, amount: tax)
        }
        return totals.filter { $0.amountYen > 0 }
    }
    private static func distribute(_ totals: inout [Allocation], amount: Int) throws {
        let sum = try totals.reduce(0) { try KMYen.add($0, $1.amountYen) }
        guard sum > 0, totals.allSatisfy({ $0.amountYen >= 0 }) else { throw fail() }
        let magnitude = UInt(try KMYen.checked(amount).magnitude), denominator = UInt(sum)
        var shares: [Int] = [], remainders: [UInt] = []
        for total in totals {
            let product = UInt(total.amountYen).multipliedFullWidth(by: magnitude)
            let division = denominator.dividingFullWidth(product)
            shares.append(Int(division.quotient)); remainders.append(division.remainder)
        }
        let remaining = Int(magnitude) - shares.reduce(0, +)
        let ranked = totals.indices.sorted { remainders[$0] == remainders[$1] ? $0 < $1 : remainders[$0] > remainders[$1] }
        for index in ranked.prefix(remaining) { shares[index] += 1 }
        for index in totals.indices {
            totals[index].amountYen = try KMYen.add(totals[index].amountYen, amount < 0 ? -shares[index] : shares[index])
            guard totals[index].amountYen >= 0 else { throw fail() }
        }
    }
}
