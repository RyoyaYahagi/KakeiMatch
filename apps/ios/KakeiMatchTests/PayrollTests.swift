import Foundation
import Testing
@testable import KakeiMatch

@MainActor struct PayrollTests {
    @Test func failedIncomeAndSnapshotWriteLeavesNeitherRecord() async throws {
        let category = KMCategory(id: "salary", name: "給与", isIncome: true, groupName: "収入")
        let account = KMAccount(id: "bank", name: "給与口座", accountType: .bank)
        let store = KMInMemoryStore(accounts: [account], categories: [category])
        store.payrollWriteFailureForTesting = KMDataError.invalidData("synthetic payroll failure")
        let (record, income) = sample()

        await #expect(throws: KMDataError.self) {
            try await store.registerPayrollRecord(record, income: income)
        }

        #expect(try await store.transactions(matching: KMTransactionQuery(limit: nil)).isEmpty)
        #expect(try await store.payrollRecords().isEmpty)
        #expect(try await store.payees().isEmpty)
    }

    @Test func successfulRegistrationPersistsOnlyNetIncomeWithSnapshot() async throws {
        let category = KMCategory(id: "salary", name: "給与", isIncome: true, groupName: "収入")
        let account = KMAccount(id: "bank", name: "給与口座", accountType: .bank)
        let store = KMInMemoryStore(accounts: [account], categories: [category])
        let (record, income) = sample()

        let applied = try await store.registerPayrollRecord(record, income: income)
        let retried = try await store.registerPayrollRecord(record, income: income)

        #expect(applied.status == .applied)
        #expect(applied.actualTransactionId != nil)
        #expect(retried == applied)
        #expect(try await store.transactions(matching: KMTransactionQuery(limit: nil)).map(\.amountYen) == [260_000])
        #expect(try await store.payrollRecords() == [applied])
    }

    @Test func sqliteFailureRollsBackIncomeAndPayrollSnapshotTogether() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try KMSQLiteStore(directory: directory)
        let seed = KMInMemoryStore(accounts: [.init(id: "bank", name: "給与口座", accountType: .bank)],
                                   categories: [.init(id: "salary", name: "給与", isIncome: true, groupName: "収入")])
        try database(store).save(seed)
        try database(store).sql.execute("CREATE TRIGGER fail_payroll BEFORE INSERT ON objects WHEN NEW.collection='payroll' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        let (record, income) = sample()

        await #expect(throws: (any Error).self) {
            _ = try await store.registerPayrollRecord(record, income: income)
        }

        let reopened = try KMSQLiteStore(directory: directory)
        #expect(try await reopened.transactions(matching: KMTransactionQuery(limit: nil)).isEmpty)
        #expect(try await reopened.payrollRecords().isEmpty)
    }

    @Test func validationUsesIntegerYenAndTokyoCalendarDate() throws {
        let value = try KMPayrollPresentation.validate(employer: "架空商事", paymentDate: "2026-10-25",
            netPay: "260000", grossPay: "340000", period: "2026年10月", payType: .salary,
            deductions: ["totalYen": "80000"], allowances: [])
        #expect(value.paymentDate.rawValue == "2026-10-25")
        #expect(value.netPayYen == 260_000)
        #expect(KMPayrollPresentation.mismatch(value) == false)
        #expect(throws: KMDataError.self) {
            try KMPayrollPresentation.validate(employer: "架空商事", paymentDate: "2026-10-25",
                netPay: "260000.5", grossPay: "", period: "", payType: .salary,
                deductions: [:], allowances: [])
        }
        #expect(throws: KMDataError.self) {
            try KMPayrollPresentation.validate(employer: "口座番号 123456789", paymentDate: "2026-10-25",
                netPay: "260000", grossPay: "", period: "", payType: .salary,
                deductions: [:], allowances: [])
        }
    }

    private func sample() -> (KMPayrollRecord, KMManualTransactionInput) {
        let date = try! KMDate("2026-10-25")
        let confirmed = KMPayrollRecord.Confirmed(documentKind: .paySlip, employerName: "架空商事",
            paymentDate: date, payPeriod: "2026年10月", payType: .salary,
            grossPayYen: 340_000, netPayYen: 260_000,
            deductions: .init(incomeTaxYen: 0, residentTaxYen: 0, healthInsuranceYen: 0,
                              pensionYen: 0, employmentInsuranceYen: 0, otherYen: nil, totalYen: 80_000),
            allowances: [], warnings: [])
        let record = KMPayrollRecord(id: "11111111-1111-4111-8111-111111111111", actualTransactionId: nil,
            status: .pending, confirmed: confirmed, categoryId: "salary", accountId: "bank",
            extractionModel: "manual", promptVersion: "payroll-v1", createdAt: Date(timeIntervalSince1970: 0),
            updatedAt: Date(timeIntervalSince1970: 0))
        let income = KMManualTransactionInput(kind: .income, amountYen: 260_000, date: date,
            payeeName: "架空商事", categoryId: "salary", accountId: "bank", memo: nil,
            importedId: "kakeimatch:payroll:\(record.id)")
        return (record, income)
    }

    private func database(_ store: KMSQLiteStore) throws -> KMStoreDatabase {
        try KMStoreDatabase(url: store.directory.appendingPathComponent(try store.profile().current.uuidString)
            .appendingPathComponent("household.sqlite"))
    }
}
