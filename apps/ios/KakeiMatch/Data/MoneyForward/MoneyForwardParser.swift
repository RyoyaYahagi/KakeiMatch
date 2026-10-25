import CryptoKit
import Foundation

struct KMMoneyForwardRow: Equatable, Sendable {
    var rowNumber: Int
    var date: KMDate
    var description: String
    var amountYen: Int
    var kind: Kind
    var accountName: String?
    var majorCategory: String
    var minorCategory: String
    var memo: String
    var sourceTransactionId: String?
    var sourceKey: String
    var isTransfer: Bool
    var isIncludedInCalculation: Bool
    var categoryNeedsReviewReason: String?
    enum Kind: String, Equatable, Sendable { case expense, income }
}
struct KMMoneyForwardRowIssue: Equatable, Sendable { var rowNumber: Int; var reason: String }
struct KMMoneyForwardParseError: Equatable, Sendable { var rowNumber: Int?; var code: String }
struct KMMoneyForwardParseResult: Equatable, Sendable {
    var transactions: [KMMoneyForwardRow] = []
    var excludedRows: [KMMoneyForwardRowIssue] = []
    var rowErrors: [KMMoneyForwardRowIssue] = []
    var totalRows = 0
    var encoding = "utf-8"
    var fatalErrors: [KMMoneyForwardParseError] = []
    var headerSignature: String?
    var foundHeaders: [String]?
    var missingHeaders: [String]?
    var unknownHeaders: [String]?
    var duplicateHeaders: [String]?
}
struct KMMoneyForwardCategory: Equatable, Sendable { var id: String; var name: String; var isIncome: Bool; var hidden: Bool }
struct KMMoneyForwardCategoryResolution: Equatable, Sendable { var categoryId: String?; var suggestedName: String?; var reason: String }
enum KMMoneyForwardCategoryChoice: Equatable, Sendable { case existing(id: String), new(name: String), unclassified, exclude, unresolved }

enum KMMoneyForwardParser {
    static let maxBytes = 5 * 1024 * 1024
    static let maxRows = 20_000
    static let maxFieldLength = 2_000
    private static let aliases: [(String, [String])] = [
        ("date", ["日付"]), ("description", ["内容", "摘要"]), ("amount", ["金額(円)", "金額（円）", "金額"]),
        ("account", ["保有金融機関", "口座"]), ("major", ["大項目"]), ("minor", ["中項目"]), ("memo", ["メモ"]),
        ("transfer", ["振替", "振替フラグ"]), ("calculation", ["計算対象"]), ("id", ["ID", "取引ID", "明細ID"])
    ]
    private static let categoryTargets: [String: [String: String]] = [
        "expense": ["食費":"食費", "日用品":"日用品", "趣味・娯楽":"趣味・娯楽", "交際費":"交際費", "交通費":"交通", "衣服・美容":"衣服・美容", "健康・医療":"医療・健康", "自動車":"交通", "教養・教育":"教育・学習", "特別な支出":"その他", "現金・カード":"現金・カード", "水道・光熱費":"水道・光熱", "通信費":"通信", "住宅":"住居", "税・社会保障":"税・社会保障", "保険":"保険", "その他":"その他", "未分類":"未分類"],
        "income": ["収入":"収入", "臨時収入":"臨時収入", "給与":"給与", "賞与":"賞与", "事業・副業":"事業・副業", "年金":"年金", "配当":"配当", "配当所得":"配当所得", "一時所得":"一時所得", "不動産所得":"不動産所得", "不明な入金":"不明な入金", "その他入金":"その他入金", "その他":"その他", "未分類":"未分類"]
    ]
    private static let minorTargets: [String: String] = {
        let pairs: [(String,String,String)] = [
            ("食費","食料品","食費"),("食費","外食","外食"),("食費","朝ご飯","外食"),("食費","昼ご飯","外食"),("食費","夜ご飯","外食"),("食費","カフェ","外食"),
            ("趣味・娯楽","アウトドア","趣味・娯楽"),("趣味・娯楽","スポーツ","趣味・娯楽"),("趣味・娯楽","映画・音楽・ゲーム","趣味・娯楽"),("趣味・娯楽","本","趣味・娯楽"),("趣味・娯楽","旅行","趣味・娯楽"),
            ("交通費","電車","交通"),("交通費","バス","交通"),("交通費","タクシー","交通"),("交通費","航空券","交通"),
            ("衣服・美容","衣服","衣服・美容"),("衣服・美容","クリーニング","衣服・美容"),("衣服・美容","美容院・理髪","衣服・美容"),("衣服・美容","化粧品","衣服・美容"),("衣服・美容","アクセサリー","衣服・美容"),
            ("健康・医療","医療費","医療・健康"),("健康・医療","薬","医療・健康"),("健康・医療","フィットネス","医療・健康"),("健康・医療","ボディケア","医療・健康"),
            ("自動車","ガソリン","交通"),("自動車","自動車ローン","交通"),("自動車","駐車場","交通"),("自動車","高速道路","交通"),("自動車","自動車保険","交通"),
            ("教養・教育","学費","教育・学習"),("教養・教育","習い事","教育・学習"),("教養・教育","塾","教育・学習"),("教養・教育","子育て","教育・学習"),("教養・教育","本","教育・学習"),("教養・教育","雑誌","教育・学習"),
            ("水道・光熱費","電気","水道・光熱"),("水道・光熱費","ガス","水道・光熱"),("水道・光熱費","水道","水道・光熱"),("通信費","携帯電話","通信"),("通信費","インターネット","通信"),
            ("住宅","家賃","住居"),("住宅","住宅ローン","住居"),("住宅","管理費・積立金","住居"),("住宅","地震・火災保険","住居"),
            ("税・社会保障","所得税","その他"),("税・社会保障","住民税","その他"),("税・社会保障","年金保険料","その他"),("税・社会保障","健康保険","医療・健康"),
            ("保険","生命保険","保険"),("保険","医療保険","保険")]
        return Dictionary(uniqueKeysWithValues: pairs.map { ("\($0.0)|\($0.1)", $0.2) })
    }()
    private static let labels = ["食費":"食費", "外食":"外食", "日用品":"日用品", "趣味・娯楽":"趣味・娯楽", "交際費":"交際費", "交通":"交通", "交通費":"交通", "衣服・美容":"衣服・美容", "医療・健康":"医療・健康", "健康・医療":"医療・健康", "教育・学習":"教育・学習", "水道・光熱":"水道・光熱", "水道・光熱費":"水道・光熱", "通信":"通信", "通信費":"通信", "住居":"住居", "住宅":"住居", "その他":"その他"]

    static func parse(data: Data, now: Date = Date()) -> KMMoneyForwardParseResult {
        if data.count > maxBytes { return failure("limit_exceeded") }
        let bom = data.starts(with: [0xef,0xbb,0xbf]); var encoding = bom ? "utf-8-bom" : "utf-8"
        if data.isEmpty { return failure("empty_file", encoding) }; if data.count > maxBytes { return failure("limit_exceeded", encoding) }; if data.contains(0) { return failure("invalid_file") }
        let raw = bom ? Data(data.dropFirst(3)) : data
        var text = String(data: raw, encoding: .utf8)
        if text == nil { text = String(data: data, encoding: .shiftJIS); encoding = "shift_jis" }
        guard let text else { return failure("invalid_file") }
        guard let csv = MFCSV(text) else { return failure("malformed_csv", encoding) }
        if csv.records.isEmpty { return failure("empty_file", encoding) }
        if csv.records.count - 1 > maxRows || csv.records.contains(where: { $0.fields.contains(where: { $0.utf16.count > maxFieldLength }) }) { return failure("limit_exceeded", encoding) }
        let rows = csv.records.enumerated().filter { $0.offset == 0 || $0.element.fields.contains(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) }
        let records = rows.map { $0.element.fields }, lineEnds = rows.map { $0.element.lineEnd }
        let headers = records[0]
        if records.count == 1 { return KMMoneyForwardParseResult(encoding: encoding, fatalErrors: [.init(rowNumber: nil, code: "header_only")], headerSignature: signature(headers)) }
        let columns = Dictionary(uniqueKeysWithValues: aliases.map { key, names in (key, headers.firstIndex(where: { names.map(headerKey).contains(headerKey($0)) }) ?? -1) })
        let required = [("date","日付"),("description","内容"),("amount","金額（円）"),("major","大項目")]
        let missing = required.filter { columns[$0.0]! < 0 }.map { $0.1 }
        let duplicate = required.filter { key, _ in headers.filter { value in aliases.first(where: { $0.0 == key })!.1.map(headerKey).contains(headerKey(value)) }.count > 1 }.map { $0.1 }
        let known = Set(aliases.flatMap { $0.1 }.map(headerKey)); let found = headers.filter { known.contains(headerKey($0)) }; let unknown = headers.filter { !known.contains(headerKey($0)) }
        if !missing.isEmpty || !duplicate.isEmpty {
            return KMMoneyForwardParseResult(totalRows: records.count - 1, encoding: encoding, fatalErrors: [.init(rowNumber: nil, code: "header_mismatch")], foundHeaders: found, missingHeaders: missing, unknownHeaders: unknown, duplicateHeaders: duplicate)
        }
        let sig = signature(headers), today = KMDate(instant: now); var out = KMMoneyForwardParseResult(totalRows: records.count - 1, encoding: encoding, headerSignature: sig)
        for i in 1..<records.count {
            let row = records[i], line = lineEnds[i]
            guard row.count == headers.count else { out.rowErrors.append(.init(rowNumber: line, reason: "CSVの列数が見出しと一致しません")); continue }
            func get(_ key: String) -> String { let col = columns[key, default: -1]; return col < 0 ? "" : row[col].trimmingCharacters(in: .whitespacesAndNewlines) }
            guard let day = parseDate(get("date")) else { out.rowErrors.append(.init(rowNumber: line, reason: "日付を確認できません")); continue }
            if day > today { out.excludedRows.append(.init(rowNumber: line, reason: "future_date")); continue }
            guard let amount = parseYen(get("amount")), amount != 0 else { out.rowErrors.append(.init(rowNumber: line, reason: "金額を確認できません")); continue }
            let major = get("major"), minor = get("minor"), transferValue = get("transfer"), calculationValue = get("calculation")
            guard let transfer = flag(transferValue, defaultValue: false) else { out.rowErrors.append(.init(rowNumber: line, reason: "振替の値を確認できません")); continue }
            guard let included = flag(calculationValue, defaultValue: true) else { out.rowErrors.append(.init(rowNumber: line, reason: "計算対象の値を確認できません")); continue }
            let isTransfer = transfer || major == "振替" || minor == "振替"
            if isTransfer { out.excludedRows.append(.init(rowNumber: line, reason: "transfer")); continue }
            if !included { out.excludedRows.append(.init(rowNumber: line, reason: "excluded_from_calculation")); continue }
            let description = get("description"), account = get("account"), memo = get("memo"), identifier = get("id")
            let identity: [Any] = identifier.isEmpty
                ? ["row", day.rawValue, description, String(amount), account.isEmpty ? NSNull() as Any : account as Any, major, minor, memo, transferValue, calculationValue]
                : ["id", identifier]
            let sourcePayload = try! JSONSerialization.data(withJSONObject: ["moneyforward", identity] as [Any], options: [.fragmentsAllowed, .withoutEscapingSlashes])
            let sourceKey = hash(sourcePayload)
            out.transactions.append(.init(rowNumber: line, date: day, description: description, amountYen: amount, kind: amount < 0 ? .expense : .income, accountName: account.isEmpty ? nil : account, majorCategory: major, minorCategory: minor, memo: memo, sourceTransactionId: identifier.isEmpty ? nil : identifier, sourceKey: sourceKey, isTransfer: isTransfer, isIncludedInCalculation: included, categoryNeedsReviewReason: major == "現金・カード" ? "現金・カードの分類を確認してください" : nil))
        }
        return out
    }

    static func description(_ row: KMMoneyForwardRow) -> String { row.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "内容なし" : row.description }
    static func categoryKey(kind: KMMoneyForwardRow.Kind, major: String, minor: String) -> String { json([kind.rawValue, major.trimmingCharacters(in: .whitespacesAndNewlines), minor.trimmingCharacters(in: .whitespacesAndNewlines)]) }
    static func today(_ now: Date = Date()) -> KMDate { KMDate(instant: now) }
    /// Same signed amount, direction, and mapped category within three calendar days; candidates are never automatic matches.
    static func similarRecords(row: KMMoneyForwardRow, choice: KMMoneyForwardCategoryChoice?, transactions: [KMTransaction]) -> [KMTransaction] {
        func distance(_ date: KMDate) -> Int {
            let start = KMDate.calendar.date(from: DateComponents(year: Int(row.date.rawValue.prefix(4)), month: Int(row.date.rawValue.dropFirst(5).prefix(2)), day: Int(row.date.rawValue.suffix(2))))!
            let end = KMDate.calendar.date(from: DateComponents(year: date.yearMonth.year, month: date.yearMonth.month, day: Int(date.rawValue.suffix(2))))!
            return abs(KMDate.calendar.dateComponents([.day], from: start, to: end).day!)
        }
        return transactions.filter { transaction in
            guard transaction.kind == (row.kind == .expense ? .expense : .income), transaction.isSplit != true,
                  transaction.amountYen == row.amountYen, distance(transaction.date) <= 3 else { return false }
            switch choice {
            case .existing(let id): return transaction.categoryId == id
            case .new(let name): return transaction.categoryName == name.trimmingCharacters(in: .whitespacesAndNewlines)
            case .unclassified: return transaction.categoryId == nil
            default: return false
            }
        }.sorted { lhs, rhs in
            let leftDistance = distance(lhs.date), rightDistance = distance(rhs.date)
            return leftDistance == rightDistance ? lhs.id < rhs.id : leftDistance < rightDistance
        }
    }
    static func resolveCategory(kind: KMMoneyForwardRow.Kind, majorCategory: String, minorCategory: String, available: [KMMoneyForwardCategory]) -> KMMoneyForwardCategoryResolution {
        let active = available.filter { !$0.hidden && $0.isIncome == (kind == .income) }; let major = majorCategory.trimmingCharacters(in: .whitespacesAndNewlines), minor = minorCategory.trimmingCharacters(in: .whitespacesAndNewlines)
        if major == "現金・カード" { return .init(categoryId: nil, suggestedName: "現金・カード", reason: "現金・カードの分類を確認してください") }
        let individual = kind == .expense ? minorTargets["\(major)|\(minor)"] : nil
        if let exact = active.first(where: { $0.name == (individual ?? minor) }) { return .init(categoryId: exact.id, suggestedName: exact.name, reason: "") }
        if individual == nil, let category = active.first(where: { $0.name == major }) { return .init(categoryId: category.id, suggestedName: category.name, reason: "") }
        guard let suggestion = individual ?? categoryTargets[kind.rawValue]?[major] else { return .init(categoryId: nil, suggestedName: nil, reason: "対応表にないカテゴリです。分類を確認してください") }
        let preferred = labels[suggestion] ?? suggestion
        if let category = active.first(where: { $0.name == preferred }) { return .init(categoryId: category.id, suggestedName: category.name, reason: "") }
        return .init(categoryId: nil, suggestedName: suggestion, reason: "")
    }
    private static func failure(_ code: String, _ encoding: String = "utf-8") -> KMMoneyForwardParseResult { .init(encoding: encoding, fatalErrors: [.init(rowNumber: nil, code: code)]) }
    private static func headerKey(_ value: String) -> String { value.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespacesAndNewlines).filter { !$0.isWhitespace }.lowercased() }
    private static func signature(_ headers: [String]) -> String { json(headers.map(headerKey)) }
    private static func json(_ strings: [String]) -> String { let data = (try? JSONSerialization.data(withJSONObject: strings, options: [.fragmentsAllowed, .withoutEscapingSlashes])) ?? Data("[]".utf8); return String(data: data, encoding: .utf8) ?? "[]" }
    private static func hash(_ value: Data) -> String { SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined() }
    private static func parseDate(_ value: String) -> KMDate? {
        guard let re = try? NSRegularExpression(pattern: #"^([0-9]{4})[/-]([0-9]{1,2})[/-]([0-9]{1,2})$"#), let m = re.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)), let y = Range(m.range(at: 1), in: value), let mo = Range(m.range(at: 2), in: value), let d = Range(m.range(at: 3), in: value) else { return nil }
        return try? KMDate(String(format: "%04d-%02d-%02d", Int(value[y])!, Int(value[mo])!, Int(value[d])!))
    }
    private static func parseYen(_ value: String) -> Int? {
        let normalized = value.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "￥", with: "").replacingOccurrences(of: "¥", with: "").replacingOccurrences(of: "円", with: "")
        guard normalized.range(of: #"^-?(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)$"#, options: .regularExpression) != nil, let amount = Int(normalized.replacingOccurrences(of: ",", with: "")), amount >= -9_007_199_254_740_991 && amount <= 9_007_199_254_740_991 else { return nil }; return amount
    }
    private static func flag(_ value: String, defaultValue: Bool) -> Bool? {
        let s = value.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespacesAndNewlines); if s.isEmpty { return defaultValue }
        if s.range(of: #"^(?:1|true|yes|on|対象|振替|はい|する)$"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        if s.range(of: #"^(?:0|false|no|off|対象外|計算対象外|振替ではない|いいえ|しない)$"#, options: [.regularExpression, .caseInsensitive]) != nil { return false }; return nil
    }
}

private struct MFCSV {
    struct Record { var fields: [String]; var lineEnd: Int }
    var records: [Record] = []
    init?(_ text: String) {
        var row: [String] = [], field = "", quoted = false, closed = false, line = 1, i = text.startIndex
        while i < text.endIndex {
            let c = text[i]
            if quoted {
                if c == "\"" { let next = text.index(after: i); if next < text.endIndex && text[next] == "\"" { field.append("\""); i = next } else { quoted = false; closed = true } }
                else { field.append(c); if c == "\r\n" || c == "\n" || c == "\r" { line += 1 } }
            } else if c == "," { row.append(field); field = ""; closed = false }
            else if c == "\n" || c == "\r" || c == "\r\n" {
                row.append(field); field = ""; if !(row.count == 1 && row[0].isEmpty) { records.append(.init(fields: row, lineEnd: line)) }; row = []; closed = false
                if c == "\r" { let next = text.index(after: i); if next < text.endIndex && text[next] == "\n" { i = next } }; line += 1
            } else if c == "\"" { if !field.isEmpty || closed { return nil }; quoted = true }
            else { if closed { return nil }; field.append(c) }
            i = text.index(after: i)
        }
        if quoted { return nil }
        if !field.isEmpty || !row.isEmpty { row.append(field); records.append(.init(fields: row, lineEnd: line)) }
    }
}
