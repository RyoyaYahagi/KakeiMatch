import Foundation
import Testing
@testable import KakeiMatch

struct DomainCodingTests {
    private func roundTrip<T: Codable & Equatable>(_ type: T.Type, from json: String) throws -> T {
        let data = Data(json.utf8)
        let value = try KMJSON.decoder().decode(type, from: data)
        let encoded = try KMJSON.encoder().encode(value)
        return try KMJSON.decoder().decode(type, from: encoded)
    }

    @Test func receiptPreservesNullableFieldsAmountsAndDecimalQuantity() throws {
        let receipt = try roundTrip(KMReceipt.self, from: #"""
        {
          "id":"receipt:test","createdAt":"2026-10-03T01:02:03.125Z","updatedAt":"2026-10-03T01:02:04.000Z",
          "image":null,
          "extraction":{"documentKind":"not_receipt","merchant":null,"purchasedDate":null,"purchasedTime":null,"totalAmountYen":null,"taxAmountYen":null,"items":[],"warnings":[]},
          "aiSuggestion":{"categoryId":null,"source":"learned_rule","probabilities":null,"model":null,"attemptedAt":null},
          "confirmedValue":{"merchant":"合成店舗","purchasedDate":"2026-10-02","purchasedTime":null,"totalAmountYen":1250,"categoryId":"food","accountId":"cash","excludedFromSpending":false,"memo":null,"taxAmountYen":null,"items":[{"id":"item-1","name":"食品","amountYen":1250,"quantity":1.25,"unitPriceYen":1000,"categoryId":null}],"adjustments":[]},
          "registration":{"status":"pending","actualTransactionId":null,"lastError":null}
        }
        """#)
        #expect(receipt.confirmedValue?.purchasedDate.rawValue == "2026-10-02")
        #expect(receipt.confirmedValue?.items?.first?.quantity == Decimal(string: "1.25"))
        #expect(receipt.confirmedValue?.items?.first?.amountYen == 1250)
        #expect(receipt.registration.status.rawValue == "pending")
        let expectedCreatedAt = try KMJSON.decoder().decode(Date.self, from: Data("\"2026-10-03T01:02:03.125Z\"".utf8))
        #expect(receipt.createdAt == expectedCreatedAt)
    }

    @Test func statementAndReconciliationRoundTripRawValuesAndTimestamps() throws {
        let statementImport = try roundTrip(KMStatementImport.self, from: #"""
        {"provider":"smbc_card","fileHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","encoding":"utf-8","headerSignature":"synthetic-header","totalRows":1,"excludedRows":0,"duplicateRowsInFile":0,"createdAt":"2026-10-03T01:02:03.125Z"}
        """#)
        #expect(statementImport.provider.rawValue == "smbc_card")
        #expect(statementImport.accountId == nil)
        #expect(statementImport.totalRows == 1)

        let statement = try roundTrip(KMStatementTransaction.self, from: #"""
        {"id":"statement-1","importId":"import-1","provider":"rakuten_card","externalId":null,"kind":"refund","usedDate":"2026-10-02","usedTime":null,"postedDate":null,"merchant":"合成店舗","amountYen":1234,"paymentMethod":null,"sourceFingerprint":"fingerprint","duplicateOrdinal":0}
        """#)
        #expect(statement.provider.rawValue == "rakuten_card")
        #expect(statement.kind.rawValue == "refund")
        #expect(statement.amountYen == 1234)
        #expect(statement.externalId == nil)

        let run = try roundTrip(KMReconciliationRun.self, from: #"""
        {"runId":"run-1","createdAt":"2026-10-03T01:02:03.125Z","completedAt":"2026-10-03T01:02:04Z","ruleVersion":"v1","candidates":[{"statementTransactionId":"statement-1","receiptId":"receipt-1","rank":1,"score":0.875,"amountDeltaYen":0,"dateDistanceDays":1,"merchantSimilarity":0.75,"reasons":["same_amount"]}],"statementResults":[{"statementTransactionId":"statement-1","status":"needs_review","matchedReceiptId":null,"reasonCodes":["ambiguous"]}],"receiptResults":[{"receiptId":"receipt-1","status":"unmatched_receipt","matchedStatementTransactionId":null,"reasonCodes":[]}]}
        """#)
        let expectedCreatedAt = try KMJSON.decoder().decode(Date.self, from: Data("\"2026-10-03T01:02:03.125Z\"".utf8))
        #expect(run.createdAt == expectedCreatedAt)
        #expect(run.statementResults.first?.status.rawValue == "needs_review")
        #expect(run.candidates.first?.score == Decimal(string: "0.875"))

        let resolution = try roundTrip(KMReconciliationResolution.self, from: #"""
        {"id":"resolution-1","runId":"run-1","statementId":"statement-1","resolution":"same_expense","source":"user","receiptId":null,"categoryId":null,"accountId":null,"statementAmountYen":1234,"importedId":null,"status":"processing","actualTransactionId":null,"actualSnapshot":{"date":"2026-10-02","amountYen":-1234,"payeeName":null,"accountId":"cash","isSplit":false,"cleared":true},"statementSnapshot":{"usedDate":"2026-10-02","merchant":"合成店舗","kind":"refund"},"destinationAccountId":null,"excludedFromSpending":false,"errorCode":null,"createdAt":"2026-10-03T01:02:03.125Z","updatedAt":"2026-10-03T01:02:04Z"}
        """#)
        #expect(resolution.resolution.rawValue == "same_expense")
        #expect(resolution.source.rawValue == "user")
        #expect(resolution.status.rawValue == "processing")
        #expect(resolution.actualSnapshot?.amountYen == -1234)
        #expect(resolution.destinationAccountId == nil)
    }

    @Test func recurringPayrollAndCategoryRulesRoundTrip() throws {
        let recurring = try roundTrip(KMRecurringTransaction.self, from: #"""
        {"id":"schedule-1","name":"合成定期","kind":"expense","amountYen":5000,"categoryId":"food","accountId":"cash","frequency":"monthly","startDate":"2026-10-01","postsTransaction":false,"nextDate":null,"completed":false,"editable":true}
        """#)
        #expect(recurring.kind.rawValue == "expense")
        #expect(recurring.frequency.rawValue == "monthly")
        #expect(recurring.nextDate == nil)

        let audit = try roundTrip(KMRecurringScheduleAudit.self, from: #"""
        {"targetType":"schedule","operationId":"op-1","operation":"update","scheduleId":"schedule-1","input":{"name":"合成定期","kind":"income","amountYen":5000,"categoryId":"income","accountId":"bank","frequency":"yearly","startDate":"2026-10-01","postsTransaction":true},"status":"applied","createdAt":"2026-10-03T01:02:03.125Z","appliedAt":null}
        """#)
        #expect(audit.targetType.rawValue == "schedule")
        #expect(audit.operation.rawValue == "update")
        #expect(audit.input?.frequency.rawValue == "yearly")

        let payroll = try roundTrip(KMPayrollRecord.self, from: #"""
        {"id":"00000000-0000-4000-8000-000000000001","actualTransactionId":null,"status":"pending","confirmed":{"documentKind":"pay_slip","employerName":"合成雇用主","paymentDate":"2026-10-01","payPeriod":null,"payType":"salary","grossPayYen":300000,"netPayYen":240000,"deductions":{"incomeTaxYen":10000,"residentTaxYen":5000,"healthInsuranceYen":12000,"pensionYen":25000,"employmentInsuranceYen":1000,"otherYen":null,"totalYen":53000},"allowances":[{"name":"通勤費","amountYen":null}],"warnings":[{"field":"netPayYen","code":"amount_mismatch"}]},"categoryId":"salary","accountId":"bank","extractionModel":"test-model","promptVersion":"payroll-v1","createdAt":"2026-10-03T01:02:03Z","updatedAt":"2026-10-03T01:02:04Z"}
        """#)
        #expect(payroll.confirmed.documentKind.rawValue == "pay_slip")
        #expect(payroll.confirmed.payType.rawValue == "salary")
        #expect(payroll.confirmed.deductions.totalYen == 53000)
        #expect(payroll.confirmed.allowances.first?.amountYen == nil)
        #expect(payroll.confirmed.warnings.first?.code.rawValue == "amount_mismatch")

        let observation = try roundTrip(KMCategoryLearningObservation.self, from: #"""
        {"targetType":"category-learning","receiptId":"receipt-1","normalizedMerchant":"合成店舗","merchantCategoryId":null,"items":[{"normalizedName":"食品","categoryId":"food"}],"confirmedAt":"2026-10-03T01:02:03.125Z"}
        """#)
        #expect(observation.targetType.rawValue == "category-learning")
        #expect(observation.merchantCategoryId == nil)
        #expect(observation.items.first?.categoryId == "food")

        let rule = try roundTrip(KMCategoryLearningRule.self, from: #"""
        {"targetType":"merchant","normalizedName":"合成店舗","categoryId":"food","receipts":2,"matchingReceipts":2,"agreementPercent":100,"enabled":true,"deleted":false}
        """#)
        #expect(rule.targetType.rawValue == "merchant")
        #expect(rule.id == "merchant:合成店舗")
        #expect(rule.agreementPercent == 100)
    }

    @Test func rejectsUnknownStatesAndFractionalYen() {
        let badState = #"{"statementTransactionId":"s","status":"done","matchedReceiptId":null,"reasonCodes":[]}"#
        #expect(throws: (any Error).self) { try KMJSON.decoder().decode(KMReconciliationStatementResult.self, from: Data(badState.utf8)) }

        let badEnum = #"{"id":"s","importId":"i","provider":"rakuten_card","externalId":null,"kind":"chargeback","usedDate":"2026-10-02","usedTime":null,"postedDate":null,"merchant":"synthetic","amountYen":100,"paymentMethod":null,"sourceFingerprint":"f","duplicateOrdinal":0}"#
        #expect(throws: (any Error).self) { try KMJSON.decoder().decode(KMStatementTransaction.self, from: Data(badEnum.utf8)) }

        let fractionalYen = #"{"id":"s","importId":"i","provider":"rakuten_card","externalId":null,"kind":"purchase","usedDate":"2026-10-02","usedTime":null,"postedDate":null,"merchant":"synthetic","amountYen":100.5,"paymentMethod":null,"sourceFingerprint":"f","duplicateOrdinal":0}"#
        #expect(throws: (any Error).self) { try KMJSON.decoder().decode(KMStatementTransaction.self, from: Data(fractionalYen.utf8)) }
    }
}
