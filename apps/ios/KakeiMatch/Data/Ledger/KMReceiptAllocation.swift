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
    private static func isValidTaxRate(_ rate: Decimal) -> Bool {
        !rate.isNaN && rate > 0 && rate <= 100
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
        if let taxes = value.taxes {
            guard taxes.count <= 10 else { throw fail() }
            for entry in taxes {
                guard isValidTaxRate(entry.ratePercent),
                      try KMYen.checked(entry.taxableAmountYen) >= 0,
                      try KMYen.checked(entry.taxAmountYen) >= 0 else { throw fail() }
            }
        }
        for item in items {
            guard !item.id.isEmpty, !KMPayeeNormalization.trimmed(item.name).isEmpty, item.categoryId != "" else { throw fail() }
            if let amount = item.amountYen { guard try KMYen.checked(amount) >= 0 else { throw fail() } }
            if let price = item.unitPriceYen { guard try KMYen.checked(price) >= 0 else { throw fail() } }
            if let quantity = item.quantity { guard !quantity.isNaN, quantity > 0 else { throw fail() } }
            if let rate = item.taxRatePercent { guard isValidTaxRate(rate) else { throw fail() } }
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
        var rateOrder: [Decimal] = []
        var groupWeights: [[Int]] = []
        func groupIndex(for rate: Decimal) -> Int {
            if let existing = rateOrder.firstIndex(of: rate) { return existing }
            rateOrder.append(rate)
            groupWeights.append(Array(repeating: 0, count: keys.count))
            return rateOrder.count - 1
        }
        for item in items {
            guard let amount = item.amountYen, let index = keys.firstIndex(of: item.categoryId ?? value.categoryId) else { throw fail() }
            totals[index].amountYen = try KMYen.add(totals[index].amountYen, amount)
            if let rate = item.taxRatePercent {
                guard isValidTaxRate(rate) else { throw fail() }
                let gIndex = groupIndex(for: rate)
                groupWeights[gIndex][index] = try KMYen.add(groupWeights[gIndex][index], amount)
            }
        }
        var untargeted = 0
        for adjustment in value.adjustments ?? [] {
            guard let target = adjustment.targetItemId else { untargeted = try KMYen.add(untargeted, adjustment.amountYen); continue }
            guard let item = items.first(where: { $0.id == target }), let index = keys.firstIndex(of: item.categoryId ?? value.categoryId) else { throw fail() }
            totals[index].amountYen = try KMYen.add(totals[index].amountYen, adjustment.amountYen)
            guard totals[index].amountYen >= 0 else { throw fail() }
            if let rate = item.taxRatePercent, let gIndex = rateOrder.firstIndex(of: rate) {
                groupWeights[gIndex][index] = try KMYen.add(groupWeights[gIndex][index], adjustment.amountYen)
                guard groupWeights[gIndex][index] >= 0 else { throw fail() }
            }
        }
        if untargeted != 0 { try distribute(&totals, amount: untargeted) }
        let sum = try totals.reduce(0) { try KMYen.add($0, $1.amountYen) }
        if sum != value.totalAmountYen {
            let diff = try KMYen.add(value.totalAmountYen, -sum)
            guard sum > 0, diff > 0 else { throw fail() }
            try allocateTax(&totals, diff: diff, taxes: value.taxes, legacyTax: value.taxAmountYen,
                            rateOrder: rateOrder, groupWeights: groupWeights)
        }
        let finalSum = try totals.reduce(0) { try KMYen.add($0, $1.amountYen) }
        guard finalSum == value.totalAmountYen else { throw fail() }
        return totals.filter { $0.amountYen > 0 }
    }
    private static func allocateTax(_ totals: inout [Allocation], diff: Int, taxes: [KMReceiptTax]?, legacyTax: Int?,
                                    rateOrder: [Decimal], groupWeights: [[Int]]) throws {
        guard let taxes, !taxes.isEmpty else {
            guard let tax = legacyTax, tax > 0, diff == tax else { throw fail() }
            try distribute(&totals, amount: tax)
            return
        }
        var mergedRates: [Decimal] = []
        var mergedTaxable: [Int] = []
        var mergedTax: [Int] = []
        for entry in taxes {
            guard isValidTaxRate(entry.ratePercent),
                  try KMYen.checked(entry.taxableAmountYen) >= 0,
                  try KMYen.checked(entry.taxAmountYen) >= 0 else { throw fail() }
            if let index = mergedRates.firstIndex(of: entry.ratePercent) {
                mergedTaxable[index] = try KMYen.add(mergedTaxable[index], entry.taxableAmountYen)
                mergedTax[index] = try KMYen.add(mergedTax[index], entry.taxAmountYen)
            } else {
                mergedRates.append(entry.ratePercent)
                mergedTaxable.append(entry.taxableAmountYen)
                mergedTax.append(entry.taxAmountYen)
            }
        }
        let taxesTotal = try mergedTax.reduce(0) { try KMYen.add($0, $1) }
        let baseWeights = totals.map(\.amountYen)

        let externalIndices: [Int]
        var remainingFallbackTax = 0
        if taxesTotal == diff {
            externalIndices = Array(mergedRates.indices)
        } else {
            var exactExternal: [Int] = []
            var exactExternalSum = 0
            var nonInclusive: [Int] = []
            var nonInclusiveSum = 0
            for index in mergedRates.indices {
                let tax = mergedTax[index]
                guard tax > 0 else { continue }
                let groupSum: Int
                if let gIndex = rateOrder.firstIndex(of: mergedRates[index]) {
                    groupSum = try groupWeights[gIndex].reduce(0) { try KMYen.add($0, $1) }
                } else {
                    groupSum = 0
                }
                let inclusiveAmount = try KMYen.add(mergedTaxable[index], tax)
                if groupSum > 0 && groupSum == mergedTaxable[index] {
                    exactExternal.append(index)
                    exactExternalSum = try KMYen.add(exactExternalSum, tax)
                }
                if !(groupSum > 0 && groupSum == inclusiveAmount) {
                    nonInclusive.append(index)
                    nonInclusiveSum = try KMYen.add(nonInclusiveSum, tax)
                }
            }
            if exactExternalSum == diff {
                externalIndices = exactExternal
            } else if nonInclusiveSum == diff {
                externalIndices = nonInclusive
            } else if let tax = legacyTax, tax > 0, diff == tax, taxesTotal <= diff {
                externalIndices = Array(mergedRates.indices)
                remainingFallbackTax = try KMYen.add(diff, -taxesTotal)
            } else {
                throw fail()
            }
        }

        for index in externalIndices {
            let tax = mergedTax[index]
            guard tax > 0 else { continue }
            if let gIndex = rateOrder.firstIndex(of: mergedRates[index]) {
                let weights = groupWeights[gIndex]
                let groupSum = try weights.reduce(0) { try KMYen.add($0, $1) }
                if groupSum > 0 {
                    let shares = try allocateShares(weights: weights, amount: tax)
                    for catIndex in totals.indices {
                        totals[catIndex].amountYen = try KMYen.add(totals[catIndex].amountYen, shares[catIndex])
                    }
                    continue
                }
            }
            remainingFallbackTax = try KMYen.add(remainingFallbackTax, tax)
        }
        if remainingFallbackTax > 0 {
            let shares = try allocateShares(weights: baseWeights, amount: remainingFallbackTax)
            for catIndex in totals.indices {
                totals[catIndex].amountYen = try KMYen.add(totals[catIndex].amountYen, shares[catIndex])
            }
        }
    }
    private static func distribute(_ totals: inout [Allocation], amount: Int) throws {
        let shares = try allocateShares(weights: totals.map(\.amountYen), amount: amount)
        for index in totals.indices {
            totals[index].amountYen = try KMYen.add(totals[index].amountYen, shares[index])
            guard totals[index].amountYen >= 0 else { throw fail() }
        }
    }
    private static func allocateShares(weights: [Int], amount: Int) throws -> [Int] {
        let sum = try weights.reduce(0) { try KMYen.add($0, $1) }
        guard sum > 0, weights.allSatisfy({ $0 >= 0 }) else { throw fail() }
        let magnitude = UInt(try KMYen.checked(amount).magnitude), denominator = UInt(sum)
        var shares: [Int] = [], remainders: [UInt] = []
        for weight in weights {
            let product = UInt(weight).multipliedFullWidth(by: magnitude)
            let division = denominator.dividingFullWidth(product)
            shares.append(Int(division.quotient)); remainders.append(division.remainder)
        }
        let remaining = Int(magnitude) - shares.reduce(0, +)
        let ranked = weights.indices.sorted { remainders[$0] == remainders[$1] ? $0 < $1 : remainders[$0] > remainders[$1] }
        for index in ranked.prefix(remaining) { shares[index] += 1 }
        return amount < 0 ? shares.map { -$0 } : shares
    }
}
