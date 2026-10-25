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

    static func parse(data: Data, provider: KMStatementProvider) -> KMStatementParseResult {
        let bom = data.starts(with: [0xef, 0xbb, 0xbf])
        let encoding = provider == .smbcCard ? "cp932" : (bom ? "utf-8-bom" : "utf-8")
        func failure(_ code: String) -> KMStatementParseResult { KMStatementParseResult(encoding: encoding, fatalErrors: [.init(rowNumber: nil, code: code)]) }
        if data.isEmpty { return failure("empty_file") }
        if data.count > maxBytes { return failure("limit_exceeded") }
        if data.contains(0) { return failure("invalid_file") }
        let body = bom && provider != .smbcCard ? data.dropFirst(3) : data[...]
        let stringEncoding: String.Encoding = provider == .smbcCard ? .windowsCP1252 : .utf8
        let text: String?
        if provider == .smbcCard {
            text = String(data: data, encoding: .shiftJIS)
        } else { text = String(data: Data(body), encoding: stringEncoding) }
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
        case .aeonCard, .paypay: return KMStatementParseResult(totalRows: max(rows.count - 1, 0), encoding: encoding, fatalErrors: [.init(rowNumber: nil, code: "unsupported_provider")])
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
    private static func date(_ s: String, flexible: Bool = false) -> String? {
        let p = flexible ? #"^([0-9]{4})/([0-9]{1,2})/([0-9]{1,2})$"# : #"^([0-9]{4})/([0-9]{2})/([0-9]{2})$"#
        guard let m = s.range(of: p, options: .regularExpression), let re = try? NSRegularExpression(pattern: p), let match = re.firstMatch(in: s, range: NSRange(m, in: s)) else { return nil }
        let parts = (1...3).compactMap { Range(match.range(at: $0), in: s).map { String(s[$0]) } }
        guard parts.count == 3, let yyyy = Int(parts[0]), let mm = Int(parts[1]), let dd = Int(parts[2]), (1...12).contains(mm), let valid = try? KMDate(String(format: "%04d-%02d-%02d", yyyy, mm, dd)) else { return nil }; return valid.rawValue
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
        func addReview(_ row: Int, _ reason: String, continuation: Bool) {
            if continuation, let p = prior, p.row == row - 1 { out.transactions.removeAll { $0.sourceFingerprint == p.fingerprint && $0.duplicateOrdinal == (ordinals[p.fingerprint] ?? 1) }; ordinals[p.fingerprint] = max((ordinals[p.fingerprint] ?? 1) - 1, 0); out.needsReviewRows.append(rowIssue(p.row, "複数行明細の可能性があるため確認してください")) }
            out.needsReviewRows.append(rowIssue(row, reason)); prior = nil
        }
        for (i, r) in body.enumerated() {
            let n = i + 2
            if twelve && r.allSatisfy({ $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { out.excludedRows.append(rowIssue(n, "non_expense")); prior = nil; continue }
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
            else if (yen(r[5]) ?? 0) > 0 || !newSign.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (yen(future) ?? 0) > 0 { reason = "通常購入の形式ではありません" }
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
