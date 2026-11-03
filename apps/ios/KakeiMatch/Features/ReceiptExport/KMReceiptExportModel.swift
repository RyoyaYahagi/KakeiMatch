import Foundation
import Observation

@MainActor @Observable
final class KMReceiptExportModel {
    private(set) var settings = KMReceiptExportSettings()
    private(set) var status: KMReceiptExportStatus?
    private(set) var categories: [KMCategory] = []
    private(set) var hasSavedToken = false
    private(set) var isSending = false
    private(set) var loaded = false
    var baseURLText = ""
    /// Only what the user is typing now. A saved token is never read back into the UI.
    var tokenText = ""
    var message: String?
    var error: String?

    private let service: KMReceiptExportService

    init(service: KMReceiptExportService? = nil) {
        self.service = service ?? .live
    }

    var selectedCategoryIds: Set<String> { settings.effectiveCategoryIds(categories) }
    var expenseCategories: [KMCategory] { categories.filter { !$0.isIncome && !$0.hidden } }
    var endpointError: String? { KMReceiptExportPresentation.endpointError(baseURLText) }
    var canSaveConnection: Bool {
        endpointError == nil
            && (baseURLText.trimmingCharacters(in: .whitespacesAndNewlines) != settings.baseURL
                || !tokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    var canSend: Bool { settings.isEnabled && !isSending }

    func load(_ repositories: KMRepositories?) async {
        defer { loaded = true }
        do {
            let state = try service.state()
            settings = state.settings
            status = state.lastStatus
            baseURLText = state.settings.baseURL
            hasSavedToken = try service.hasToken()
            error = nil
        } catch {
            self.error = "連携設定を読み込めませんでした。\(error.localizedDescription)"
        }
        guard let repositories else { return }
        do {
            categories = try await repositories.categories.categories(includeHidden: true)
        } catch {
            self.error = "カテゴリを読み込めませんでした。\(error.localizedDescription)"
        }
    }

    func setEnabled(_ enabled: Bool) {
        update { $0.isEnabled = enabled }
    }

    func toggleCategory(_ id: String) {
        var selected = selectedCategoryIds
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
        // Category-list order. Hidden categories stay selected; IDs of deleted categories are dropped.
        let ordered = categories.map(\.id).filter(selected.contains)
        update { $0.categoryIds = ordered }
    }

    func saveConnection() {
        message = nil
        guard endpointError == nil else { return }
        let url = baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = tokenText.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if !token.isEmpty {
                try service.saveToken(token)
                hasSavedToken = true
            }
            settings = try service.updateSettings { $0.baseURL = url }.settings
            baseURLText = url
            tokenText = ""
            error = nil
            message = "送信先を保存しました。"
        } catch {
            self.error = "送信先を保存できませんでした。\(error.localizedDescription)"
        }
    }

    func deleteToken() {
        message = nil
        do {
            try service.saveToken(nil)
            hasSavedToken = false
            error = nil
            message = "トークンを削除しました。"
        } catch {
            self.error = "トークンを削除できませんでした。\(error.localizedDescription)"
        }
    }

    func sendNow(_ repositories: KMRepositories?) async {
        guard canSend, let repositories else { return }
        message = nil
        isSending = true
        defer { isSending = false }
        if let result = await service.run(receipts: repositories.receipts, categories: repositories.categories) {
            status = result
        } else if service.isRunning {
            message = "送信中です。しばらくしてから確認してください。"
        }
    }

    private func update(_ change: (inout KMReceiptExportSettings) -> Void) {
        message = nil
        do {
            settings = try service.updateSettings(change).settings
            error = nil
        } catch {
            self.error = "連携設定を保存できませんでした。\(error.localizedDescription)"
        }
    }
}
