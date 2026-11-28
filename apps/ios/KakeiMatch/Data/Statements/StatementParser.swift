import CryptoKit
import Foundation

struct KMParsedStatementTransaction: Equatable, Sendable {
    var provider: KMStatementProvider
    var externalId: String? = nil
    var kind: KMStatementTransaction.Kind = .purchase
    var usedDate: KMDate
    var usedTime: String? = nil
    var postedDate: KMDate? = nil
    var merchant: String
    var amountYen: Int
    var paymentMethod: String?
    var sourceFingerprint: String
    var duplicateOrdinal: Int
}

struct KMStatementParseIssue: Equatable, Sendable { var rowNumber: Int?; var code: String }
struct KMStatementRowIssue: Equatable, Sendable { var rowNumber: Int; var reason: String }
struct KMStatementParseResult: Equatable, Sendable {
    var transactions: [KMParsedStatementTransaction] = []
    var excludedRows: [KMStatementRowIssue] = []
    var needsReviewRows: [KMStatementRowIssue] = []
    var duplicateRowsInFile = 0
    var totalRows = 0
    var encoding = "utf-8"
    var fatalErrors: [KMStatementParseIssue] = []
    var headerSignature: String?
}

enum KMStatementParser {
    static let maxBytes = 5 * 1024 * 1024
    static let maxRows = 20_000
    static let maxFieldLength = 2_000
    private static let paypayHeaders = ["利用日/キャンセル日", "利用店名・商品名", "利用者", "決済方法", "支払区分", "利用金額", "手数料", "支払総額", "当月支払金額", "翌月以降繰越金額", "調整額", "当月お支払日"]
    private static let rakuten11 = ["利用日", "利用店名・商品名", "利用者", "支払方法", "利用金額", "手数料/利息", "支払総額", "{month}月支払金額", "当月請求額", "{month}月繰越残高", "新規サイン"]
    private static let rakuten12 = ["利用日", "利用店名・商品名", "利用者", "支払方法", "利用金額", "手数料/利息", "支払総額", "支払月", "{month}月支払金額", "当月請求額", "{month}月繰越残高", "{month}月以降請求額"]
    private static let aeonAccountHeader = ["金融機関", "支店", "口座番号", "名義人", "", "", "", "", ""]
    private static let aeonDetailTitle = ["ご利用明細", "", "", "", "", "", "", "", ""]
    private static let aeonDetailHeaders = ["ご利用日", "利用者区分", "ご利用先", "支払方法", "", "", "ご利用金額", "備考", ""]
    private static let aeonSplitTitle = ["分割・ボーナス払い明細", "", "", "", "", "", "", "", ""]
    private static let aeonSplitHeaders = ["ご利用日", "ご利用先", "支払回数", "ご利用金額", "実質年率", "お支払い総額", "今回ご請求金額", "内手数料", "今回回数"]
    private static let aeonSignature = "aeon-card-cp932-v1"

    static func parse(data: Data, provider: KMStatementProvider) -> KMStatementParseResult {
        let bom = data.starts(with: [0xef, 0xbb, 0xbf])
        let isShiftJIS = provider == .smbcCard || provider == .aeonCard
        let encoding = isShiftJIS ? "cp932" : (bom ? "utf-8-bom" : "utf-8")
        func failure(_ code: String) -> KMStatementParseResult { KMStatementParseResult(encoding: encoding, fatalErrors: [.init(rowNumber: nil, code: code)]) }
        if data.isEmpty { return failure("empty_file") }
        if data.count > maxBytes { return failure("limit_exceeded") }
        if data.contains(0) { return failure("invalid_file") }
        let body = bom && !isShiftJIS ? data.dropFirst(3) : data[...]
        let text: String?
        if isShiftJIS {
            text = String(data: data, encoding: .shiftJIS)
        } else { text = String(data: Data(body), encoding: .utf8) }
        guard let text else { return failure("invalid_file") }
        return parse(text: text, provider: provider, encoding: encoding, sourceByteCount: data.count)
    }

    static func parse(text: String, provider: KMStatementProvider, encoding: String = "utf-8", sourceByteCount: Int? = nil) -> KMStatementParseResult {
        func failure(_ code: String) -> KMStatementParseResult { KMStatementParseResult(encoding: encoding, fatalErrors: [.init(rowNumber: nil, code: code)]) }
        if (sourceByteCount ?? text.lengthOfBytes(using: .utf8)) > maxBytes { return failure("limit_exceeded") }
        if text.contains("\0") { return failure("invalid_file") }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return failure("empty_file") }
        guard let csv = CSV(text) else { return failure("malformed_csv") }
        let rows = csv.records
        if rows.isEmpty { return failure("empty_file") }
        if rows.count - 1 > maxRows || rows.contains(where: { $0.contains(where: { $0.utf16.count > maxFieldLength }) }) { return failure("limit_exceeded") }
        switch provider {
        case .smbcCard: return smbc(rows, encoding)
        case .rakutenCard: return rakuten(rows, encoding)
        case .paypayCard: return paypay(rows, encoding)
        case .aeonCard: return aeon(rows, encoding)
        case .paypay: return KMStatementParseResult(totalRows: max(rows.count - 1, 0), encoding: encoding, fatalErrors: [.init(rowNumber: nil, code: "unsupported_provider")])
        }
    }

    private static func digest(_ fields: [String]) -> String {
        let json = (try? JSONSerialization.data(withJSONObject: fields, options: [.fragmentsAllowed, .withoutEscapingSlashes])) ?? Data()
        return SHA256.hash(data: json).map { String(format: "%02x", $0) }.joined()
    }
    private static func fingerprint(_ fields: [String]) -> String {
        // JSON.stringify emits compact UTF-8 arrays, matching the TypeScript fingerprint input.
        let json = "[" + fields.map { string in
            let data = try! JSONSerialization.data(withJSONObject: [string], options: [.fragmentsAllowed, .withoutEscapingSlashes])
            let encoded = String(data: data, encoding: .utf8)!
            return String(encoded.dropFirst().dropLast())
        }.joined(separator: ",") + "]"
        return SHA256.hash(data: Data(json.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private static func yen(_ value: String, signed: Bool = false) -> Int? {
        let s = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return 0 }
        let pattern = signed ? #"^-?(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)$"# : #"^(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)$"#
        guard s.range(of: pattern, options: .regularExpression) != nil, let n = Int(s.replacingOccurrences(of: ",", with: "")), n >= -9_007_199_254_740_991 && n <= 9_007_199_254_740_991 else { return nil }
        return n
    }
    private static func strictYen(_ s: String) -> Int? {
        guard s.range(of: #"^[1-9][0-9]*$"#, options: .regularExpression) != nil, let n = Int(s), n <= 9_007_199_254_740_991 else { return nil }; return n
    }
    private static func validatedDate(year: Int, month: Int, day: Int) -> String? {
        guard (1...12).contains(month), let valid = try? KMDate(String(format: "%04d-%02d-%02d", year, month, day)) else { return nil }
        return valid.rawValue
    }
    private static func date(_ s: String, flexible: Bool = false) -> String? {
        let p = flexible ? #"^([0-9]{4})/([0-9]{1,2})/([0-9]{1,2})$"# : #"^([0-9]{4})/([0-9]{2})/([0-9]{2})$"#
        guard let m = s.range(of: p, options: .regularExpression), let re = try? NSRegularExpression(pattern: p), let match = re.firstMatch(in: s, range: NSRange(m, in: s)) else { return nil }
        let parts = (1...3).compactMap { Range(match.range(at: $0), in: s).map { String(s[$0]) } }
        guard parts.count == 3, let yyyy = Int(parts[0]), let mm = Int(parts[1]), let dd = Int(parts[2]) else { return nil }
        return validatedDate(year: yyyy, month: mm, day: dd)
    }
    private static func aeonDate(_ s: String) -> String? {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.range(of: #"^[0-9]{6}$"#, options: .regularExpression) != nil,
              let yy = Int(trimmed.prefix(2)),
              let mm = Int(trimmed.dropFirst(2).prefix(2)),
              let dd = Int(trimmed.suffix(2)) else { return nil }
        return validatedDate(year: 2000 + yy, month: mm, day: dd)
    }
    private static func resultDate(_ value: String) -> KMDate { try! KMDate(value) }
    private static func rowIssue(_ number: Int, _ reason: String) -> KMStatementRowIssue { .init(rowNumber: number, reason: reason) }
    private static func empty(_ code: String, _ encoding: String, rows: Int = 0, signature: String? = nil) -> KMStatementParseResult { KMStatementParseResult(totalRows: rows, encoding: encoding, fatalErrors: [.init(rowNumber: nil, code: code)], headerSignature: signature) }

    private static func smbc(_ rows: [[String]], _ encoding: String) -> KMStatementParseResult {
        guard let metadata = rows.first, metadata.count == 3, let footer = rows.last, footer.count == 7, rows.count > 2 else { return empty("unsupported_layout", encoding, rows: max(rows.count - 2, 0)) }
        let details = Array(rows.dropFirst().dropLast()); guard details.allSatisfy({ $0.count == 7 }), (footer[0..<5].allSatisfy { $0.isEmpty }), footer[6].isEmpty, let total = strictYen(footer[5]), total > 0 else { return empty("unsupported_layout", encoding, rows: details.count) }
        _ = metadata
        var out = KMStatementParseResult(totalRows: details.count, encoding: encoding, headerSignature: "smbc-vpass-cp932-v1")
        var ordinals: [String: Int] = [:]; var sum = 0
        for (i, row) in details.enumerated() {
            let n = i + 2
            if row.contains(where: { $0.utf16.count > maxFieldLength }) { out.needsReviewRows.append(rowIssue(n, "明細の項目が長すぎます")); continue }
            let d = date(row[0]), amount = strictYen(row[2]), billed = strictYen(row[5]); var reason: String?
            if d == nil { reason = "利用日を確認できません" }
            else if row[1].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { reason = "利用先を確認できません" }
            else if row[1].range(of: #"年会費|手数料|キャッシング|利息|遅延損害金|取消|キャンセル|返金|返品|ボーナス|海外利用"#, options: .regularExpression) != nil { reason = "特殊な利用の可能性があります" }
            else if amount == nil || amount! <= 0 { reason = "利用金額を確認できません" }
            else if row[3] != "１" || row[4] != "１" { reason = "1回払い以外の可能性があります" }
            else if billed == nil || billed! <= 0 || amount != billed { reason = "利用金額と支払金額が一致しません" }
            else if !row[6].isEmpty { reason = "通常購入の形式ではありません" }
            if let reason { out.needsReviewRows.append(rowIssue(n, reason)); continue }
            let fp = fingerprint(["smbc_card", "purchase", d!, row[1], String(amount!), "１回払い"]); ordinals[fp, default: 0] += 1
            out.transactions.append(.init(provider: .smbcCard, usedDate: resultDate(d!), merchant: row[1], amountYen: amount!, paymentMethod: "1回払い", sourceFingerprint: fp, duplicateOrdinal: ordinals[fp]!))
            let (next, overflow) = sum.addingReportingOverflow(billed!); if overflow || next > 9_007_199_254_740_991 { return empty("unsupported_layout", encoding, rows: details.count) }; sum = next
        }
        if out.needsReviewRows.isEmpty && sum != total { return empty("unsupported_layout", encoding, rows: details.count) }
        return out
    }

    private static func aeon(_ rows: [[String]], _ encoding: String) -> KMStatementParseResult {
        guard rows.count >= 10, rows.allSatisfy({ $0.count == 9 }) else {
            return empty("unsupported_layout", encoding, rows: max(rows.count - 10, 0))
        }
        // Treat the leading metadata and bank account rows as private, opaque metadata:
        // their values must never appear in parse results, signatures, or errors.
        let rawBilled = rows[1][1]
        guard rows[0][0] == "ご利用カード", !rows[0][1].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, rows[0][2...].allSatisfy(\.isEmpty),
              rows[1][0] == "今回ご請求金額", !rawBilled.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let billedTotal = yen(rawBilled), billedTotal >= 0, rows[1][2...].allSatisfy(\.isEmpty),
              rows[2][0] == "お支払い日", !rows[2][1].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, rows[2][2...].allSatisfy(\.isEmpty),
              rows[3][0] == "ご指定口座", rows[3][1...].allSatisfy(\.isEmpty),
              rows[4] == aeonAccountHeader,
              rows[5][4...].allSatisfy(\.isEmpty),
              rows[6] == aeonDetailTitle,
              rows[7] == aeonDetailHeaders else {
            return empty("unsupported_layout", encoding, rows: max(rows.count - 10, 0))
        }
        guard let splitTitleIndex = rows[8...].firstIndex(where: { $0 == aeonSplitTitle }) else {
            return empty("unsupported_layout", encoding, rows: max(rows.count - 8, 0))
        }
        let splitHeaderIndex = splitTitleIndex + 1
        guard splitHeaderIndex < rows.count, rows[splitHeaderIndex] == aeonSplitHeaders else {
            return empty("unsupported_layout", encoding, rows: max(rows.count - 10, 0))
        }
        let detailRows = Array(rows[8..<splitTitleIndex])
        let splitDetailRows = Array(rows[(splitHeaderIndex + 1)...])
        if splitDetailRows.contains(where: { $0 == aeonSplitTitle || $0 == aeonDetailTitle || $0 == aeonDetailHeaders || $0 == aeonSplitHeaders }) {
            return empty("unsupported_layout", encoding, rows: detailRows.count + splitDetailRows.count)
        }
        let totalRows = detailRows.count + splitDetailRows.count
        guard totalRows > 0 else {
            return empty("header_only", encoding, signature: aeonSignature)
        }

        var out = KMStatementParseResult(totalRows: totalRows, encoding: encoding, headerSignature: aeonSignature)
        var ordinals: [String: Int] = [:]
        var sum = 0
        var cancellations = Set<String>()
        for row in detailRows {
            let merchant = row[2].trimmingCharacters(in: .whitespacesAndNewlines)
            if let amount = yen(row[6], signed: true), amount < 0 {
                cancellations.insert("\(merchant)|\(-amount)")
            }
        }

        for (offset, row) in detailRows.enumerated() {
            let rowNumber = 8 + offset + 1
            if row.allSatisfy({ $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
                out.excludedRows.append(rowIssue(rowNumber, "non_expense"))
                continue
            }
            let rawDate = row[0], rawMerchant = row[2], rawMethod = row[3], rawAmount = row[6], rawNote = row[7]
            let trimmedMerchant = rawMerchant.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedMethod = rawMethod.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedNote = rawNote.trimmingCharacters(in: .whitespacesAndNewlines)
            let d = aeonDate(rawDate)
            let amount = yen(rawAmount, signed: true)
            var reason: String?
            if d == nil { reason = "利用日を確認できません" }
            else if trimmedMerchant.isEmpty { reason = "利用先を確認できません" }
            else if rawMerchant.range(of: #"年会費|手数料|キャッシング|利息|遅延損害金|取消|キャンセル|返金|返品|ボーナス|海外利用"#, options: .regularExpression) != nil {
                reason = "特殊な利用の可能性があります"
            }
            else if trimmedNote.range(of: #"取消|キャンセル|返金|返品"#, options: .regularExpression) != nil {
                reason = "返金・取消の可能性があります"
            }
            else if rawAmount.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || amount == nil { reason = "利用金額を確認できません" }
            else if let amount, amount < 0 { reason = "返金・取消の可能性があります" }
            else if let amount, cancellations.contains("\(trimmedMerchant)|\(amount)") { reason = "同じCSVにキャンセル明細があるため確認してください" }
            else if let amount, amount <= 0 { reason = "利用金額を確認できません" }
            else if trimmedMethod != "１回" { reason = "1回払い以外の可能性があります" }
            else if !row[4].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !row[5].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !row[8].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                reason = "通常購入の形式ではありません"
            }
            if let reason {
                out.needsReviewRows.append(rowIssue(rowNumber, reason))
                continue
            }
            let purchaseAmount = amount!
            let fp = fingerprint(["aeon_card", "purchase", d!, rawMerchant, String(purchaseAmount), trimmedMethod])
            ordinals[fp, default: 0] += 1
            out.transactions.append(.init(
                provider: .aeonCard,
                usedDate: resultDate(d!),
                merchant: rawMerchant,
                amountYen: purchaseAmount,
                paymentMethod: "1回払い",
                sourceFingerprint: fp,
                duplicateOrdinal: ordinals[fp]!
            ))
            let (next, overflow) = sum.addingReportingOverflow(purchaseAmount)
            if overflow || next > 9_007_199_254_740_991 {
                return empty("unsupported_layout", encoding, rows: totalRows)
            }
            sum = next
        }

        for (offset, row) in splitDetailRows.enumerated() {
            let rowNumber = splitHeaderIndex + 1 + offset + 1
            if row.allSatisfy({ $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
                out.excludedRows.append(rowIssue(rowNumber, "non_expense"))
                continue
            }
            out.needsReviewRows.append(rowIssue(rowNumber, "分割・ボーナス払い明細のため確認してください"))
        }

        if out.needsReviewRows.isEmpty && sum != billedTotal {
            return empty("unsupported_layout", encoding, rows: totalRows)
        }
        return out
    }

    private static func paypay(_ rows: [[String]], _ encoding: String) -> KMStatementParseResult {
        let body = Array(rows.dropFirst()); guard let head = rows.first, head == paypayHeaders else { return empty("header_mismatch", encoding, rows: body.count) }
        guard !body.isEmpty else { return empty("header_only", encoding, signature: "paypay-card-statement-v1") }
        var out = KMStatementParseResult(totalRows: body.count, encoding: encoding, headerSignature: "paypay-card-statement-v1"); var ordinals: [String: Int] = [:]
        var cancellations = Set<String>()
        for row in body where row.count == 12 { let merchant = row[1].trimmingCharacters(in: .whitespacesAndNewlines); for s in row[5..<11] { if let n = yen(s, signed: true), n < 0 { cancellations.insert("\(merchant)|\(-n)") } } }
        for (i, r) in body.enumerated() {
            let n = i + 2
            if r.count != 12 || r.contains(where: { $0.utf16.count > maxFieldLength }) { out.fatalErrors.append(.init(rowNumber: n, code: r.contains(where: { $0.utf16.count > maxFieldLength }) ? "limit_exceeded" : "invalid_row")); continue }
            let d = date(r[0].trimmingCharacters(in: .whitespacesAndNewlines), flexible: true), pd = date(r[11].trimmingCharacters(in: .whitespacesAndNewlines), flexible: true), merchant = r[1].trimmingCharacters(in: .whitespacesAndNewlines)
            let amounts = r[5...10].map { yen($0, signed: true) }; var reason: String?
            if d == nil { reason = "利用日を確認できません" } else if pd == nil { reason = "当月お支払日を確認できません" } else if merchant.isEmpty { reason = "利用先を確認できません" } else if amounts.contains(where: { $0 == nil }) { reason = "金額欄を確認できません" } else if r[3].trimmingCharacters(in: .whitespacesAndNewlines) != "PayPayクレジット" { reason = "PayPayクレジット以外の決済方法です" } else if r[4].trimmingCharacters(in: .whitespacesAndNewlines) != "1回" { reason = "1回払い以外の可能性があります" } else if merchant.range(of: #"キャンセル|取消|返金|返品"#, options: .regularExpression) != nil { reason = "返金・取消の可能性があります" }
            if reason == nil, let a = amounts[0], let fee = amounts[1], let total = amounts[2], let current = amounts[3], let carry = amounts[4], let adjust = amounts[5] {
                if a < 0 { reason = "返金・取消の可能性があります" } else if cancellations.contains("\(merchant)|\(a)") { reason = "同じCSVにキャンセル明細があるため確認してください" } else if a <= 0 { reason = "利用金額を確認できません" } else if fee != 0 || total != a || current != a || carry != 0 || adjust != 0 { reason = "支払額に手数料・繰越・調整が含まれる可能性があります" }
            }
            if let reason { out.needsReviewRows.append(rowIssue(n, reason)); continue }
            let amount = amounts[0]!; let method = r[3].trimmingCharacters(in: .whitespacesAndNewlines); let type = r[4].trimmingCharacters(in: .whitespacesAndNewlines)
            let fp = fingerprint(["paypay_card", "purchase", d!, merchant, String(amount), method, type]); ordinals[fp, default: 0] += 1
            out.transactions.append(.init(provider: .paypayCard, usedDate: resultDate(d!), merchant: merchant, amountYen: amount, paymentMethod: "\(method)（\(type)）", sourceFingerprint: fp, duplicateOrdinal: ordinals[fp]!))
        }
        if !out.fatalErrors.isEmpty { out.transactions = [] }; return out
    }

    private static func headerMatches(_ headers: [String], template: [String]) -> Bool {
        guard headers.count == template.count else { return false }
        return zip(headers, template).allSatisfy { h, t in
            if t.contains("{month}") { let pattern = "^" + NSRegularExpression.escapedPattern(for: t).replacingOccurrences(of: "\\{month\\}", with: "(?:[1-9]|1[0-2])") + "$"; return h.range(of: pattern, options: .regularExpression) != nil }
            return h == t
        }
    }
    private static func rakuten(_ rows: [[String]], _ encoding: String) -> KMStatementParseResult {
        guard let headers = rows.first else { return empty("empty_file", encoding) }; let body = Array(rows.dropFirst())
        let twelve = headerMatches(headers, template: rakuten12); let eleven = headerMatches(headers, template: rakuten11)
        guard twelve || eleven else { return empty("header_mismatch", encoding, rows: body.count) }
        let template = twelve ? rakuten12 : rakuten11; let signature = (try? JSONSerialization.data(withJSONObject: template)) .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        guard !body.isEmpty else { return empty("header_only", encoding, signature: signature) }
        if body.contains(where: { $0.count != template.count }) { return empty("unsupported_layout", encoding, rows: body.count, signature: signature) }
        if body.contains(where: { $0.contains(where: { $0.utf16.count > maxFieldLength }) }) { return empty("limit_exceeded", encoding, rows: body.count, signature: signature) }
        var out = KMStatementParseResult(totalRows: body.count, encoding: encoding, headerSignature: signature); var ordinals: [String: Int] = [:]; var prior: (row: Int, fingerprint: String)?
        var inCancellationSection = false
        func addReview(_ row: Int, _ reason: String, continuation: Bool) {
            if continuation, let p = prior, p.row == row - 1 { out.transactions.removeAll { $0.sourceFingerprint == p.fingerprint && $0.duplicateOrdinal == (ordinals[p.fingerprint] ?? 1) }; ordinals[p.fingerprint] = max((ordinals[p.fingerprint] ?? 1) - 1, 0); out.needsReviewRows.append(rowIssue(p.row, "複数行明細の可能性があるため確認してください")) }
            out.needsReviewRows.append(rowIssue(row, reason)); prior = nil
        }
        for (i, r) in body.enumerated() {
            let n = i + 2
            if r.allSatisfy({ $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { out.excludedRows.append(rowIssue(n, "non_expense")); prior = nil; continue }
            if r[0].trimmingCharacters(in: .whitespacesAndNewlines) == "■ご利用キャンセルなど" && r.dropFirst().allSatisfy({ $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
                out.excludedRows.append(rowIssue(n, "non_expense")); prior = nil; inCancellationSection = true; continue
            }
            if inCancellationSection { addReview(n, "返金・取消の可能性があります", continuation: false); continue }
            let annotation = r[1].precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespacesAndNewlines)
            if prior?.row == n - 1 && r[0].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                annotation.range(of: #"^現地利用額\s*\d+(?:\.\d+)?\s*変換レート\s*\d+(?:\.\d+)?円$"#, options: .regularExpression) != nil &&
                r.dropFirst(2).allSatisfy({ $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
                out.excludedRows.append(rowIssue(n, "non_expense")); prior = nil; continue
            }
            let rawDate = r[0], merchant = r[1], method = r[3], rawAmount = r[4]; let monthly = r[twelve ? 8 : 7], current = r[twelve ? 9 : 8], carry = r[twelve ? 10 : 9], newSign = twelve ? "" : r[10], future = twelve ? r[11] : ""
            let d = date(rawDate), amount = yen(rawAmount), missing = [r[6], monthly, current].contains { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            let continuation = rawDate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (!twelve && missing)
            let others = [r[5], r[6], monthly, current, carry, future].map { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : yen($0) }
            var reason: String?
            if rawDate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { reason = "継続行または部分行の可能性があります" }
            else if d == nil { reason = "利用日を確認できません" }
            else if rawAmount.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("-") || merchant.range(of: #"取消|キャンセル|返金|返品"#, options: .regularExpression) != nil { reason = "返金・取消の可能性があります" }
            else if method != "1回払い" { reason = "1回払い以外の可能性があります" }
            else if amount == nil || amount! <= 0 { reason = "利用金額を確認できません" }
            else if others.contains(where: { $0 == nil }) { reason = "支払金額欄を確認できません" }
            else if twelve && r[7].range(of: #"^(?:[1-9]|1[0-2])月$"#, options: .regularExpression) == nil { reason = "支払月を確認できません" }
            else if (yen(r[5]) ?? 0) > 0 || !["", "*"].contains(newSign.trimmingCharacters(in: .whitespacesAndNewlines)) || (yen(future) ?? 0) > 0 { reason = "通常購入の形式ではありません" }
            else if missing { reason = "複数行明細または部分行の可能性があります" }
            if let reason { addReview(n, reason, continuation: continuation); continue }
            let fp = fingerprint(["rakuten_card", "purchase", d!, merchant, String(amount!), method]); ordinals[fp, default: 0] += 1
            out.transactions.append(.init(provider: .rakutenCard, usedDate: resultDate(d!), merchant: merchant, amountYen: amount!, paymentMethod: method, sourceFingerprint: fp, duplicateOrdinal: ordinals[fp]!)); prior = (n, fp)
        }
        return out
    }
}

private struct CSV {
    var records: [[String]] = []
    init?(_ text: String) {
        var row: [String] = [], field = "", quoted = false, closedQuote = false
        let chars = Array(text); var i = 0
        while i < chars.count {
            let c = chars[i]
            if quoted {
                if c == "\"" { if i + 1 < chars.count && chars[i + 1] == "\"" { field.append("\""); i += 1 } else { quoted = false; closedQuote = true } }
                else { field.append(c) }
            } else if c == "," { row.append(field); field = ""; closedQuote = false }
            else if c == "\r" || c == "\n" || c == "\r\n" { row.append(field); field = ""; if !(row.count == 1 && row[0].isEmpty) { records.append(row) }; row = []; closedQuote = false; if c == "\r" && i + 1 < chars.count && chars[i + 1] == "\n" { i += 1 } }
            else if c == "\"" { if !field.isEmpty || closedQuote { return nil }; quoted = true }
            else { if closedQuote { return nil }; field.append(c) }
            i += 1
        }
        if quoted { return nil }
        if !field.isEmpty || !row.isEmpty { row.append(field); if !(row.count == 1 && row[0].isEmpty) { records.append(row) } }
    }
}
