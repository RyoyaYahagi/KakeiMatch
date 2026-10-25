import Foundation

// TS: src/lib/monthly-budget-settings.ts — MonthlyBudgetSettings
struct KMMonthlyBudgetSettings: Codable, Equatable, Sendable {
    // TS: MonthlyBudgetValue — number | { inherit: true }
    enum Value: Codable, Equatable, Sendable {
        case amount(Int)
        case inherit

        init(from decoder: Decoder) throws {
            if let amount = try? decoder.singleValueContainer().decode(Int.self) {
                self = .amount(amount)
                return
            }
            let container = try decoder.container(keyedBy: InheritKey.self)
            guard try container.decode(Bool.self, forKey: .inherit) else {
                throw KMDataError.invalidData("予算設定を確認できません。")
            }
            self = .inherit
        }

        func encode(to encoder: Encoder) throws {
            switch self {
            case .amount(let amount):
                var container = encoder.singleValueContainer()
                try container.encode(amount)
            case .inherit:
                var container = encoder.container(keyedBy: InheritKey.self)
                try container.encode(true, forKey: .inherit)
            }
        }

        private enum InheritKey: String, CodingKey { case inherit }
    }

    // TS: MonthlyBudgetBreakdownValue — boolean | { inherit: true }
    enum BreakdownValue: Codable, Equatable, Sendable {
        case enabled(Bool)
        case inherit

        init(from decoder: Decoder) throws {
            if let value = try? decoder.singleValueContainer().decode(Bool.self) {
                self = .enabled(value)
                return
            }
            let container = try decoder.container(keyedBy: InheritKey.self)
            guard try container.decode(Bool.self, forKey: .inherit) else {
                throw KMDataError.invalidData("予算設定を確認できません。")
            }
            self = .inherit
        }

        func encode(to encoder: Encoder) throws {
            switch self {
            case .enabled(let value):
                var container = encoder.singleValueContainer()
                try container.encode(value)
            case .inherit:
                var container = encoder.container(keyedBy: InheritKey.self)
                try container.encode(true, forKey: .inherit)
            }
        }

        private enum InheritKey: String, CodingKey { case inherit }
    }

    var budgetId: String
    var defaults: [String: Int]
    var monthlyOverrides: [String: [String: Value]]
    var defaultTotal: Int?
    var monthlyTotals: [String: Value]?
    var defaultBreakdown: Bool?
    var monthlyBreakdown: [String: BreakdownValue]?

    static func empty(budgetId: String) -> Self {
        Self(budgetId: budgetId, defaults: [:], monthlyOverrides: [:])
    }

    func validated(for expectedBudgetId: String) throws -> Self {
        guard !budgetId.isEmpty, budgetId.count <= 128, budgetId == expectedBudgetId,
              defaults.keys.allSatisfy(Self.validIdentifier),
              defaults.values.allSatisfy(Self.validAmount),
              (defaultTotal.map(Self.validAmount) ?? true),
              monthlyOverrides.keys.allSatisfy(Self.validYearMonth),
              monthlyOverrides.values.allSatisfy({ month in
                  month.keys.allSatisfy(Self.validIdentifier) && month.values.allSatisfy {
                      if case .amount(let amount) = $0 { return Self.validAmount(amount) }
                      return true
                  }
              }),
              (monthlyTotals ?? [:]).allSatisfy({ entry in
                  guard Self.validYearMonth(entry.key) else { return false }
                  if case .amount(let amount) = entry.value { return Self.validAmount(amount) }
                  return true
              }),
              (monthlyBreakdown ?? [:]).keys.allSatisfy(Self.validYearMonth) else {
            throw KMDataError.invalidData("予算設定を確認できません。バックアップから復元してください。")
        }
        return self
    }

    func effectiveMonthlyBudget(yearMonth: KMYearMonth, categoryId: String, nativeBudgetYen: Int) throws -> Int? {
        guard Self.validSafeInteger(nativeBudgetYen), Self.validIdentifier(categoryId) else {
            throw KMDataError.invalidData("月予算またはカテゴリを確認してください。")
        }
        if let override = monthlyOverrides[yearMonth.rawValue]?[categoryId] {
            switch override {
            case .amount(let amount): return amount
            case .inherit: return defaults[categoryId]
            }
        }
        if defaultTotal != nil { return defaults[categoryId] }
        if nativeBudgetYen != 0 { return nativeBudgetYen }
        return defaults[categoryId]
    }

    func effectiveOverallBudget(yearMonth: KMYearMonth) -> Int? {
        guard let override = monthlyTotals?[yearMonth.rawValue] else { return defaultTotal }
        if case .amount(let amount) = override { return amount }
        return defaultTotal
    }

    func effectiveBreakdownEnabled(yearMonth: KMYearMonth, legacyHasCategoryBudgets: Bool) -> Bool {
        guard let override = monthlyBreakdown?[yearMonth.rawValue] else { return defaultBreakdown ?? legacyHasCategoryBudgets }
        if case .enabled(let enabled) = override { return enabled }
        return defaultBreakdown ?? legacyHasCategoryBudgets
    }

    func hasExplicitMonthlyPlan(yearMonth: KMYearMonth) -> Bool {
        if let total = monthlyTotals?[yearMonth.rawValue], case .amount = total { return true }
        if let breakdown = monthlyBreakdown?[yearMonth.rawValue], case .enabled = breakdown { return true }
        return (monthlyOverrides[yearMonth.rawValue] ?? [:]).values.contains {
            if case .amount = $0 { return true }
            return false
        }
    }

    func applyingDefaultPlan(totalYen: Int, breakdownEnabled: Bool, allocations: [String: Int]) throws -> Self {
        let validated = try KMMonthlyBudgetPlan(totalYen: totalYen, breakdownEnabled: breakdownEnabled, allocations: allocations).validatedForSaving()
        var next = self
        next.defaultTotal = validated.totalYen
        next.defaultBreakdown = breakdownEnabled
        next.defaults = breakdownEnabled ? validated.allocations : [:]
        next.monthlyTotals = next.monthlyTotals ?? [:]
        next.monthlyBreakdown = next.monthlyBreakdown ?? [:]

        for (month, overrides) in next.monthlyOverrides {
            guard next.monthlyTotals?[month] == nil,
                  overrides.values.contains(where: { if case .amount = $0 { return true }; return false }) else { continue }
            var categoryIds = Set(next.defaults.keys)
            categoryIds.formUnion(overrides.keys)
            var monthTotal = 0
            for categoryId in categoryIds {
                let override = overrides[categoryId]
                let amount: Int
                if let override, case .amount(let value) = override { amount = value }
                else { amount = next.defaults[categoryId] ?? 0 }
                monthTotal = try Self.add(monthTotal, amount)
            }
            next.monthlyTotals?[month] = .amount(monthTotal)
            next.monthlyBreakdown?[month] = .enabled(true)
        }
        return try next.validated(for: budgetId)
    }

    func applyingMonthlyPlan(yearMonth: KMYearMonth, totalYen: Int, breakdownEnabled: Bool, allocations: [String: Int]) throws -> Self {
        let plan = try KMMonthlyBudgetPlan(totalYen: totalYen, breakdownEnabled: breakdownEnabled, allocations: allocations).validatedForSaving()
        guard let total = plan.totalYen else { throw KMDataError.invalidData("予算設定を確認してください。") }
        var next = self
        next.monthlyTotals = next.monthlyTotals ?? [:]
        next.monthlyBreakdown = next.monthlyBreakdown ?? [:]
        next.monthlyTotals?[yearMonth.rawValue] = .amount(total)
        next.monthlyBreakdown?[yearMonth.rawValue] = .enabled(breakdownEnabled)
        if breakdownEnabled {
            next.monthlyOverrides[yearMonth.rawValue] = plan.allocations.mapValues(Value.amount)
        }
        return try next.validated(for: budgetId)
    }

    func resettingMonthlyPlan(yearMonth: KMYearMonth, categoryIds: [String]) throws -> Self {
        guard categoryIds.allSatisfy(Self.validIdentifier) else {
            throw KMDataError.invalidData("カテゴリを確認してください。")
        }
        var next = self
        next.monthlyTotals = next.monthlyTotals ?? [:]
        next.monthlyBreakdown = next.monthlyBreakdown ?? [:]
        next.monthlyTotals?[yearMonth.rawValue] = .inherit
        next.monthlyBreakdown?[yearMonth.rawValue] = .inherit
        next.monthlyOverrides[yearMonth.rawValue] = categoryIds.reduce(into: [:]) { result, categoryId in
            result[categoryId] = .inherit
        }
        return try next.validated(for: budgetId)
    }

    func clearingDefaultPlan() throws -> Self {
        var next = self
        next.defaultTotal = nil
        next.defaultBreakdown = nil
        next.defaults = [:]
        return try next.validated(for: budgetId)
    }

    func settingDefaultBudget(categoryId: String, amount: Int?) throws -> Self {
        guard Self.validIdentifier(categoryId), amount.map(Self.validAmount) ?? true else {
            throw KMDataError.invalidData("予算額またはカテゴリを確認してください。")
        }
        var next = self
        if let amount { next.defaults[categoryId] = amount } else { next.defaults.removeValue(forKey: categoryId) }
        return try next.validated(for: budgetId)
    }

    func settingMonthlyBudget(yearMonth: KMYearMonth, categoryId: String, value: Value?) throws -> Self {
        guard Self.validIdentifier(categoryId), value.map({ if case .amount(let amount) = $0 { return Self.validAmount(amount) }; return true }) ?? true else {
            throw KMDataError.invalidData("予算額またはカテゴリを確認してください。")
        }
        var next = self
        if let value {
            next.monthlyOverrides[yearMonth.rawValue, default: [:]][categoryId] = value
        } else {
            next.monthlyOverrides[yearMonth.rawValue]?.removeValue(forKey: categoryId)
            if next.monthlyOverrides[yearMonth.rawValue]?.isEmpty == true { next.monthlyOverrides.removeValue(forKey: yearMonth.rawValue) }
        }
        return try next.validated(for: budgetId)
    }

    private static func add(_ lhs: Int, _ rhs: Int) throws -> Int {
        let (sum, overflow) = lhs.addingReportingOverflow(rhs)
        guard !overflow, validAmount(sum) else { throw KMDataError.amountOverflow }
        return sum
    }

    static func validIdentifier(_ value: String) -> Bool { !value.isEmpty && value.count <= 128 }
    static func validAmount(_ value: Int) -> Bool { value >= 0 && value <= 9_007_199_254_740_991 }
    static func validSafeInteger(_ value: Int) -> Bool { value >= -9_007_199_254_740_991 && value <= 9_007_199_254_740_991 }
    static func validYearMonth(_ value: String) -> Bool {
        // monthly-budget-settings.ts uses [1-9]\\d{3}, unlike the full ledger calendar (0001...9999).
        guard let month = try? KMYearMonth(value) else { return false }
        return month.year >= 1000
    }
}

// TS: apps/pwa/src/local-monthly-budget-service.ts — MonthlyBudgetPlan
struct KMMonthlyBudgetPlan: Codable, Equatable, Sendable {
    var totalYen: Int?
    var breakdownEnabled: Bool
    var allocations: [String: Int]

    func validated() throws -> Self {
        guard (totalYen.map(KMMonthlyBudgetSettings.validAmount) ?? true),
              allocations.keys.allSatisfy(KMMonthlyBudgetSettings.validIdentifier),
              allocations.values.allSatisfy(KMMonthlyBudgetSettings.validAmount) else {
            throw KMDataError.invalidData("予算設定を確認してください。")
        }
        var sum = 0
        for amount in allocations.values {
            let (result, overflow) = sum.addingReportingOverflow(amount)
            guard !overflow, KMMonthlyBudgetSettings.validAmount(result) else { throw KMDataError.amountOverflow }
            sum = result
        }
        guard !breakdownEnabled || (totalYen.map { sum == $0 } ?? false) else {
            throw KMDataError.invalidData("カテゴリ別予算の合計を全体予算と一致させてください。")
        }
        return self
    }

    func validatedForSaving() throws -> Self {
        guard totalYen != nil else { throw KMDataError.invalidData("予算設定を確認してください。") }
        return try validated()
    }
}

// TS: apps/pwa/src/local-monthly-budget-service.ts — MonthlyBudgetSummary.categories element
struct KMMonthlyBudgetCategory: Codable, Equatable, Sendable, Identifiable {
    var id: String { categoryId }
    var categoryId: String
    var categoryName: String
    var budgetYen: Int?
    var spentYen: Int
    var remainingYen: Int
    var usageRatio: Decimal?
}

// TS: apps/pwa/src/local-monthly-budget-service.ts — MonthlyBudgetSummary
struct KMMonthlyBudgetSummary: Codable, Equatable, Sendable {
    var yearMonth: KMYearMonth
    var categories: [KMMonthlyBudgetCategory]
    var budgetYen: Int
    var spentYen: Int
    var remainingYen: Int
    var usageRatio: Decimal?
    var budgetConfigured: Bool
    var overallBudgetConfigured: Bool
    var breakdownEnabled: Bool
}
