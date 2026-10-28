import Foundation
import Observation
import UIKit

@MainActor @Observable
final class KMReceiptModel {
    enum Phase: Equatable { case idle, reading, categorizing, failed(KMAPIError) }
    var phase = Phase.idle
    var receipt: KMReceipt?
    var merchant = ""
    var amount = ""
    var date = ""
    var time = ""
    var memo = ""
    var tax = ""
    var excluded = false
    var categoryId = ""
    var accountId = ""
    var items: [KMReceiptItem] = []
    var adjustments: [KMReceiptAdjustment] = []
    var reviewed: [Int] = []
    var categories: [KMCategory] = []
    var accounts: [KMAccount] = []
    var imageData: Data?
    var imageIsSaved = false
    var pane = "overview"
    var loading = true
    var saving = false
    var didSave = false
    var error: String?
    var status: String?
    var startedReading = Date()
    @ObservationIgnored private var repositories: KMRepositories?
    @ObservationIgnored private var reviewTask: Task<Void, Never>?
    @ObservationIgnored private var operation: Task<Void, Never>?
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var api: KMWorkerAPI?

    init(api: KMWorkerAPI? = nil) { self.api = api }

    var isReading: Bool { phase == .reading || phase == .categorizing }
    var warnings: [KMReceiptPresentation.Warning] { KMReceiptPresentation.warnings(receipt?.extraction, reviewed: reviewed) }
    var totalResult: Result<KMReceiptPresentation.TotalCheck?, Error> {
        Result { try KMReceiptPresentation.totalCheck(total: Int(amount), items: items, adjustments: adjustments, tax: Int(tax)) }
    }
    var totalCheck: KMReceiptPresentation.TotalCheck? {
        if case .success(let value) = totalResult { return value }; return nil
    }
    var totalError: String? {
        if case .failure(let error) = totalResult { return error.localizedDescription }; return nil
    }
    var today: KMDate { KMDate(instant: repositories?.referenceDate ?? Date()) }
    var now: Date { repositories?.fixtureName == nil ? Date() : repositories!.referenceDate }

    func load(_ repositories: KMRepositories?, receiptID: String?) async {
        guard loading else { return }
        self.repositories = repositories
        defer { loading = false }
        guard let repositories else { error = "家計簿を読み込めません。アプリを開き直してください。"; return }
        do {
            categories = try await repositories.categories.categories(includeHidden: false).filter { !$0.isIncome }
            accounts = try await repositories.accounts.accounts(includeClosed: false)
            date = today.rawValue
            if let receiptID {
                guard let existing = try await repositories.receipts.receipt(id: receiptID), existing.registration.status == .pending else {
                    throw KMDataError.invalidData("確認待ちのレシートが見つかりません。記録一覧を開き直してください。")
                }
                try await display(existing)
            }
            #if DEBUG
            if repositories.fixtureName == "receipt", ProcessInfo.processInfo.arguments.contains("-ReceiptScenario") {
                try await configureFixture()
            }
            #endif
        } catch { self.error = error.localizedDescription }
    }

    #if DEBUG
    func loadFixtureReceipt(warning: Bool) async throws {
        guard let repositories, repositories.fixtureName == "receipt", var value = try await repositories.receipts.receipts().first else { return }
        if warning {
            value.extraction?.totalAmountYen = 2238
            value.extraction?.warnings = [.init(field: .totalAmountYen, code: "uncertain", message: "合計金額が不鮮明です。写真と照らし合わせてください。")]
            try await repositories.receipts.saveReceipt(value)
        }
        try await display(value)
    }
    #endif

    private func display(_ receipt: KMReceipt) async throws {
        if let extraction = receipt.extraction { try KMReceiptPresentation.validateExtraction(extraction) }
        self.receipt = receipt
        reviewed = receipt.reviewedWarnings ?? []
        applyValues(receipt)
        if let image = receipt.image {
            imageData = try await repositories?.receipts.receiptImage(blobId: image.blobId)
            imageIsSaved = imageData != nil
        }
    }

    private func applyValues(_ receipt: KMReceipt) {
        let confirmed = receipt.confirmedValue
        let extraction = receipt.extraction?.documentKind == .receipt ? receipt.extraction : nil
        merchant = confirmed?.merchant ?? extraction?.merchant ?? ""
        amount = (confirmed?.totalAmountYen ?? extraction?.totalAmountYen).map(String.init) ?? ""
        date = (confirmed?.purchasedDate ?? extraction?.purchasedDate ?? today).rawValue
        time = confirmed?.purchasedTime ?? extraction?.purchasedTime ?? ""
        tax = (confirmed?.taxAmountYen ?? extraction?.taxAmountYen).map(String.init) ?? ""
        memo = confirmed?.memo ?? ""; excluded = confirmed?.excludedFromSpending ?? false
        categoryId = confirmed?.categoryId ?? receipt.aiSuggestion.categoryId ?? ""
        accountId = confirmed?.accountId ?? accountId
        items = confirmed?.items ?? (extraction?.items ?? []).enumerated().map { i, item in
            KMReceiptItem(id: "receipt-item:\(receipt.id):\(i)", name: item.name, amountYen: item.amountYen,
                quantity: item.quantity, unitPriceYen: item.unitPriceYen,
                categoryId: receipt.itemCategories.flatMap { $0.indices.contains(i) ? $0[i] : nil })
        }
        adjustments = confirmed?.adjustments ?? (extraction?.adjustments ?? []).enumerated().map { i, adjustment in
            KMReceiptAdjustment(id: "receipt-adjustment:\(receipt.id):\(i)", label: adjustment.label, amountYen: adjustment.amountYen,
                targetItemId: adjustment.targetItemIndex.flatMap { items.indices.contains($0) ? items[$0].id : nil })
        }
    }

    func selectImage(_ data: Data, contentType: String) {
        stopWaiting()
        guard data.count <= 10 * 1024 * 1024, KMUploadImage.matches(data, contentType: contentType), UIImage(data: data) != nil else {
            error = "10 MiB以下のJPEG・PNG・WebP画像を選んでください。"; return
        }
        guard receipt?.image == nil else {
            error = "撮り直した写真を保存できないため、元のレシート画像と入力内容を保っています。手で入力して続けられます。"; return
        }
        imageData = data; imageIsSaved = false
        error = "写真を端末に保存できませんでした。手で入力して続けられます。"
        // ReceiptRepository has no image creation operation. Do not invent a blob ID or send unsaved bytes.
    }

    func review(_ warning: KMReceiptPresentation.Warning) async {
        let previous = reviewTask
        let task = Task { await previous?.value; await persistReview(warning) }
        reviewTask = task
        await task.value
    }

    private func persistReview(_ warning: KMReceiptPresentation.Warning) async {
        guard !reviewed.contains(warning.id), var receipt, let repositories else { return }
        do {
            try await ensureCurrent(receipt)
            var indexes = reviewed; indexes.append(warning.id)
            receipt.reviewedWarnings = indexes; receipt.updatedAt = now
            try await repositories.receipts.saveReceipt(receipt)
            guard let saved = try await repositories.receipts.receipt(id: receipt.id) else { throw KMDataError.notFound("レシートを再取得できませんでした。") }
            self.receipt = saved; reviewed = saved.reviewedWarnings ?? []
        } catch { self.error = error.localizedDescription }
    }

    func reviewField(_ field: KMReceiptExtraction.WarningField) async {
        for warning in warnings.filter({ $0.field == field }) { await review(warning) }
    }

    @discardableResult
    func startReading() -> Task<Void, Never>? {
        guard !isReading, !saving, !didSave else { return nil }
        guard imageIsSaved, let imageData, let image = receipt?.image else {
            error = "写真を端末に保存できないため、読み取りを開始できません。手で入力して続けられます。"; return nil
        }
        revision = UUID(); let token = revision
        phase = .reading; startedReading = Date(); error = nil; status = nil
        operation = Task {
            do {
                let client: KMWorkerAPI
                if let api { client = api } else {
                    client = KMWorkerAPI(configuration: try KMAPIConfiguration()); api = client
                }
                let flow = UUID()
                let extraction = try await client.readReceipt(image: KMUploadImage(data: imageData, contentType: image.contentType), flowID: flow)
                try KMReceiptPresentation.validateExtraction(extraction)
                guard revision == token, !Task.isCancelled, var receipt, let repositories else { return }
                try await ensureCurrent(receipt)
                guard revision == token, !Task.isCancelled else { return }
                receipt.extraction = extraction
                if extraction.documentKind == .receipt { receipt.confirmedValue = nil }
                receipt.itemCategories = nil
                receipt.aiFlowId = flow.uuidString; receipt.reviewedWarnings = []; receipt.updatedAt = now
                receipt.aiSuggestion = .init(source: .unclassified)
                try await repositories.receipts.saveReceipt(receipt)
                guard revision == token else { return }
                guard let saved = try await repositories.receipts.receipt(id: receipt.id) else { throw KMDataError.notFound("レシートを再取得できませんでした。") }
                self.receipt = saved; reviewed = []
                guard extraction.documentKind == .receipt else {
                    phase = .idle; status = "レシートとして読み取れませんでした。写真を確認するか、手で入力してください。"; return
                }
                applyValues(saved)
                phase = .categorizing
                do {
                    let answers = try await client.classify(extraction: extraction, flowID: flow,
                        categories: categories.map { .init(id: $0.id, name: $0.name) })
                    guard revision == token, !Task.isCancelled, var updated = self.receipt else { return }
                    try await ensureCurrent(updated)
                    guard revision == token, !Task.isCancelled else { return }
                    updated.itemCategories = extraction.items.indices.map { answers.answers["item_\($0)"]?.suggestedCategoryID }
                    updated.aiSuggestion = .init(categoryId: answers.answers["category"]?.suggestedCategoryID,
                        source: .jev, model: answers.model, attemptedAt: now, flowId: flow.uuidString)
                    updated.updatedAt = now
                    try await repositories.receipts.saveReceipt(updated)
                    guard revision == token else { return }
                    guard let saved = try await repositories.receipts.receipt(id: updated.id) else { throw KMDataError.notFound("レシートを再取得できませんでした。") }
                    self.receipt = saved; applyValues(saved)
                } catch {
                    guard revision == token else { return }
                    self.error = "カテゴリを提案できませんでした。読み取った内容は編集できます。"
                }
                guard revision == token else { return }
                phase = .idle
            } catch {
                guard revision == token, !Task.isCancelled else { return }
                let failure = error as? KMAPIError ?? .network
                phase = .failed(failure)
                self.error = KMReceiptPresentation.failureMessage(failure)
            }
        }
        return operation
    }

    func stopWaiting() {
        let wasCategorizing = phase == .categorizing
        revision = UUID(); operation?.cancel(); operation = nil
        if isReading {
            status = wasCategorizing ? "読み取った内容を表示しました。カテゴリは自分で選べます。" : "読み取りを待たずに入力できます。読み取りが終わっても、入力した内容はそのままです。"
        }
        phase = .idle
    }

    private func ensureCurrent(_ receipt: KMReceipt) async throws {
        guard let saved = try await repositories?.receipts.receipt(id: receipt.id),
              saved.updatedAt == receipt.updatedAt, saved.registration.status == .pending else {
            throw KMDataError.invalidData("レシートが変更されています。記録一覧から開き直してください。")
        }
    }

    func save() async {
        guard !saving, !didSave, !isReading, let repositories else { return }
        saving = true; error = nil
        defer { saving = false }
        await reviewTask?.value
        do {
            let total = try KMEntryPresentation.parseAmountYen(amount, allowsZero: receipt?.image != nil)
            let purchasedDate = try KMDate(date)
            guard !merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, merchant.utf16.count <= 200 else {
                throw KMDataError.invalidData("店名を200文字以内で入力してください。")
            }
            guard accounts.contains(where: { $0.id == accountId }) else { throw KMDataError.invalidData("支払元を選んでください。") }
            guard memo.utf16.count <= 2000 else { throw KMDataError.invalidData("メモは2000文字以内で入力してください。") }
            if !time.isEmpty, time.range(of: #"^([01]\d|2[0-3]):[0-5]\d$"#, options: .regularExpression) == nil {
                throw KMDataError.invalidData("時刻を確認してください。")
            }
            let taxYen = tax.isEmpty ? nil : try KMEntryPresentation.parseAmountYen(tax, allowsZero: true)
            // The repository owns allocation validation and posting, including mixed-category splits.
            let fallback = categoryId.isEmpty ? items.compactMap(\.categoryId).first ?? "" : categoryId
            guard categories.contains(where: { $0.id == fallback }) else { throw KMDataError.invalidData("カテゴリを選択してください。") }
            var updated = receipt ?? KMReceipt(id: "receipt:\(UUID().uuidString)", createdAt: now, updatedAt: now,
                aiSuggestion: .init(source: .unclassified), registration: .init(status: .pending))
            if receipt != nil { try await ensureCurrent(updated) }
            updated.confirmedValue = .init(merchant: merchant, purchasedDate: purchasedDate, purchasedTime: time.isEmpty ? nil : time,
                totalAmountYen: total, categoryId: fallback, accountId: accountId, excludedFromSpending: excluded,
                memo: memo.isEmpty ? nil : memo, taxAmountYen: taxYen, items: items, adjustments: adjustments)
            updated.reviewedWarnings = reviewed; updated.updatedAt = now
            try await repositories.receipts.saveReceipt(updated)
            // Retain the pending snapshot if posting fails, so a retry never creates a second receipt.
            receipt = updated
            guard let pending = try await repositories.receipts.receipt(id: updated.id) else { throw KMDataError.notFound("レシートを再取得できませんでした。") }
            receipt = pending
            _ = try await repositories.receipts.registerReceipt(id: updated.id, at: now)
            guard let saved = try await repositories.receipts.receipt(id: updated.id), saved.registration.status == .applied else {
                throw KMDataError.invalidData("登録結果を確認できませんでした。記録一覧を確認してください。")
            }
            receipt = saved; didSave = true; status = "登録しました。"
        } catch { self.error = error.localizedDescription }
    }
}
