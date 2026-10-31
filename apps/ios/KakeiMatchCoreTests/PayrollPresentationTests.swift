import Foundation
import Testing
@testable import KakeiMatchCore

struct PayrollPresentationTests {
    private func confirmed(
        payPeriod: String? = "2026年9月",
        payType: KMPayrollRecord.Confirmed.PayType = .salary,
        grossPayYen: Int? = 310_000,
        deductions: KMPayrollRecord.Deductions = .init(
            incomeTaxYen: 8_000, residentTaxYen: 10_000, healthInsuranceYen: 15_000,
            pensionYen: 27_000, employmentInsuranceYen: 2_000, otherYen: nil, totalYen: 62_000),
        allowances: [KMPayrollRecord.Allowance] = [
            .init(name: "通勤手当", amountYen: 10_000), .init(name: "住宅手当", amountYen: nil)
        ]
    ) -> KMPayrollRecord.Confirmed {
        .init(documentKind: .paySlip, employerName: "合成商事", paymentDate: KMDate(rawValue: "2026-10-10"),
            payPeriod: payPeriod, payType: payType, grossPayYen: grossPayYen, netPayYen: 248_000,
            deductions: deductions, allowances: allowances, warnings: [])
    }

    @Test func breakdownMatchesPWADetailOrderAndCopy() {
        let breakdown = KMPayrollPresentation.breakdown(confirmed())
        #expect(breakdown.notice == "登録時に確認した内訳です。取引の編集後も元の内訳を保持し、削除の取り消しに備えて残します。")
        #expect(breakdown.textLines == [
            "総支給額：¥310,000",
            "所得税：¥8,000",
            "住民税：¥10,000",
            "健康保険：¥15,000",
            "厚生年金：¥27,000",
            "雇用保険：¥2,000",
            "その他控除：未記載",
            "控除合計：¥62,000",
            "対象期間：2026年9月 / 給与",
            "通勤手当：¥10,000",
            "住宅手当：未記載",
        ])
    }

    @Test func missingPeriodAndNonSalaryTypeUsePWAFallbacks() {
        let bonus = KMPayrollPresentation.breakdown(confirmed(payPeriod: nil, payType: .bonus, grossPayYen: nil, allowances: []))
        #expect(bonus.textLines.first == "総支給額：未記載")
        #expect(bonus.textLines.contains("対象期間：未記載 / 賞与"))
        #expect(bonus.allowanceLines.isEmpty)

        let other = KMPayrollPresentation.breakdown(confirmed(payType: .other, allowances: []))
        #expect(other.textLines.contains("対象期間：2026年9月 / その他"))
    }
}
