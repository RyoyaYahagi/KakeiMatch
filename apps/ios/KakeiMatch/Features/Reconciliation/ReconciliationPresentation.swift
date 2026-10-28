import Foundation

/// PWA local-ui.ts reviewPage/reconciliationState. Display projections only; all writes stay in Repository.
struct KMReconciliationPresentation {
    struct Candidate: Identifiable {
        var id: String { receiptId }
        var receiptId: String
        var transaction: KMTransaction
        var reason: String
        var sameDate: Bool
        var sameAmount: Bool
        var canConfirm: Bool
    }
    struct Pending: Identifiable {
        var id: String { statement.id }
        var statement: KMStatementTransaction
        var status: KMReconciliationStatementResult.Status
        var candidates: [Candidate]
        var hasCandidates: Bool
        var reason: String
    }
    var pending: [Pending] = []
    var matched: [KMReconciliationResolution] = []
    var ignored: [KMReconciliationResolution] = []
    var failures: [KMReconciliationResolution] = []
    var suspected: [KMSuspectedStatement] = []
    var waiting = 0
    var needsReview: Int { pending.filter { $0.status == .needsReview }.count }
    var unmatched: Int { pending.filter { $0.status == .unmatchedStatement }.count }
    var isClear: Bool { pending.isEmpty && suspected.isEmpty && failures.isEmpty }
    var resultLabel: String {
        "照合の結果：一致 \(matched.count)件 · 要確認 \(needsReview)件 · 記録なし \(unmatched)件 · 不正利用？ \(suspected.count)件 · 明細待ち \(waiting)件"
    }

    static func make(run: KMReconciliationRun?, resolutions: [KMReconciliationResolution],
                     suspected: [KMSuspectedStatement], statements: [KMStatementTransaction],
                     receipts: [KMReceipt], transactions: [String: KMTransaction]) -> Self {
        guard let run else { return Self() }
        let decided = Set(resolutions.map(\.statementId)), flagged = Set(suspected.map(\.statementId))
        let statementsById = Dictionary(uniqueKeysWithValues: statements.map { ($0.id, $0) })
        let remaining = run.statementResults.filter {
            $0.status != .matched && !decided.contains($0.statementTransactionId) && !flagged.contains($0.statementTransactionId)
        }.sorted {
            let a = $0.status == .needsReview ? 0 : 1, b = $1.status == .needsReview ? 0 : 1
            return a == b ? $0.statementTransactionId < $1.statementTransactionId : a < b
        }
        let pending: [Pending] = remaining.compactMap { result in
            guard let statement = statementsById[result.statementTransactionId] else { return nil }
            let rawCandidates = run.candidates.filter { $0.statementTransactionId == statement.id }
            let candidates: [Candidate] = rawCandidates.compactMap { candidate in
                let actualId = receipts.first { $0.id == candidate.receiptId }?.registration.actualTransactionId
                    ?? (candidate.receiptId.hasPrefix("actual:") ? String(candidate.receiptId.dropFirst(7)) : nil)
                guard let actualId, let actual = transactions[actualId], actual.kind == .expense else { return nil }
                let sameDate = actual.date == statement.usedDate, sameAmount = actual.amountYen == -statement.amountYen
                let reason = candidateReason(statement: statement, transaction: actual)
                return Candidate(receiptId: candidate.receiptId, transaction: actual, reason: reason,
                                 sameDate: sameDate, sameAmount: sameAmount, canConfirm: actual.isSplit != true || sameAmount)
            }
            let reason: String
            if statement.kind == .refund { reason = "返金のため自動で処理できません" }
            else if candidates.count > 1 { reason = "候補が\(candidates.count)件あります" }
            else if let candidate = candidates.first { reason = candidate.reason }
            else { reason = result.status == .needsReview ? "内容を確認してください" : "記録が見つかりません" }
            return Pending(statement: statement, status: result.status, candidates: candidates,
                           hasCandidates: !rawCandidates.isEmpty, reason: reason)
        }
        let matched = resolutions.filter { $0.resolution == .sameExpense && $0.status == .applied && $0.undoRequestedAt == nil }
            .enumerated().sorted {
                let a = statementsById[$0.element.statementId]?.usedDate.rawValue ?? isoDay($0.element.createdAt)
                let b = statementsById[$1.element.statementId]?.usedDate.rawValue ?? isoDay($1.element.createdAt)
                return a == b ? $0.offset < $1.offset : a > b
            }.map(\.element)
        return Self(pending: pending, matched: matched,
                    ignored: resolutions.filter { $0.resolution == .ignored && $0.status == .applied },
                    failures: resolutions.filter { $0.status != .applied },
                    suspected: suspected.sorted { $0.markedAt > $1.markedAt },
                    waiting: run.receiptResults.filter { $0.status == .unmatchedReceipt }.count)
    }

    static func candidateReason(statement: KMStatementTransaction, transaction: KMTransaction) -> String {
        let gap = abs(statement.amountYen - abs(transaction.amountYen))
        if gap != 0 { return "金額が\(KMAmountFormatter.yen(gap))違います" }
        let days = abs(KMDate.calendar.dateComponents([.day], from: dayInstant(transaction.date), to: dayInstant(statement.usedDate)).day ?? 0)
        return days == 0 ? "内容を確認してください" : "日付が\(days)日ずれています"
    }
    private static func dayInstant(_ date: KMDate) -> Date {
        let parts = date.rawValue.split(separator: "-").map { Int($0)! }
        return KMDate.calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))!
    }
    static func shortDay(_ date: KMDate) -> String {
        let parts = date.rawValue.split(separator: "-")
        return "\(Int(parts[1])!)/\(Int(parts[2])!)"
    }
    static func timestamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = KMDate.calendar; formatter.locale = Locale(identifier: "ja_JP")
        formatter.timeZone = TimeZone(identifier: "Asia/Tokyo"); formatter.dateFormat = "M/d HH:mm"
        return formatter.string(from: date)
    }
    static func isoDay(_ date: Date) -> String { KMDate(instant: date).rawValue }
    static func runFeedback(before: Int, after: Int) -> String {
        after > before ? "照合しました。新しく\(after - before)件が一致しました。" : "照合しました。新しく一致したものはありません。"
    }
    static func importFeedback(_ result: KMStatementImportResult) -> String {
        "\(result.added)件を取り込み、照合しました。重複 \(result.duplicates)件。対象外 \(result.excluded)件、要確認 \(result.needsReviewRows.count)件。"
            + result.needsReviewRows.map { "\($0.rowNumber)行目: \($0.reason)" }.joined(separator: " / ")
    }
    static func categoryChoices(_ categories: [KMCategory], groups: [KMCategoryGroup]) -> [KMCategory] {
        let words = [["食費", "食料", "食品"], ["外食", "飲食店", "カフェ"], ["日用品", "生活用品"],
                     ["衣服", "衣類", "被服", "美容"], ["交通", "電車", "バス", "ガソリン"], ["医療", "健康", "病院", "薬"],
                     ["家電", "デジタル", "ガジェット"], ["娯楽", "趣味", "レジャー"], ["AI", "ソフトウェア", "アプリ"],
                     ["通信", "携帯", "スマホ", "インターネット"], ["教育", "学習", "教材", "資格"], ["交際", "プレゼント", "贈答"],
                     ["住居", "家賃", "住宅"], ["光熱", "水道", "電気", "ガス"]]
        func rank(_ name: String) -> Int { words.firstIndex { $0.contains(where: name.contains) } ?? words.count }
        return categories.enumerated().filter { _, category in
            !category.isIncome && !category.hidden && !groups.contains { $0.id == category.groupId && $0.hidden }
        }.sorted {
            if $0.element.usageCount != $1.element.usageCount { return $0.element.usageCount > $1.element.usageCount }
            let a = rank($0.element.name), b = rank($1.element.name)
            return a == b ? $0.offset < $1.offset : a < b
        }.map(\.element)
    }
    static func suggestedCategory(merchant: String, rules: [KMCategoryLearningRule], categories: [KMCategory]) -> String? {
        rules.first { rule in rule.targetType == .merchant && rule.enabled && !rule.deleted
            && rule.normalizedName == KMCategoryLearningService.normalizeName(merchant)
            && categories.contains(where: { $0.id == rule.categoryId }) }?.categoryId
    }
    static func canUndo(_ decision: KMReconciliationResolution) -> Bool {
        decision.source == .user && decision.actualSnapshot?.cleared != nil
    }
    static func method(_ decision: KMReconciliationResolution, receipt: KMReceipt?) -> String {
        let changed = receipt?.confirmedValue == nil && decision.source == .user
            && decision.actualSnapshot.map { abs($0.amountYen) != decision.statementAmountYen } == true
        return "判定：\(decision.source == .automatic ? "自動" : "手動")で一致"
            + (changed ? "。記録の金額を\(KMAmountFormatter.yen(decision.statementAmountYen))に合わせました" : "")
    }
}

/// Fixed official destinations from PWA statement-download-help.ts. No household data in URLs.
enum KMStatementDownload {
    static let providers: [KMStatementProvider] = [.paypayCard, .smbcCard, .rakutenCard, .aeonCard]
    static func label(_ provider: KMStatementProvider) -> String {
        switch provider {
        case .paypayCard: "PayPayカード"
        case .paypay: "PayPay"
        case .smbcCard: "三井住友カード"
        case .rakutenCard: "楽天カード"
        case .aeonCard: "イオンカード"
        }
    }
    static func support(_ provider: KMStatementProvider) -> URL? {
        switch provider {
        case .smbcCard: URL(string: "https://www.smbc-card.com/mem/info/meisai_inquiry.jsp")
        case .rakutenCard: URL(string: "https://www.rakuten-card.co.jp/security/no-usage-bill/")
        case .paypay, .paypayCard: URL(string: "https://www.paypay-card.co.jp/service/004962.html")
        case .aeonCard: nil
        }
    }
    static func help(_ provider: KMStatementProvider) -> (url: URL, note: String) {
        let value: (String, String)
        switch provider {
        case .paypayCard, .paypay:
            value = ("https://www.paypay-card.co.jp/member/statement/top", "対象月を選び、「明細出力」→「CSVをダウンロードする」。")
        case .smbcCard:
            value = ("https://www.smbc-card.com/memapi/jaxrs/meisai/v1", "PCのVpass Web明細で「CSV形式で保存する」を選択してください。")
        case .rakutenCard:
            value = ("https://www.rakuten-card.co.jp/service/e-navi/list/", "CSV取得はPC版楽天e-NAVIのみ対応しています。「ご利用明細」→「明細コピー用 Excel（CSV）」。")
        case .aeonCard:
            value = ("https://www.aeon.co.jp/app/", "暮らしのマネーサイト / AEON Payから請求確定月のCSVを取得できます。")
        }
        return (URL(string: value.0)!, value.1)
    }
}
