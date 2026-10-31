import Foundation

/// PWA `payrollDetails` の表示内容。登録時に確認した snapshot をそのまま並べる。
struct KMPayrollBreakdown: Equatable, Sendable {
    struct Line: Equatable, Sendable {
        var label: String
        var value: String
    }

    var notice: String
    var amountLines: [Line]
    var payPeriod: String
    var allowanceLines: [Line]

    /// PWA と同じ1行1項目の文言。総支給額・控除・対象期間・支給項目の順。
    var textLines: [String] {
        amountLines.map { "\($0.label)：\($0.value)" }
            + ["対象期間：\(payPeriod)"]
            + allowanceLines.map { "\($0.label)：\($0.value)" }
    }
}

enum KMPayrollPresentation {
    static let deductionFields: [(key: String, label: String)] = [
        ("incomeTaxYen", "所得税"), ("residentTaxYen", "住民税"), ("healthInsuranceYen", "健康保険"),
        ("pensionYen", "厚生年金"), ("employmentInsuranceYen", "雇用保険"),
        ("otherYen", "その他控除"), ("totalYen", "控除合計")
    ]

    static let breakdownNotice = "登録時に確認した内訳です。取引の編集後も元の内訳を保持し、削除の取り消しに備えて残します。"

    /// TS: apps/pwa/src/payroll-ui.ts — payrollDetails
    static func breakdown(_ value: KMPayrollRecord.Confirmed) -> KMPayrollBreakdown {
        var amounts = [KMPayrollBreakdown.Line(label: "総支給額", value: amountText(value.grossPayYen))]
        for field in deductionFields {
            amounts.append(.init(label: field.label, value: amountText(deductionAmount(field.key, value.deductions))))
        }
        return .init(
            notice: breakdownNotice,
            amountLines: amounts,
            payPeriod: "\(value.payPeriod ?? "未記載") / \(payTypeLabel(value.payType))",
            allowanceLines: value.allowances.map { .init(label: $0.name, value: amountText($0.amountYen)) }
        )
    }

    static func payTypeLabel(_ payType: KMPayrollRecord.Confirmed.PayType) -> String {
        switch payType {
        case .salary: "給与"
        case .bonus: "賞与"
        case .other: "その他"
        }
    }

    private static func deductionAmount(_ key: String, _ value: KMPayrollRecord.Deductions) -> Int? {
        switch key {
        case "incomeTaxYen": value.incomeTaxYen
        case "residentTaxYen": value.residentTaxYen
        case "healthInsuranceYen": value.healthInsuranceYen
        case "pensionYen": value.pensionYen
        case "employmentInsuranceYen": value.employmentInsuranceYen
        case "otherYen": value.otherYen
        case "totalYen": value.totalYen
        default: nil
        }
    }

    static func amountText(_ amount: Int?) -> String {
        guard let amount else { return "未記載" }
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.numberStyle = .decimal
        return "¥\(formatter.string(from: NSNumber(value: amount)) ?? String(amount))"
    }

    static func mismatch(_ value: KMPayrollRecord.Confirmed) -> Bool {
        guard let gross = value.grossPayYen, let deductions = value.deductions.totalYen else { return false }
        let (expected, overflow) = gross.subtractingReportingOverflow(deductions)
        return overflow || expected != value.netPayYen
    }

    static func validate(employer: String, paymentDate: String, netPay: String,
                          grossPay: String, period: String, payType: KMPayrollRecord.Confirmed.PayType,
                          deductions: [String: String],
                          allowances: [KMPayrollDraftAllowance]) throws -> KMPayrollRecord.Confirmed {
        let employer = employer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !employer.isEmpty, employer.utf16.count <= 120 else { throw KMDataError.invalidData("勤務先を1〜120文字で入力してください。") }
        guard safePayrollText(employer) else { throw KMDataError.invalidData("個人識別情報を含む値は保存できません。") }
        guard let day = try? KMDate(paymentDate) else { throw KMDataError.invalidData("支給日を確認してください。") }
        guard let net = Int(netPay.trimmingCharacters(in: .whitespacesAndNewlines)), net > 0, net <= KMYen.maxSafe else { throw KMDataError.invalidData("手取りを1円以上の整数で入力してください。") }
        func optionalAmount(_ key: String) throws -> Int? {
            guard let raw = deductions[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
            guard let value = Int(raw), value >= 0, value <= KMYen.maxSafe else { throw KMDataError.invalidData("控除額は0円以上の整数で入力してください。") }
            return value
        }
        let gross: Int?
        let cleanGross = grossPay.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleanGross.isEmpty { gross = nil }
        else {
            guard let value = Int(cleanGross), value >= 0, value <= KMYen.maxSafe else { throw KMDataError.invalidData("総支給額は0円以上の整数で入力してください。") }
            gross = value
        }
        let cleanPeriod = period.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanPeriod.utf16.count <= 120 else { throw KMDataError.invalidData("対象期間は120文字以内で入力してください。") }
        guard cleanPeriod.isEmpty || safePayrollText(cleanPeriod) else { throw KMDataError.invalidData("個人識別情報を含む値は保存できません。") }
        let rows = try allowances.map { row -> KMPayrollRecord.Allowance in
            let name = row.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, name.utf16.count <= 120 else { throw KMDataError.invalidData("支給項目名を1〜120文字で入力してください。") }
            guard safePayrollText(name) else { throw KMDataError.invalidData("個人識別情報を含む値は保存できません。") }
            let amount: Int?
            if row.amount.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { amount = nil }
            else {
                guard let value = Int(row.amount), value >= 0, value <= KMYen.maxSafe else { throw KMDataError.invalidData("支給額は0円以上の整数で入力してください。") }
                amount = value
            }
            return .init(name: name, amountYen: amount)
        }
        guard rows.count <= 30 else { throw KMDataError.invalidData("支給項目は30件以内にしてください。") }
        let values = try Dictionary(uniqueKeysWithValues: deductionFields.map { ($0.key, try optionalAmount($0.key)) })
        let confirmed = KMPayrollRecord.Confirmed(
            documentKind: .paySlip, employerName: employer, paymentDate: day,
            payPeriod: cleanPeriod.isEmpty ? nil : cleanPeriod, payType: payType,
            grossPayYen: gross, netPayYen: net,
            deductions: .init(incomeTaxYen: values["incomeTaxYen"] ?? nil,
                              residentTaxYen: values["residentTaxYen"] ?? nil,
                              healthInsuranceYen: values["healthInsuranceYen"] ?? nil,
                              pensionYen: values["pensionYen"] ?? nil,
                              employmentInsuranceYen: values["employmentInsuranceYen"] ?? nil,
                              otherYen: values["otherYen"] ?? nil,
                              totalYen: values["totalYen"] ?? nil),
            allowances: rows, warnings: [])
        return confirmed
    }

    private static func safePayrollText(_ value: String) -> Bool {
        let normalized = value.precomposedStringWithCompatibilityMapping
        let pattern = #"(?:\d[\s-]*){7,}|マイナンバー|個人番号|社員番号|従業員番号|口座番号|生年月日|住所|氏名|https?:|@"#
        let expression = try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
        return expression.firstMatch(in: normalized, range: NSRange(normalized.startIndex..., in: normalized)) == nil
    }
}

struct KMPayrollDraftAllowance: Equatable, Identifiable {
    var id = UUID().uuidString
    var name: String
    var amount: String
}
