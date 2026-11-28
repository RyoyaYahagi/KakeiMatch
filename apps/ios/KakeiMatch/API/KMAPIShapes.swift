import Foundation

enum KMAPIShapes {
    /// A monthly plan answers with `month`; an account without an entitlement row, or a guest-linked one, answers with the daily cap and `day`.
    static let accountUsage: KMAPIShape = .oneOf([
        .object([
            "plan": .values(["free", "pro", "family"]), "period": .values(["month"]), "month": .month,
            "used": .integer(), "limit": .nullable(.integer()), "remaining": .nullable(.integer()),
            "supportId": .nullable(.text(max: 128)),
        ], optional: ["supportId"]),
        .object([
            "plan": .values(["free", "guest"]), "period": .values(["day"]), "day": .date,
            "used": .integer(), "limit": .nullable(.integer()), "remaining": .nullable(.integer()),
            "supportId": .nullable(.text(max: 128)),
        ], optional: ["supportId"]),
    ])
    static let yen = KMAPIShape.nullable(.integer())
    static let receiptTax: KMAPIShape = .object([
        "ratePercent": .decimal(min: 0, max: 100),
        "taxableAmountYen": .integer(),
        "taxAmountYen": .integer()
    ])
    static let receipt: KMAPIShape = .object([
        "documentKind": .values(["receipt", "not_receipt", "unknown"]), "merchant": .nullable(.text()),
        "purchasedDate": .nullable(.date), "purchasedTime": .nullable(.text(max: 5)),
        "totalAmountYen": yen, "taxAmountYen": yen,
        "taxes": .array(receiptTax, max: 10),
        "items": .array(.object(["name": .text(), "amountYen": yen,
                                "quantity": .decimal(min: 0, max: Decimal.greatestFiniteMagnitude), "unitPriceYen": yen,
                                "taxRatePercent": .nullable(.decimal(min: 0, max: 100))],
                                optional: ["quantity", "unitPriceYen", "taxRatePercent"]), max: 100),
        "adjustments": .array(.object(["label": .text(), "amountYen": .integer(min: -9_007_199_254_740_991),
                                       "targetItemIndex": .nullable(.integer())], optional: ["targetItemIndex"]), max: 100),
        "warnings": .array(.object(["field": .nullable(.values(["merchant", "purchasedDate", "purchasedTime", "totalAmountYen", "taxAmountYen", "items", "adjustments"])),
                                    "code": .text(max: 100), "message": .text(), "index": .nullable(.integer())], optional: ["index"]), max: 100)
    ], optional: ["adjustments", "taxes"])

    static let payroll: KMAPIShape = .object([
        "extraction": .object([
            "documentKind": .values(["pay_slip", "not_pay_slip", "unknown"]), "employerName": .nullable(.payrollText),
            "paymentDate": .nullable(.date), "payPeriod": .nullable(.payrollText), "payType": .values(["salary", "bonus", "other"]),
            "grossPayYen": yen, "netPayYen": yen,
            "deductions": .object(Dictionary(uniqueKeysWithValues: ["incomeTaxYen", "residentTaxYen", "healthInsuranceYen", "pensionYen", "employmentInsuranceYen", "otherYen", "totalYen"].map { ($0, yen) })),
            "allowances": .array(.object(["name": .payrollText, "amountYen": yen]), max: 30),
            "warnings": .array(.object(["field": .nullable(.values(["employerName", "paymentDate", "grossPayYen", "netPayYen", "deductions", "allowances"])),
                                        "code": .values(["unreadable", "uncertain", "amount_mismatch"])]), max: 30)
        ]), "model": .text(max: 100), "promptVersion": .values(["payroll-v1"])
    ])
    static let categoryOptions: KMAPIShape = .array(.object(["id": .text(max: 128), "name": .text(max: 100)]), max: 100)
    static let categoryRequest: KMAPIShape = .object([
        "flowId": .text(max: 36), "categories": categoryOptions,
        "itemIndexes": .array(.integer(max: 29), max: 30),
        "receipt": .object(["merchant": .nullable(.text(max: 200)), "totalAmountYen": yen,
                            "items": .array(.object(["name": .text(max: 200), "amountYen": yen]), max: 30)])
    ], optional: ["itemIndexes"])
    static let categoryAnswers: KMAPIShape = .object([
        "model": .text(max: 500), "answers": .dictionary(.object([
            "type": .values(["choice"]), "choice": .text(max: 128), "confidence": .decimal(min: 0, max: 1),
            "probabilities": .dictionary(.decimal(min: 0, max: 1))
        ]))
    ])
    static func validateReceipt(_ value: KMReceiptExtraction) throws {
        if let time = value.purchasedTime, time.range(of: #"^([01]\d|2[0-3]):[0-5]\d$"#, options: .regularExpression) == nil { throw KMAPIError.invalidResponse }
        guard (value.taxes ?? []).allSatisfy({ !$0.ratePercent.isNaN && $0.ratePercent > 0 && $0.ratePercent <= 100 }),
              value.items.allSatisfy({ $0.quantity == nil || $0.quantity! > 0 }),
              value.items.allSatisfy({ $0.taxRatePercent == nil || (!$0.taxRatePercent!.isNaN && $0.taxRatePercent! > 0 && $0.taxRatePercent! <= 100) }),
              (value.adjustments ?? []).allSatisfy({ $0.targetItemIndex == nil || (0..<value.items.count).contains($0.targetItemIndex!) }) else { throw KMAPIError.invalidResponse }
        for warning in value.warnings {
            if let index = warning.index {
                let count = warning.field == .items ? value.items.count : warning.field == .adjustments ? (value.adjustments?.count ?? 0) : 0
                guard (0..<count).contains(index) else { throw KMAPIError.invalidResponse }
            }
        }
    }

    static func validateOptions(_ options: [KMCategoryOption]) throws {
        guard !options.isEmpty, Set(options.map(\.id)).count == options.count else { throw KMAPIError.invalidRequest }
        _ = try KMAPIValidation.request(options, shape: categoryOptions)
    }
}
