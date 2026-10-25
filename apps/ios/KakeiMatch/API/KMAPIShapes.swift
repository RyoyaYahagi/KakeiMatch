import Foundation

enum KMAPIShapes {
    static let instant = KMAPIShape.text(max: 40) // Date decoding below verifies ISO8601 including timezone.
    static let cloudSession: KMAPIShape = .nullable(.object([
        "user": .object(["id": .text(max: 128), "name": .text(max: 120), "email": .text(max: 254), "emailVerified": .boolean,
                         "image": .nullable(.text(max: 2048)), "createdAt": instant, "updatedAt": instant], optional: ["image"]),
        "session": .object(["id": .text(max: 128), "userId": .text(max: 128), "token": .text(max: 8192), "expiresAt": instant,
                            "createdAt": instant, "updatedAt": instant, "ipAddress": .nullable(.text(max: 128)), "userAgent": .nullable(.text(max: 2048))], optional: ["ipAddress", "userAgent"])
    ]))
    static let passkeys: KMAPIShape = .array(.object([
        "id": .text(max: 128), "name": .nullable(.text(max: 500)), "publicKey": .text(max: 8192), "userId": .text(max: 128),
        "credentialID": .text(max: 2048), "counter": .integer(), "deviceType": .values(["singleDevice", "multiDevice"]),
        "backedUp": .boolean, "transports": .nullable(.text(min: 0, max: 500)), "createdAt": .nullable(instant), "aaguid": .nullable(.text(max: 36))
    ], optional: ["name", "transports", "createdAt", "aaguid"]), max: 100)
    static let yen = KMAPIShape.nullable(.integer())
    static let receipt: KMAPIShape = .object([
        "documentKind": .values(["receipt", "not_receipt", "unknown"]), "merchant": .nullable(.text()),
        "purchasedDate": .nullable(.date), "purchasedTime": .nullable(.text(max: 5)),
        "totalAmountYen": yen, "taxAmountYen": yen,
        "items": .array(.object(["name": .text(), "amountYen": yen,
                                "quantity": .decimal(min: 0, max: Decimal.greatestFiniteMagnitude), "unitPriceYen": yen], optional: ["quantity", "unitPriceYen"]), max: 100),
        "adjustments": .array(.object(["label": .text(), "amountYen": .integer(min: -9_007_199_254_740_991),
                                       "targetItemIndex": .nullable(.integer())], optional: ["targetItemIndex"]), max: 100),
        "warnings": .array(.object(["field": .nullable(.values(["merchant", "purchasedDate", "purchasedTime", "totalAmountYen", "taxAmountYen", "items", "adjustments"])),
                                    "code": .text(max: 100), "message": .text(), "index": .nullable(.integer())], optional: ["index"]), max: 100)
    ], optional: ["adjustments"])

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
    static let token: KMAPIShape = .object(["token": .text(max: 8192), "expiresAt": .integer(min: 1)])
    static let guestConfig: KMAPIShape = .object(["guestAvailable": .boolean, "turnstileSiteKey": .nullable(.text(max: 2048))])
    static let guestCreated: KMAPIShape = .object(["guestSecret": .text(min: 43, max: 43)])
    static let contactResult: KMAPIShape = .object(["feedbackId": .text(max: 128), "kind": .values(["bug", "improvement", "question"]), "reply": .text(max: 2000), "issueUrl": .null])
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
    static let costProvider: KMAPIShape = .object(Dictionary(uniqueKeysWithValues: ["requests", "inputTokens", "outputTokens", "costUsdMicros", "unknownRequests"].map { ($0, .integer()) }))
    static let costs: KMAPIShape = .object([
        "month": .month, "currency": .values(["USD"]), "totalUsdMicros": .integer(), "unknownRequests": .integer(),
        "providers": .object(["gemini": costProvider, "jev": costProvider])
    ])

    static func validateReceipt(_ value: KMReceiptExtraction) throws {
        if let time = value.purchasedTime, time.range(of: #"^([01]\d|2[0-3]):[0-5]\d$"#, options: .regularExpression) == nil { throw KMAPIError.invalidResponse }
        guard value.items.allSatisfy({ $0.quantity == nil || $0.quantity! > 0 }),
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
