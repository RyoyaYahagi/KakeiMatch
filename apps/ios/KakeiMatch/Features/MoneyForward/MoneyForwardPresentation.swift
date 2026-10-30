import CryptoKit
import Foundation

/// PWA `moneyforward-ui.ts` / `moneyforward-import.ts` の表示規則。
/// ViewもRepositoryも参照しない純粋関数だけを置く。
enum KMMoneyForwardPresentation {
    enum CategoryChoice: Equatable, Sendable {
        case existing(id: String)
        case new(name: String)
        case unclassified
        case exclude
        case unresolved
    }

    enum AccountChoice: Equatable, Sendable {
        case existing(id: String)
        case new(name: String)
        case unset
    }

    struct Mappings: Equatable, Sendable {
        var categories: [String: CategoryChoice] = [:]
        var accounts: [String: AccountChoice] = [:]
    }

    struct CategoryGroup: Identifiable, Equatable, Sendable {
        var key: String
        var row: KMMoneyForwardRow
        var count: Int
        var id: String { key }
    }

    struct Line: Identifiable, Equatable, Sendable {
        var key: String
        var label: String
        var value: String
        var id: String { key }
    }

    struct PreviewInput: Equatable, Sendable {
        enum Status: String, Equatable, Sendable { case ready, duplicate, excluded, unresolved, review }
        enum Choice: Equatable, Sendable { case separate, keep }
        var row: KMMoneyForwardRow
        var importedId: String
        var status: Status
        var candidates: [KMTransaction]
        var recordChoice: Choice?
    }

    struct PreviewSummary: Equatable, Sendable {
        var lines: [Line]
        var readyRows: [PreviewInput]
        var similarRows: [PreviewInput]
        var unresolvedCount: Int
        var canImport: Bool
        var importTitle: String
        var notice: String?
    }

    struct ResultSummary: Equatable, Sendable {
        enum RowStatus: Equatable, Sendable { case created, duplicate, excluded, other }
        var lines: [Line]
    }

    static let intro = "CSVはこの端末だけで読み込みます。将来日付・振替・計算対象外は除外します。登録前にカテゴリと支払元を確認してください。"
    static let selectNote = "UTF-8・Shift_JIS形式に対応。ファイルは5MB、取引は20,000行までです。"
    static let accountNote = "未設定の支払元は「移行元未設定」へまとめます。CSVにない品目は作成しません。"
    static let similarNote = "金額・カテゴリが同じで日付が3日以内の記録です。同じ取引なら既存記録に統一し、CSVの行を取り込みません。既存の品目や画像は保持します。別の取引なら両方を残します。"
    static let unresolvedNotice = "未解決のカテゴリがあります。変換先を選ぶか、未分類・除外を選んでください。"
    static let reviewNotice = "似ている記録について、統一するか別の記録として取り込むかを選んでください。"
    static let fatalStatus = "現在のMoneyForward CSV形式に対応していない可能性があります。列を確認してください。"
    static let undoMessage = "移行した取引を取り消しました。カテゴリと支払元は残っています。"
    static let undoFailureMessage = "一部の取引を取り消せませんでした。履歴からもう一度お試しください。"
    static let undoConfirmation = "この移行で登録した取引を削除します。移行後の編集も削除されます。追加したカテゴリと支払元は残ります。続けますか？"

    /// Same grouping and order as `moneyforward-ui.ts` renderMappings.
    static func categoryGroups(_ rows: [KMMoneyForwardRow]) -> [CategoryGroup] {
        var order: [String] = []
        var grouped: [String: CategoryGroup] = [:]
        for row in rows {
            let key = KMMoneyForwardParser.categoryKey(kind: row.kind, major: row.majorCategory, minor: row.minorCategory)
            if var group = grouped[key] {
                group.count += 1
                grouped[key] = group
            } else {
                order.append(key)
                grouped[key] = .init(key: key, row: row, count: 1)
            }
        }
        return order.compactMap { grouped[$0] }
    }

    static func categories(_ values: [KMCategory]) -> [KMMoneyForwardCategory] {
        values.map { .init(id: $0.id, name: $0.name, isIncome: $0.isIncome, hidden: $0.hidden) }
    }

    /// Mirrors the first pass of `selectFile()` in moneyforward-ui.ts.
    static func defaultCategoryMappings(
        rows: [KMMoneyForwardRow],
        categories: [KMMoneyForwardCategory],
        saved: [String: CategoryChoice]
    ) -> [String: CategoryChoice] {
        var result: [String: CategoryChoice] = [:]
        for row in rows {
            let key = KMMoneyForwardParser.categoryKey(kind: row.kind, major: row.majorCategory, minor: row.minorCategory)
            guard result[key] == nil else { continue }
            if let saved = saved[key], isValid(saved, kind: row.kind, categories: categories) {
                result[key] = saved
                continue
            }
            let resolved = KMMoneyForwardParser.resolveCategory(kind: row.kind, majorCategory: row.majorCategory,
                minorCategory: row.minorCategory, available: categories)
            let trimmedMajor = row.majorCategory.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedMajor == "未分類" {
                result[key] = .unclassified
            } else if let id = resolved.categoryId {
                result[key] = .existing(id: id)
            } else if let name = resolved.suggestedName, resolved.reason.isEmpty,
                      row.categoryNeedsReviewReason == nil,
                      !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result[key] = .new(name: name)
            } else {
                result[key] = .unresolved
            }
        }
        return result
    }

    /// Mirrors the account pass in `selectFile()`.
    static func defaultAccountMappings(
        rows: [KMMoneyForwardRow],
        accounts: [KMAccount],
        saved: [String: AccountChoice]
    ) -> [String: AccountChoice] {
        var result: [String: AccountChoice] = [:]
        for row in rows {
            let source = row.accountName ?? ""
            guard result[source] == nil else { continue }
            if let match = accounts.first(where: { !$0.closed && $0.name == source }) {
                result[source] = .existing(id: match.id)
            } else if let saved = saved[source] {
                result[source] = saved
            } else {
                result[source] = source.isEmpty ? .unset : .new(name: source)
            }
        }
        return result
    }

    static func accountSources(_ rows: [KMMoneyForwardRow]) -> [String] {
        var seen = Set<String>()
        return rows.compactMap { row in
            let source = row.accountName ?? ""
            return seen.insert(source).inserted ? source : nil
        }
    }

    /// PWA pre-fills the new-category field with `minorCategory || majorCategory`.
    static func newCategoryName(_ row: KMMoneyForwardRow) -> String {
        row.minorCategory.isEmpty ? row.majorCategory : row.minorCategory
    }

    static func categoryLabel(_ group: CategoryGroup) -> String {
        let major = group.row.majorCategory.isEmpty ? "カテゴリなし" : group.row.majorCategory
        let minor = group.row.minorCategory.isEmpty ? "" : " / \(group.row.minorCategory)"
        let kind = group.row.kind == .income ? "収入" : "支出"
        return "\(major)\(minor)（\(kind)） \(group.count)件"
    }

    static func accountLabel(_ source: String) -> String {
        source.isEmpty ? "移行元に口座名なし" : source
    }

    /// Stable, opaque identifier for a repeated row. Never uses display order or transaction values.
    static func stableIdentifier(_ element: String, _ value: String) -> String {
        let digest = SHA256.hash(data: Data(value.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        return "moneyforward.\(element).\(digest)"
    }

    static func previewSummary(
        excluded: [KMMoneyForwardRowIssue],
        rowErrorCount: Int,
        previews: [PreviewInput],
        categories: [KMMoneyForwardCategory],
        accounts: [KMAccount],
        mappings: Mappings
    ) -> PreviewSummary {
        let ready = previews.filter { $0.status == .ready }
        let duplicates = previews.filter { $0.status == .duplicate }
        let unresolved = previews.filter { $0.status == .unresolved }
        let review = previews.filter { $0.status == .review }
        let similar = previews.filter { !$0.candidates.isEmpty }
        let dates = ready.map(\.row.date).sorted()
        let incomes = ready.filter { $0.row.kind == .income }
        let expenses = ready.filter { $0.row.kind == .expense }
        let excludedByPreview = previews.filter { $0.status == .excluded }
        let future = excluded.filter { $0.reason == "future_date" }
        let transfers = excluded.filter { $0.reason == "transfer" }
        let unresolvedKeys = Set(unresolved.map { categoryKey($0.row) })

        let newCategories = Set(ready.compactMap { item -> String? in
            let key = categoryKey(item.row)
            guard case .new(let name)? = mappings.categories[key] else { return nil }
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty,
                  !categories.contains(where: { $0.name == trimmed && $0.isIncome == (item.row.kind == .income) }) else { return nil }
            return "\(item.row.kind.rawValue):\(trimmed)"
        })
        let newAccounts = Set(ready.compactMap { item -> String? in
            let source = item.row.accountName ?? ""
            let name: String
            switch mappings.accounts[source] ?? .unset {
            case .existing: return nil
            case .new(let value): name = value.trimmingCharacters(in: .whitespacesAndNewlines)
            case .unset: name = "移行元未設定"
            }
            guard !name.isEmpty, !accounts.contains(where: { !$0.closed && $0.name == name }) else { return nil }
            return name
        })

        let lines: [Line] = [
            .init(key: "period", label: "対象期間", value: dates.isEmpty ? "対象なし" : "\(dates[0].rawValue) 〜 \(dates[dates.count - 1].rawValue)"),
            .init(key: "count", label: "取引件数", value: "\(ready.count)件"),
            .init(key: "income", label: "収入", value: "\(incomes.count)件 / \(yenSum(incomes.map(\.row.amountYen)))"),
            .init(key: "expense", label: "支出", value: "\(expenses.count)件 / \(yenSum(expenses.map { -$0.row.amountYen }))"),
            .init(key: "future", label: "将来日付（除外）", value: "\(future.count)件"),
            .init(key: "review", label: "似ている記録（要確認）", value: "\(review.count)件"),
            .init(key: "transfer", label: "振替（除外）", value: "\(transfers.count)件"),
            .init(key: "excluded", label: "除外予定", value: "\(excluded.count + excludedByPreview.count)件"),
            .init(key: "duplicates", label: "重複（スキップ）", value: "\(duplicates.count)件"),
            .init(key: "errors", label: "エラー", value: "\(rowErrorCount)件"),
            .init(key: "unresolved", label: "未解決カテゴリ", value: "\(unresolvedKeys.count)件"),
            .init(key: "newCategories", label: "新規カテゴリ", value: "\(newCategories.count)件"),
            .init(key: "newAccounts", label: "新規支払元", value: "\(newAccounts.count)件"),
        ]

        let notice: String?
        if !unresolved.isEmpty {
            notice = unresolvedNotice
        } else if !review.isEmpty {
            notice = reviewNotice
        } else {
            notice = nil
        }
        return .init(lines: lines, readyRows: ready, similarRows: similar,
            unresolvedCount: unresolved.count,
            canImport: unresolved.isEmpty && review.isEmpty && (!ready.isEmpty || !similar.isEmpty),
            importTitle: ready.isEmpty ? "既存記録への統一を確定する" : "\(ready.count)件を取り込む",
            notice: notice)
    }

    static func resultSummary(statuses: [ResultSummary.RowStatus], excludedRowCount: Int, rowErrorCount: Int) -> ResultSummary {
        let created = statuses.filter { $0 == .created }.count
        let duplicates = statuses.filter { $0 == .duplicate }.count
        let skipped = statuses.filter { $0 == .excluded }.count + excludedRowCount
        let errors = statuses.filter { $0 == .other }.count + rowErrorCount
        return .init(lines: [
            .init(key: "created", label: "成功", value: "\(created)件"),
            .init(key: "duplicates", label: "重複", value: "\(duplicates)件"),
            .init(key: "skipped", label: "スキップ", value: "\(skipped)件"),
            .init(key: "errors", label: "エラー", value: "\(errors)件"),
        ])
    }

    static func historyLabel(day: String, created: Int, undone: Bool) -> String {
        "\(day) · 登録 \(created)件\(undone ? " · 取り消し済み" : "")"
    }

    static func previewLine(
        _ item: PreviewInput,
        categories: [KMMoneyForwardCategory],
        accounts: [KMAccount],
        mappings: Mappings
    ) -> String {
        let amount = KMAmountFormatter.yen(abs(item.row.amountYen))
        let sign = item.row.amountYen < 0 ? "−" : "+"
        let category = categoryName(item.row, categories: categories, mappings: mappings)
        let account = accountName(item.row, accounts: accounts, mappings: mappings)
        return "\(item.row.date.rawValue) · \(KMMoneyForwardParser.description(item.row)) · \(sign)\(amount) · \(category) · \(account)"
    }

    static func similarLine(_ item: PreviewInput) -> String {
        "CSV \(item.row.rowNumber)行: \(item.row.date.rawValue) · \(KMMoneyForwardParser.description(item.row)) · \(signedYen(item.row.amountYen))"
    }

    static func candidateLine(_ candidate: KMTransaction, accounts: [KMAccount]) -> String {
        let account = accounts.first(where: { $0.id == candidate.accountId })?.name ?? "支払元未設定"
        return "既存: \(candidate.date.rawValue) · \(candidate.payeeName ?? "内容なし") · \(signedYen(candidate.amountYen)) · \(candidate.categoryName ?? "未分類") · \(account)"
    }

    static func candidateTitle(_ candidate: KMTransaction, accounts: [KMAccount]) -> String {
        let account = accounts.first(where: { $0.id == candidate.accountId })?.name ?? "支払元未設定"
        return "既存記録に統一: \(candidate.date.rawValue) · \(candidate.payeeName ?? "内容なし") · \(signedYen(candidate.amountYen)) · \(candidate.categoryName ?? "未分類") · \(account)"
    }

    /// `yen()` in moneyforward-ui.ts keeps the sign inside the formatted value ("¥-1,200").
    private static func signedYen(_ value: Int) -> String {
        let digits = Array(String(value.magnitude))
        let grouped = digits.enumerated().map { index, digit in
            (index > 0 && (digits.count - index).isMultiple(of: 3) ? "," : "") + String(digit)
        }.joined()
        return "¥\(value < 0 ? "-" : "")\(grouped)"
    }

    /// `future_date` / `transfer` / everything else, as in renderPreview.
    static func exclusionReason(_ reason: String) -> String {
        switch reason {
        case "future_date": "将来日付のため除外"
        case "transfer": "振替のため除外"
        default: "計算対象外のため除外"
        }
    }

    static func fatalDetails(_ result: KMMoneyForwardParseResult) -> [String] {
        let reasons: [String: String] = [
            "invalid_file": "ファイルを読み取れません",
            "empty_file": "ファイルが空です",
            "header_only": "取引行がありません",
            "header_mismatch": "必須の列が不足または重複しています",
            "malformed_csv": "CSVの区切りや引用符を確認できません",
            "limit_exceeded": "ファイルサイズ・行数・項目の長さが上限を超えています",
        ]
        var lines = [result.fatalErrors.map { reasons[$0.code] ?? "ファイルを確認できません" }.joined(separator: "、")]
        if let found = result.foundHeaders {
            lines.append("見つかった列: \(found.isEmpty ? "なし" : found.joined(separator: "、"))")
        } else if let signature = result.headerSignature {
            lines.append("見つかった列: \(signature)")
        }
        if result.fatalErrors.contains(where: { $0.code == "header_mismatch" }) {
            let missing = result.missingHeaders?.joined(separator: "、") ?? ""
            lines.append("不足している必須列: \(missing.isEmpty ? "日付・内容・金額（円）・大項目を確認してください" : missing)")
            if let duplicate = result.duplicateHeaders, !duplicate.isEmpty {
                lines.append("重複している列: \(duplicate.joined(separator: "、"))")
            }
        }
        if let unknown = result.unknownHeaders, !unknown.isEmpty {
            lines.append("認識できない列: \(unknown.joined(separator: "、"))")
        }
        return lines
    }

    private static func categoryKey(_ row: KMMoneyForwardRow) -> String {
        KMMoneyForwardParser.categoryKey(kind: row.kind, major: row.majorCategory, minor: row.minorCategory)
    }

    private static func isValid(
        _ choice: CategoryChoice,
        kind: KMMoneyForwardRow.Kind,
        categories: [KMMoneyForwardCategory]
    ) -> Bool {
        switch choice {
        case .existing(let id):
            return categories.contains { $0.id == id && !$0.hidden && $0.isIncome == (kind == .income) }
        case .new, .unclassified, .exclude, .unresolved:
            return true
        }
    }

    private static func categoryName(
        _ row: KMMoneyForwardRow,
        categories: [KMMoneyForwardCategory],
        mappings: Mappings
    ) -> String {
        switch mappings.categories[categoryKey(row)] ?? .unresolved {
        case .existing(let id): categories.first(where: { $0.id == id })?.name ?? "未解決のカテゴリ"
        case .new(let name): name
        case .unclassified: "未分類"
        case .exclude: "取り込まない"
        case .unresolved: "未解決"
        }
    }

    private static func accountName(
        _ row: KMMoneyForwardRow,
        accounts: [KMAccount],
        mappings: Mappings
    ) -> String {
        switch mappings.accounts[row.accountName ?? ""] ?? .unset {
        case .existing(let id): accounts.first(where: { $0.id == id })?.name ?? "未解決の口座"
        case .new(let name): name
        case .unset: "移行元未設定"
        }
    }

    /// Integer yen only. An unsafe sum is shown as "—" instead of overflowing.
    private static func yenSum(_ values: [Int]) -> String {
        var total = 0
        do {
            for value in values { total = try KMYen.add(total, value) }
            return KMAmountFormatter.yen(total)
        } catch {
            return "—"
        }
    }
}
