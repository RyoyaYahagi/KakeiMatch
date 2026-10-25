import Foundation

// TS: workers/ai-gateway/src/payroll-schema.ts — PayrollRecord
struct KMPayrollRecord: Codable, Equatable, Sendable, Identifiable {
    enum Status: String, Codable, Equatable, Sendable { case pending, applied }

    var id: String
    var actualTransactionId: String?
    var status: Status
    var confirmed: Confirmed
    var categoryId: String
    var accountId: String
    var extractionModel: String
    var promptVersion: String
    var createdAt: Date
    var updatedAt: Date

    // TS: workers/ai-gateway/src/payroll-schema.ts — ConfirmedPayroll
    struct Confirmed: Codable, Equatable, Sendable {
        enum PayType: String, Codable, Equatable, Sendable { case salary, bonus, other }

        enum DocumentKind: String, Codable, Equatable, Sendable { case paySlip = "pay_slip" }

        var documentKind: DocumentKind
        var employerName: String
        var paymentDate: KMDate
        var payPeriod: String?
        var payType: PayType
        var grossPayYen: Int?
        var netPayYen: Int
        var deductions: Deductions
        var allowances: [Allowance]
        var warnings: [Warning]
    }

    // TS: workers/ai-gateway/src/payroll-schema.ts — deductions object
    struct Deductions: Codable, Equatable, Sendable {
        var incomeTaxYen: Int?
        var residentTaxYen: Int?
        var healthInsuranceYen: Int?
        var pensionYen: Int?
        var employmentInsuranceYen: Int?
        var otherYen: Int?
        var totalYen: Int?
    }

    // TS: workers/ai-gateway/src/payroll-schema.ts — allowances element
    struct Allowance: Codable, Equatable, Sendable {
        var name: String
        var amountYen: Int?
    }

    // TS: workers/ai-gateway/src/payroll-schema.ts — warnings element
    struct Warning: Codable, Equatable, Sendable {
        enum Field: String, Codable, Equatable, Sendable {
            case employerName, paymentDate, grossPayYen, netPayYen, deductions, allowances
        }
        enum Code: String, Codable, Equatable, Sendable { case unreadable, uncertain, amountMismatch = "amount_mismatch" }

        var field: Field?
        var code: Code
    }
}
