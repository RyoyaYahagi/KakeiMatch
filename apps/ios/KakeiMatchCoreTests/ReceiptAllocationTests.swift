import Foundation
import Testing
@testable import KakeiMatchCore

/// Exact input/expected yen from src/lib/local-receipts.test.ts, "receipt category allocations".
struct ReceiptAllocationTests {
    private func value() throws -> KMConfirmedReceipt {
        .init(merchant: "Synthetic", purchasedDate: try KMDate("2026-09-30"), purchasedTime: nil, totalAmountYen: 1400,
            categoryId: "food", accountId: "cash", items: [
                .init(id: "a", name: "Synthetic apple", amountYen: 1000, categoryId: "food"),
                .init(id: "b", name: "Synthetic soap", amountYen: 500, categoryId: "household")],
            adjustments: [.init(id: "discount", label: "値引き", amountYen: -100, targetItemId: "a")])
    }
    private func amounts(_ value: KMConfirmedReceipt) throws -> [Int] { try KMReceiptAllocation.allocations(value).map(\.amountYen) }
    @Test func targetedDiscountAndInclusiveExternalTax() throws {
        var input = try value()
        #expect(try amounts(input) == [900, 500])
        input.taxAmountYen = 140 // inclusive: do not add it twice.
        #expect(try amounts(input) == [900, 500])
        input.totalAmountYen = 1540
        #expect(try amounts(input) == [990, 550])
        input.totalAmountYen = 1541
        #expect(throws: (any Error).self) { try amounts(input) }
    }
    @Test func untargetedDiscountAfterTargetedBeforeTaxAndPositiveAdjustment() throws {
        var input = try value()
        input.adjustments = [.init(id: "d", label: "クーポン", amountYen: -100)]
        #expect(try amounts(input) == [933, 467])
        input.adjustments = [.init(id: "t", label: "値引き", amountYen: -100, targetItemId: "a"), .init(id: "u", label: "クーポン", amountYen: -140)]
        input.totalAmountYen = 1260
        #expect(try amounts(input) == [810, 450])
        input.totalAmountYen = 1386; input.taxAmountYen = 126
        #expect(try amounts(input) == [891, 495])
        input.adjustments = [.init(id: "u", label: "調整", amountYen: 30)]; input.totalAmountYen = 1530; input.taxAmountYen = nil
        #expect(try amounts(input) == [1020, 510])
    }
    @Test func roundingStableTiesAndLargeProductsAreExact() throws {
        var input = try value(); input.adjustments = []; input.taxAmountYen = 1; input.totalAmountYen = 4
        input.items![0].amountYen = 1; input.items![1].amountYen = 2
        #expect(try amounts(input) == [1, 3])
        input.items![1].amountYen = 1; input.totalAmountYen = 3
        #expect(try amounts(input) == [2, 1])
        input.items![0].amountYen = 4_000_000_000; input.items![1].amountYen = 2_000_000_000
        input.totalAmountYen = 6_600_000_000; input.taxAmountYen = 600_000_000
        #expect(try amounts(input) == [4_400_000_000, 2_200_000_000])
        // Product exceeds UInt64, but quotient/remainder stay exact inside JS safe yen limits.
        input.items![0].amountYen = 4_000_000_000_000_000; input.items![1].amountYen = 2_000_000_000_000_000
        input.totalAmountYen = 6_600_000_000_000_000; input.taxAmountYen = 600_000_000_000_000
        #expect(try amounts(input) == [4_400_000_000_000_000, 2_200_000_000_000_000])
    }
    @Test func fullyDiscountedCategorySingleCategoryUncertaintyAndZero() throws {
        var input = try value()
        input.adjustments![0].amountYen = -1000; input.totalAmountYen = 550; input.taxAmountYen = 50
        #expect(try KMReceiptAllocation.allocations(input) == [.init(categoryId: "household", amountYen: 550)])
        input = try value(); input.items = [.init(id: "a", name: "Synthetic", amountYen: nil)]
        #expect(try KMReceiptAllocation.allocations(input) == [.init(categoryId: "food", amountYen: 1400)])
        input.totalAmountYen = 0
        #expect(try amounts(input) == [0])
        #expect(throws: (any Error).self) { try KMReceiptAllocation.validate(input, allowZero: false) }
        try KMReceiptAllocation.validate(input, allowZero: true)
    }
    @Test func invalidTargetMissingAmountsMismatchNegativeAndOverflow() throws {
        var input = try value(); input.adjustments![0].targetItemId = "deleted"
        #expect(throws: (any Error).self) { try amounts(input) }
        input = try value(); input.totalAmountYen = 1500
        #expect(throws: (any Error).self) { try amounts(input) }
        input = try value(); input.items![0].amountYen = nil
        #expect(throws: (any Error).self) { try amounts(input) }
        input = try value(); input.adjustments![0].amountYen = -1001
        #expect(throws: (any Error).self) { try amounts(input) }
        input = try value(); input.items![0].amountYen = KMYen.maxSafe
        #expect(throws: (any Error).self) { try amounts(input) }
        input = try value(); input.items![0].id = input.items![1].id
        #expect(throws: (any Error).self) { try KMReceiptAllocation.validate(input, allowZero: true) }
    }
    @Test func rateGroupedTaxAllocationRegressionWithTargetedDiscount() throws {
        // 8% group: subtotal 1550 (1000 + 620 - 70 targeted discount), tax 124, all food -> 1674.
        // 10% group: subtotal 598, tax 59, household -> 657. Total: 2331.
        let input = KMConfirmedReceipt(
            merchant: "Synthetic Store",
            purchasedDate: try KMDate("2026-11-28"),
            purchasedTime: nil,
            totalAmountYen: 2331,
            categoryId: "food",
            accountId: "cash",
            taxAmountYen: 183,
            items: [
                .init(id: "a", name: "Synthetic bento", amountYen: 1000, categoryId: "food", taxRatePercent: 8),
                .init(id: "b", name: "Synthetic fruit", amountYen: 620, categoryId: "food", taxRatePercent: 8),
                .init(id: "c", name: "Synthetic detergent", amountYen: 598, categoryId: "household", taxRatePercent: 10),
            ],
            adjustments: [
                .init(id: "d", label: "値引き", amountYen: -70, targetItemId: "a"),
            ],
            taxes: [
                .init(ratePercent: 8, taxableAmountYen: 1550, taxAmountYen: 124),
                .init(ratePercent: 10, taxableAmountYen: 598, taxAmountYen: 59),
            ]
        )
        try KMReceiptAllocation.validate(input, allowZero: false)
        let allocations = try KMReceiptAllocation.allocations(input)
        #expect(allocations == [
            .init(categoryId: "food", amountYen: 1674),
            .init(categoryId: "household", amountYen: 657),
        ])
        #expect(allocations.reduce(0) { $0 + $1.amountYen } == 2331)

        var mismatched = input
        mismatched.totalAmountYen = 2332
        #expect(throws: (any Error).self) { try KMReceiptAllocation.allocations(mismatched) }
    }
    @Test func targetedDiscountLargerThanTaxRateGroupWithoutTaxesStillAllocates() throws {
        // Two categories. The 8% group (food 1000) is smaller than the targeted discount (-1500),
        // but food as a whole (2000) is not. Without taxes the rate group is unused, so allocation must succeed.
        let input = KMConfirmedReceipt(
            merchant: "Synthetic Store",
            purchasedDate: try KMDate("2026-11-28"),
            purchasedTime: nil,
            totalAmountYen: 1000,
            categoryId: "food",
            accountId: "cash",
            items: [
                .init(id: "a", name: "Synthetic bento", amountYen: 1000, categoryId: "food", taxRatePercent: 8),
                .init(id: "b", name: "Synthetic fruit", amountYen: 1000, categoryId: "food"),
                .init(id: "c", name: "Synthetic soap", amountYen: 500, categoryId: "household"),
            ],
            adjustments: [
                .init(id: "d", label: "値引き", amountYen: -1500, targetItemId: "a"),
            ]
        )
        try KMReceiptAllocation.validate(input, allowZero: false)
        #expect(try KMReceiptAllocation.allocations(input) == [
            .init(categoryId: "food", amountYen: 500),
            .init(categoryId: "household", amountYen: 500),
        ])
    }
    @Test func partialItemTaxRatesFallbackToOverallProportion() throws {
        // Item a has 8% rate (food 1000), item b has no tax rate (household 500).
        // 8% tax (80) goes to 8% group (food); unmatched 10% tax (50) falls back to overall 1000:500 (+33/+17).
        let input = KMConfirmedReceipt(
            merchant: "Synthetic Store",
            purchasedDate: try KMDate("2026-11-28"),
            purchasedTime: nil,
            totalAmountYen: 1630,
            categoryId: "food",
            accountId: "cash",
            taxAmountYen: 130,
            items: [
                .init(id: "a", name: "Synthetic apple", amountYen: 1000, categoryId: "food", taxRatePercent: 8),
                .init(id: "b", name: "Synthetic soap", amountYen: 500, categoryId: "household"),
            ],
            adjustments: [],
            taxes: [
                .init(ratePercent: 8, taxableAmountYen: 1000, taxAmountYen: 80),
                .init(ratePercent: 10, taxableAmountYen: 500, taxAmountYen: 50),
            ]
        )
        let allocations = try KMReceiptAllocation.allocations(input)
        #expect(allocations == [
            .init(categoryId: "food", amountYen: 1113),
            .init(categoryId: "household", amountYen: 517),
        ])
        #expect(allocations.reduce(0) { $0 + $1.amountYen } == 1630)
    }
    @Test func mixedInclusiveAndExclusiveRateGroupsAndTaxValidation() throws {
        // 8% group is already tax-inclusive (1080 == 1000 + 80); 10% group is exclusive (500 + 50).
        let input = KMConfirmedReceipt(
            merchant: "Synthetic Store",
            purchasedDate: try KMDate("2026-11-28"),
            purchasedTime: nil,
            totalAmountYen: 1630,
            categoryId: "food",
            accountId: "cash",
            taxAmountYen: 130,
            items: [
                .init(id: "a", name: "Synthetic food", amountYen: 1080, categoryId: "food", taxRatePercent: 8),
                .init(id: "b", name: "Synthetic soap", amountYen: 500, categoryId: "household", taxRatePercent: 10),
            ],
            adjustments: [],
            taxes: [
                .init(ratePercent: 8, taxableAmountYen: 1000, taxAmountYen: 80),
                .init(ratePercent: 10, taxableAmountYen: 500, taxAmountYen: 50),
            ]
        )
        #expect(try amounts(input) == [1080, 550])

        var invalidRate = input
        invalidRate.taxes = [.init(ratePercent: 0, taxableAmountYen: 1000, taxAmountYen: 0)]
        #expect(throws: (any Error).self) { try KMReceiptAllocation.validate(invalidRate, allowZero: false) }

        var invalidItemRate = input
        invalidItemRate.items![0].taxRatePercent = 101
        #expect(throws: (any Error).self) { try KMReceiptAllocation.validate(invalidItemRate, allowZero: false) }
    }
}
