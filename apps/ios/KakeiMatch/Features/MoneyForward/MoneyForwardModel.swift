import Foundation
import Observation

@MainActor @Observable
final class KMMoneyForwardModel {
    enum Phase: Equatable { case select, mapping, preview, result }

    private(set) var phase: Phase = .select
    private(set) var categories: [KMMoneyForwardCategory] = []
    private(set) var accounts: [KMAccount] = []
    private(set) var parsed: KMMoneyForwardParseResult?
    private(set) var fatalResult: KMMoneyForwardParseResult?
    private(set) var previews: [KMMoneyForwardPresentation.PreviewInput] = []
    private(set) var summary: KMMoneyForwardPresentation.PreviewSummary?
    private(set) var resultSummary: KMMoneyForwardPresentation.ResultSummary?
    private(set) var batch: KMMoneyForwardBatch?
    private(set) var history: [KMMoneyForwardBatch] = []
    private(set) var isLoading = true
    private(set) var isBusy = false
    private(set) var selectedFileName: String?
    private(set) var mappings = KMMoneyForwardPresentation.Mappings()
    private(set) var accountSources: [String] = []
    private(set) var categoryGroups: [KMMoneyForwardPresentation.CategoryGroup] = []

    var error: String?
    var statusMessage: String?
    var categoryTags: [String: String] = [:]
    var newCategoryNames: [String: String] = [:]
    var accountTags: [String: String] = [:]
    var newAccountNames: [String: String] = [:]
    var recordTags: [String: String] = [:]
    var rememberMappings = false

    private var savedRules = KMMoneyForwardPresentation.Mappings()
    private var batchId = UUID().uuidString
    @ObservationIgnored private var api: KMWorkerAPI?
    private var excludedRowCount = 0
    private var rowErrorCount = 0

    func load(_ repositories: KMRepositories?) async {
        guard let repositories else {
            error = "家計簿を読み込めません。アプリを開き直してください。"
            isLoading = false
            return
        }
        do {
            categories = KMMoneyForwardPresentation.categories(try await repositories.categories.categories(includeHidden: false))
            accounts = try await repositories.accounts.accounts(includeClosed: false)
            savedRules = Self.presentationMappings(try await repositories.statements.moneyForwardRules())
            history = try await repositories.statements.moneyForwardHistory()
            error = nil
        } catch let failure {
            self.error = "移行画面を読み込めませんでした。\(failure.localizedDescription)"
        }
        isLoading = false
    }

    func loadCSV(data: Data, name: String?, repositories: KMRepositories?) async {
        guard let repositories else {
            error = "家計簿を読み込めません。アプリを開き直してください。"
            return
        }
        resetDraft()
        isBusy = true
        statusMessage = "CSVを読み込んでいます…"
        error = nil
        let result = KMMoneyForwardParser.parse(data: data, now: repositories.referenceDate)
        parsed = result
        selectedFileName = name
        guard result.fatalErrors.isEmpty else {
            fatalResult = result
            statusMessage = nil
            isBusy = false
            return
        }
        fatalResult = nil

        let categoryDefaults = KMMoneyForwardPresentation.defaultCategoryMappings(
            rows: result.transactions, categories: categories, saved: savedRules.categories)
        categoryTags = [:]
        newCategoryNames = [:]
        mappings = .init()
        for (key, choice) in categoryDefaults {
            mappings.categories[key] = choice
            switch choice {
            case .existing(let id): categoryTags[key] = id
            case .new(let name): categoryTags[key] = "new"; newCategoryNames[key] = name
            case .unclassified: categoryTags[key] = "unclassified"
            case .exclude: categoryTags[key] = "exclude"
            case .unresolved: categoryTags[key] = "unresolved"
            }
        }

        let accountDefaults = KMMoneyForwardPresentation.defaultAccountMappings(
            rows: result.transactions, accounts: accounts, saved: savedRules.accounts)
        accountTags = [:]
        newAccountNames = [:]
        for (source, choice) in accountDefaults {
            mappings.accounts[source] = choice
            switch choice {
            case .existing(let id): accountTags[source] = id
            case .new(let name): accountTags[source] = "new"; newAccountNames[source] = name
            case .unset: accountTags[source] = "unset"
            }
        }

        categoryGroups = KMMoneyForwardPresentation.categoryGroups(result.transactions)
        accountSources = KMMoneyForwardPresentation.accountSources(result.transactions)
        phase = .mapping
        statusMessage = nil
        isBusy = false
    }

    func setCategoryTag(_ tag: String, for key: String) {
        categoryTags[key] = tag
        switch tag {
        case "new":
            // PWA shows the CSV side category name until the user edits the new name.
            if (newCategoryNames[key] ?? "").isEmpty,
               let row = categoryGroups.first(where: { $0.key == key })?.row {
                newCategoryNames[key] = KMMoneyForwardPresentation.newCategoryName(row)
            }
            mappings.categories[key] = .new(name: (newCategoryNames[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
        case "unclassified": mappings.categories[key] = .unclassified
        case "exclude": mappings.categories[key] = .exclude
        case "unresolved": mappings.categories[key] = .unresolved
        default: mappings.categories[key] = .existing(id: tag)
        }
    }

    func setNewCategoryName(_ name: String, for key: String) {
        newCategoryNames[key] = name
        if categoryTags[key] == "new" { mappings.categories[key] = .new(name: name.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    func setAccountTag(_ tag: String, for source: String) {
        accountTags[source] = tag
        switch tag {
        case "new":
            // PWA shows the CSV source name until the user edits the new name.
            if (newAccountNames[source] ?? "").isEmpty { newAccountNames[source] = source }
            mappings.accounts[source] = .new(name: (newAccountNames[source] ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
        case "unset": mappings.accounts[source] = .unset
        default: mappings.accounts[source] = .existing(id: tag)
        }
    }

    func setNewAccountName(_ name: String, for source: String) {
        newAccountNames[source] = name
        if accountTags[source] == "new" { mappings.accounts[source] = .new(name: name.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    func setRecordTag(_ tag: String, for importedId: String) {
        if tag.isEmpty { recordTags[importedId] = nil } else { recordTags[importedId] = tag }
    }

    func suggestCategory(for key: String) async {
        guard case .unresolved? = mappings.categories[key] else {
            statusMessage = "未対応のカテゴリだけ候補を確認できます。"
            return
        }
        guard let group = categoryGroups.first(where: { $0.key == key }) else { return }
        let available = categories.filter { !$0.hidden && $0.isIncome == (group.row.kind == .income) }
        statusMessage = "カテゴリ名と選択肢だけを送って候補を確認します…"
        isBusy = true
        defer { isBusy = false }
        do {
            let client: KMWorkerAPI
            if let api { client = api }
            else { client = KMWorkerAPI(configuration: try KMAPIConfiguration()); api = client }
            let suggestion = try await client.suggestCategory(
                sourceCategoryName: "\(group.row.majorCategory) / \(group.row.minorCategory)",
                categories: available.map { .init(id: $0.id, name: $0.name) })
            guard let proposed = available.first(where: { $0.id == suggestion.categoryId }) else {
                statusMessage = "候補を決められませんでした。手で選んでください。"
                return
            }
            statusMessage = "候補: \(proposed.name)。確認して変換先を選んでください。"
        } catch {
            statusMessage = "候補を確認できませんでした。手で選んでください。"
        }
    }

    func preview(_ repositories: KMRepositories?) async {
        guard let repositories, let parsed, validateNewNames() else { return }
        isBusy = true
        error = nil
        do {
            let values = try await repositories.statements.previewMoneyForward(
                rows: parsed.transactions, mappings: dataMappings, choices: dataChoices, at: repositories.referenceDate)
            previews = values.map(Self.previewInput)
            summary = KMMoneyForwardPresentation.previewSummary(
                excluded: parsed.excludedRows, rowErrorCount: parsed.rowErrors.count, previews: previews,
                categories: categories, accounts: accounts, mappings: mappings)
            phase = .preview
        } catch let failure {
            self.error = failure.localizedDescription
        }
        isBusy = false
    }

    func confirm(_ repositories: KMRepositories?) async {
        guard let repositories, let parsed, let summary, summary.canImport else { return }
        guard validateNewNames() else { return }
        isBusy = true
        error = nil
        statusMessage = "取引をこの端末に登録しています…"
        do {
            let saved = try await repositories.statements.importMoneyForward(
                id: batchId, rows: parsed.transactions, mappings: dataMappings, choices: dataChoices,
                rememberMappings: rememberMappings,
                at: repositories.referenceDate)
            batch = saved
            excludedRowCount = parsed.excludedRows.count
            rowErrorCount = parsed.rowErrors.count
            resultSummary = KMMoneyForwardPresentation.resultSummary(
                statuses: saved.rows.map(Self.resultStatus),
                excludedRowCount: excludedRowCount, rowErrorCount: rowErrorCount)
            history = try await repositories.statements.moneyForwardHistory()
            savedRules = Self.presentationMappings(try await repositories.statements.moneyForwardRules())
            phase = .result
            statusMessage = "取り込み処理が終わりました。結果と履歴を確認してください。"
        } catch let failure {
            self.error = failure.localizedDescription
            statusMessage = nil
        }
        isBusy = false
    }

    func undo(_ value: KMMoneyForwardBatch, repositories: KMRepositories?) async {
        guard let repositories else { return }
        isBusy = true
        error = nil
        do {
            try await repositories.statements.undoMoneyForward(id: value.id, at: repositories.referenceDate)
            let refreshed = try await repositories.statements.moneyForwardHistory()
            // PWA returns to CSV selection after undo so a stale result summary is not shown.
            resetDraft()
            history = refreshed
            phase = .select
            statusMessage = KMMoneyForwardPresentation.undoMessage
        } catch let failure {
            self.error = failure.localizedDescription
            statusMessage = KMMoneyForwardPresentation.undoFailureMessage
        }
        isBusy = false
    }

    func backToMapping() {
        phase = .mapping
        summary = nil
        previews = []
        recordTags = [:]
    }

    func reset() {
        resetDraft()
        phase = .select
        error = nil
        statusMessage = nil
    }

    func historyLabel(_ value: KMMoneyForwardBatch) -> String {
        KMMoneyForwardPresentation.historyLabel(
            day: KMDate(instant: value.createdAt).rawValue,
            created: value.rows.filter { $0.status == .created }.count,
            undone: value.status == .undone)
    }

    private func resetDraft() {
        parsed = nil
        fatalResult = nil
        previews = []
        summary = nil
        resultSummary = nil
        batch = nil
        recordTags = [:]
        mappings = .init()
        categoryTags = [:]
        newCategoryNames = [:]
        accountTags = [:]
        newAccountNames = [:]
        categoryGroups = []
        accountSources = []
        selectedFileName = nil
        excludedRowCount = 0
        rowErrorCount = 0
        batchId = UUID().uuidString
    }

    private func validateNewNames() -> Bool {
        for (key, tag) in categoryTags where tag == "new" {
            let name = (newCategoryNames[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, name.utf16.count <= 100 else {
                error = "新規カテゴリ名を1〜100文字で入力してください。"
                return false
            }
        }
        for (source, tag) in accountTags where tag == "new" {
            let name = (newAccountNames[source] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, name.utf16.count <= 100 else {
                error = "新しい支払元名を1〜100文字で入力してください。"
                return false
            }
        }
        return true
    }

    private var dataMappings: KMMoneyForwardMappings {
        var result = KMMoneyForwardMappings()
        for (key, choice) in mappings.categories {
            switch choice {
            case .existing(let id): result.categories[key] = .existing(id: id)
            case .new(let name): result.categories[key] = .new(name: name)
            case .unclassified: result.categories[key] = .unclassified
            case .exclude: result.categories[key] = .exclude
            case .unresolved: result.categories[key] = .unresolved
            }
        }
        for (source, choice) in mappings.accounts {
            switch choice {
            case .existing(let id): result.accounts[source] = .existing(id: id)
            case .new(let name): result.accounts[source] = .new(name: name)
            case .unset: result.accounts[source] = .unset
            }
        }
        return result
    }

    private var dataChoices: [String: KMMoneyForwardRecordChoice] {
        var result: [String: KMMoneyForwardRecordChoice] = [:]
        for (importedId, tag) in recordTags {
            if tag == "separate" { result[importedId] = .separate }
            else if !tag.isEmpty { result[importedId] = .keep(transactionId: tag) }
        }
        return result
    }

    private static func previewInput(_ value: KMMoneyForwardPreview) -> KMMoneyForwardPresentation.PreviewInput {
        let status: KMMoneyForwardPresentation.PreviewInput.Status
        switch value.status {
        case .ready: status = .ready
        case .duplicate: status = .duplicate
        case .excluded: status = .excluded
        case .unresolved: status = .unresolved
        case .review: status = .review
        }
        let choice: KMMoneyForwardPresentation.PreviewInput.Choice?
        switch value.recordChoice {
        case .separate?: choice = .separate
        case .keep?: choice = .keep
        case nil: choice = nil
        }
        return .init(row: value.row, importedId: value.importedId, status: status,
            candidates: value.candidates, recordChoice: choice)
    }

    private static func resultStatus(_ value: KMMoneyForwardBatch.Row) -> KMMoneyForwardPresentation.ResultSummary.RowStatus {
        switch value.status {
        case .created: .created
        case .duplicate: .duplicate
        case .excluded: .excluded
        case .undone: .other
        }
    }

    private static func presentationMappings(_ value: KMMoneyForwardMappings) -> KMMoneyForwardPresentation.Mappings {
        var result = KMMoneyForwardPresentation.Mappings()
        for (key, choice) in value.categories {
            switch choice {
            case .existing(let id): result.categories[key] = .existing(id: id)
            case .new(let name): result.categories[key] = .new(name: name)
            case .unclassified: result.categories[key] = .unclassified
            case .exclude: result.categories[key] = .exclude
            case .unresolved: result.categories[key] = .unresolved
            }
        }
        for (source, choice) in value.accounts {
            switch choice {
            case .existing(let id): result.accounts[source] = .existing(id: id)
            case .new(let name): result.accounts[source] = .new(name: name)
            case .unset: result.accounts[source] = .unset
            }
        }
        return result
    }
}

#if DEBUG
extension KMMoneyForwardModel {
    /// Opt-in synthetic state for XCUITest. Only available with an in-memory fixture.
    func loadScenarioIfNeeded(_ repositories: KMRepositories?) async {
        guard let repositories, repositories.fixtureName != nil, phase == .select, parsed == nil,
              KMMoneyForwardFixture.scenario == "sample" else { return }
        await loadCSV(data: Data(KMMoneyForwardFixture.csv.utf8), name: "synthetic.csv", repositories: repositories)
    }
}
#endif
