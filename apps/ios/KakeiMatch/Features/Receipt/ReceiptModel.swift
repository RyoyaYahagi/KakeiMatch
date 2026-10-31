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
    var adjustmentIsAddition: [String: Bool] = [:]
    var warningItemIDs: [Int: String] = [:]
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
    /// PWA local-ui.ts: receiptEditor opens an applied receipt as "支出の記録を編集".
    var editing = false
    @ObservationIgnored private var requiresExistingReceipt = false
    @ObservationIgnored private(set) var repositories: KMRepositories?
    @ObservationIgnored private var reviewTask: Task<Void, Never>?
    @ObservationIgnored private var operation: Task<Void, Never>?
    @ObservationIgnored private var draftTask: Task<Void, Never>?
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var api: KMWorkerAPI?

    init(api: KMWorkerAPI? = nil) { self.api = api }

    var canSave: Bool { !loading && (!requiresExistingReceipt || receipt != nil) }
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
    var categorySummary: Result<[KMReceiptPresentation.CategoryTotal], Error> {
        Result { try KMReceiptPresentation.categoryTotals(items: items, defaultCategoryId: categoryId, categories: categories) }
    }
    var categoryCount: Int {
        if case .success(let totals) = categorySummary { return totals.count }
        return 0
    }
    var categorySummaryText: String {
        guard case .success(let totals) = categorySummary else { return "カテゴリ別の金額を確認できません" }
        return totals.map { "\($0.name) \(KMAmountFormatter.yen($0.amountYen))" }.joined(separator: "　")
    }
    var today: KMDate { KMDate(instant: repositories?.referenceDate ?? Date()) }
    var now: Date { repositories?.fixtureName == nil ? Date() : repositories!.referenceDate }
    /// PWA local-ui.ts:read — the unfinished form, raw text included, saved after a short delay.
    var draftSnapshot: KMReceiptDraft {
        .init(merchant: merchant, purchasedDate: date, purchasedTime: time.isEmpty ? nil : time,
              totalAmountText: amount, categoryId: categoryId, accountId: accountId,
              items: items, adjustments: adjustments, taxAmountText: tax,
              memo: memo.isEmpty ? nil : memo, excludedFromSpending: excluded)
    }

    func load(_ repositories: KMRepositories?, receiptID: String?, editing: Bool = false) async {
        guard loading else { return }
        self.repositories = repositories
        self.editing = editing
        requiresExistingReceipt = receiptID != nil
        defer { loading = false }
        guard let repositories else { error = "家計簿を読み込めません。アプリを開き直してください。"; return }
        do {
            let visibleCategories = try await repositories.categories.categories(includeHidden: false).filter { !$0.isIncome }
            let history = try await repositories.transactions.transactions(matching: KMTransactionQuery(limit: nil))
            categories = KMReceiptPresentation.categoryChoices(categories: visibleCategories, transactions: history)
            accounts = try await repositories.accounts.accounts(includeClosed: false)
            date = today.rawValue
            if let receiptID {
                guard let existing = try await repositories.receipts.receipt(id: receiptID),
                      existing.registration.status == (editing ? .applied : .pending) else {
                    throw KMDataError.invalidData(editing ? "登録済みのレシートが見つかりません。記録一覧を開き直してください。"
                        : "確認待ちのレシートが見つかりません。記録一覧を開き直してください。")
                }
                try await display(existing)
            }
            #if DEBUG
            if !editing, repositories.fixtureName == "receipt", ProcessInfo.processInfo.arguments.contains("-ReceiptScenario") {
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

    func display(_ receipt: KMReceipt) async throws {
        if let extraction = receipt.extraction { try KMReceiptPresentation.validateExtraction(extraction) }
        self.receipt = receipt
        reviewed = receipt.reviewedWarnings ?? []
        applyValues(receipt)
        // PWA prefers a useful unfinished draft over confirmed/extracted values on reopen.
        if let draft = try await repositories?.receipts.receiptDraft(receiptId: receipt.id), draft.isUseful {
            applyValues(draft)
        }
        if let image = receipt.image {
            imageData = try await repositories?.receipts.receiptImage(blobId: image.blobId)
            imageIsSaved = imageData != nil
        }
    }

    private func applyValues(_ draft: KMReceiptDraft) {
        merchant = draft.merchant
        amount = draft.totalAmountText
        if !draft.purchasedDate.isEmpty { date = draft.purchasedDate }
        time = draft.purchasedTime ?? ""
        tax = draft.taxAmountText
        memo = draft.memo ?? ""
        excluded = draft.excludedFromSpending
        categoryId = draft.categoryId
        accountId = draft.accountId
        items = draft.items
        adjustments = draft.adjustments
        adjustmentIsAddition = Dictionary(uniqueKeysWithValues: adjustments.map { ($0.id, $0.amountYen > 0) })
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
        adjustmentIsAddition = Dictionary(uniqueKeysWithValues: adjustments.map { ($0.id, $0.amountYen > 0) })
        warningItemIDs = (receipt.extraction?.warnings ?? []).reduce(into: [:]) { ids, warning in
            guard warning.field == .items, let index = warning.index, items.indices.contains(index) else { return }
            ids[index] = items[index].id
        }
    }

    func hasUnreviewedItemWarning(_ itemId: String) -> Bool {
        warnings.contains { warning in
            warning.field == .items && warning.index.flatMap { warningItemIDs[$0] } == itemId
        }
    }

    func setItemCategory(_ itemId: String, categoryId: String?) {
        guard let index = items.firstIndex(where: { $0.id == itemId }) else { return }
        items[index].categoryId = categoryId
    }

    func setAllItemCategories(_ categoryId: String?) {
        items = items.map { item in
            var updated = item
            updated.categoryId = categoryId
            return updated
        }
    }

    func setItemName(_ itemId: String, value: String) {
        guard let index = items.firstIndex(where: { $0.id == itemId }) else { return }
        items[index].name = String(value.prefix(200))
    }

    func setItemAmount(_ itemId: String, value: String) {
        guard let index = items.firstIndex(where: { $0.id == itemId }) else { return }
        if value.isEmpty { items[index].amountYen = nil }
        else if let amount = Int(value), amount >= 0, amount <= KMYen.maxSafe { items[index].amountYen = amount }
    }

    func setItemQuantity(_ itemId: String, value: String) {
        guard let index = items.firstIndex(where: { $0.id == itemId }) else { return }
        if value.isEmpty { items[index].quantity = nil }
        else if let quantity = Decimal(string: value, locale: Locale(identifier: "en_US_POSIX")), quantity >= 0 {
            items[index].quantity = quantity
        }
    }

    func setItemUnitPrice(_ itemId: String, value: String) {
        guard let index = items.firstIndex(where: { $0.id == itemId }) else { return }
        if value.isEmpty { items[index].unitPriceYen = nil }
        else if let amount = Int(value), amount >= 0, amount <= KMYen.maxSafe { items[index].unitPriceYen = amount }
    }

    func addItem() -> String {
        let id = "receipt-item:\(UUID().uuidString)"
        items.append(.init(id: id, name: "", amountYen: nil))
        return id
    }

    func removeItem(_ itemId: String) {
        items.removeAll { $0.id == itemId }
        adjustments = adjustments.map { adjustment in
            guard adjustment.targetItemId == itemId else { return adjustment }
            var updated = adjustment
            updated.targetItemId = nil
            return updated
        }
    }

    func adjustmentIsAddition(for adjustmentId: String) -> Bool {
        adjustmentIsAddition[adjustmentId] ?? adjustments.first(where: { $0.id == adjustmentId }).map { $0.amountYen > 0 } ?? false
    }

    func adjustmentAmountText(for adjustmentId: String) -> String {
        guard let adjustment = adjustments.first(where: { $0.id == adjustmentId }) else { return "" }
        return String(adjustment.amountYen.magnitude)
    }

    func adjustmentDisplayAmount(for adjustmentId: String) -> String {
        guard let adjustment = adjustments.first(where: { $0.id == adjustmentId }),
              let amount = Int(exactly: adjustment.amountYen.magnitude) else { return "" }
        return (adjustment.amountYen < 0 ? "−" : "+") + KMAmountFormatter.yen(amount)
    }

    func setAdjustmentLabel(_ adjustmentId: String, value: String) {
        guard let index = adjustments.firstIndex(where: { $0.id == adjustmentId }) else { return }
        adjustments[index].label = String(value.prefix(100))
    }

    func setAdjustmentKind(_ adjustmentId: String, isAddition: Bool) {
        guard let index = adjustments.firstIndex(where: { $0.id == adjustmentId }) else { return }
        adjustmentIsAddition[adjustmentId] = isAddition
        let amount = Int(adjustments[index].amountYen.magnitude)
        adjustments[index].amountYen = isAddition ? amount : -amount
    }

    func setAdjustmentAmount(_ adjustmentId: String, value: String) {
        guard let index = adjustments.firstIndex(where: { $0.id == adjustmentId }) else { return }
        let amount = value.isEmpty ? 0 : Int(value)
        guard let amount, amount >= 0, amount <= KMYen.maxSafe else { return }
        adjustments[index].amountYen = adjustmentIsAddition(for: adjustmentId) ? amount : -amount
    }

    func setAdjustmentTarget(_ adjustmentId: String, itemId: String?) {
        guard let index = adjustments.firstIndex(where: { $0.id == adjustmentId }) else { return }
        adjustments[index].targetItemId = itemId
    }

    func addAdjustment() -> String {
        let id = "receipt-adjustment:\(UUID().uuidString)"
        adjustments.append(.init(id: id, label: "値引き", amountYen: 0))
        adjustmentIsAddition[id] = false
        return id
    }

    func removeAdjustment(_ adjustmentId: String) {
        adjustments.removeAll { $0.id == adjustmentId }
        adjustmentIsAddition.removeValue(forKey: adjustmentId)
    }

    /// PWA local-ui.ts:saveImage — save the original before any AI read, then edit that receipt.
    func selectImage(_ data: Data, contentType: String) async {
        stopWaiting()
        guard let repositories else { error = "家計簿を読み込めません。アプリを開き直してください。"; return }
        if let current = receipt, current.registration.status != .pending || current.registration.actualTransactionId != nil {
            error = "登録済みのレシート画像は変更できません。"; return
        }
        do {
            let saved = try await repositories.receipts.saveReceiptImage(data: data, contentType: contentType,
                replacingReceiptId: receipt?.id, at: now)
            receipt = saved
            imageData = data; imageIsSaved = true
            applyValues(saved)
            // PWA replaces a pending receipt and opens a fresh editor for the new photo.
            categoryId = ""; items = []; adjustments = []; adjustmentIsAddition = [:]
            reviewed = []; status = nil; error = nil
        } catch {
            imageData = nil; imageIsSaved = false
            self.error = error.localizedDescription
        }
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

    /// PWA local-ui.ts:scheduleDraft — debounce 350 ms; the latest edit wins.
    func scheduleDraftSave() {
        guard !loading, !saving, !didSave, let receipt, !receipt.id.isEmpty else { return }
        draftTask?.cancel()
        draftTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await self?.saveDraft()
        }
    }

    /// Writes the current form to the draft record. A deleted pending receipt is not recreated.
    func saveDraft() async {
        guard let receipt, let repositories, !didSave, !saving else { return }
        do {
            try await repositories.receipts.saveReceiptDraft(draftSnapshot, receiptId: receipt.id, at: now)
            status = "入力内容を端末に保存しました。"
        } catch let failure as KMDataError {
            // PWA local-ui.ts:putIfRecordExists shows this exact message instead of recreating.
            if case .notFound = failure { status = "この確認待ちレシートは削除されています。画面を開き直してください。" }
            else { error = failure.localizedDescription }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func flushDraft() async {
        draftTask?.cancel(); draftTask = nil
        await saveDraft()
    }

    @discardableResult
    func startReading() -> Task<Void, Never>? {
        guard !isReading, !saving, !didSave else { return nil }
        guard imageIsSaved, let imageData, let image = receipt?.image else {
            error = "先にレシートの写真を選んでください。手で入力して続けられます。"; return nil
        }
        revision = UUID(); let token = revision
        phase = .reading; startedReading = Date(); error = nil; status = nil
        KMContactDiagnosticRecorder.shared.recordAction(.receiptAIStarted, screen: .records)
        operation = Task {
            do {
                await saveDraft()
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
                let learning = KMReceiptPresentation.categoryLearning(
                    merchant: extraction.merchant, itemNames: extraction.items.map(\.name),
                    rules: try await repositories.categoryLearning.categoryRules(), categories: categories
                )
                guard revision == token, !Task.isCancelled, var learnedReceipt = self.receipt else { return }
                learnedReceipt.itemCategories = learning.itemCategoryIds
                learnedReceipt.aiSuggestion = .init(categoryId: learning.categoryId,
                    source: learning.appliedRules.isEmpty ? .unclassified : .learnedRule,
                    flowId: flow.uuidString, categoryRules: learning.appliedRules.isEmpty ? nil : learning.appliedRules)
                learnedReceipt.updatedAt = now
                try await repositories.receipts.saveReceipt(learnedReceipt)
                guard revision == token, !Task.isCancelled else { return }
                guard let savedWithLearning = try await repositories.receipts.receipt(id: learnedReceipt.id) else {
                    throw KMDataError.notFound("レシートを再取得できませんでした。")
                }
                self.receipt = savedWithLearning
                applyValues(savedWithLearning)
                if !learning.appliedRules.isEmpty { status = "いつもの分類を適用しました。" }

                let itemIndexes = learning.itemIndexesToClassify
                let needsClassification = extraction.items.isEmpty
                    ? extraction.merchant != nil && learning.categoryId == nil
                    : !itemIndexes.isEmpty
                guard needsClassification else { phase = .idle; return }
                do {
                    let answers = try await client.classify(extraction: extraction, flowID: flow,
                        categories: categories.map { .init(id: $0.id, name: $0.name) },
                        itemIndexes: extraction.items.isEmpty ? nil : itemIndexes)
                    guard revision == token, !Task.isCancelled, var updated = self.receipt else { return }
                    try await ensureCurrent(updated)
                    guard revision == token, !Task.isCancelled else { return }
                    if extraction.items.isEmpty {
                        updated.aiSuggestion = .init(categoryId: answers.answers["category"]?.suggestedCategoryID,
                            source: .jev, model: answers.model, attemptedAt: now, flowId: flow.uuidString)
                    } else {
                        let categoriesByItem = extraction.items.indices.map { index in
                            learning.itemCategoryIds[index] ?? answers.answers["item_\(index)"]?.suggestedCategoryID
                        }
                        updated.itemCategories = categoriesByItem
                        updated.aiSuggestion = .init(categoryId: categoriesByItem.first ?? nil,
                            source: .jev, model: answers.model, attemptedAt: now, flowId: flow.uuidString,
                            categoryRules: learning.appliedRules.isEmpty ? nil : learning.appliedRules)
                    }
                    updated.updatedAt = now
                    try await repositories.receipts.saveReceipt(updated)
                    guard revision == token else { return }
                    guard let saved = try await repositories.receipts.receipt(id: updated.id) else { throw KMDataError.notFound("レシートを再取得できませんでした。") }
                    self.receipt = saved; applyValues(saved)
                } catch {
                    guard revision == token else { return }
                    KMContactDiagnosticRecorder.shared.recordFailure(error, screen: .records)
                    self.error = "カテゴリを提案できませんでした。読み取った内容は編集できます。"
                }
                guard revision == token else { return }
                phase = .idle
            } catch {
                guard revision == token, !Task.isCancelled else { return }
                KMContactDiagnosticRecorder.shared.recordFailure(error, screen: .records)
                if let failure = error as? KMAPIError {
                    phase = .failed(failure)
                    self.error = KMReceiptPresentation.failureMessage(failure)
                } else {
                    phase = .idle
                    self.error = error.localizedDescription
                }
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
        let expectedStatus: KMReceipt.RegistrationStatus = editing ? .applied : .pending
        guard let saved = try await repositories?.receipts.receipt(id: receipt.id),
              saved.updatedAt == receipt.updatedAt, saved.registration.status == expectedStatus else {
            throw KMDataError.invalidData("レシートが変更されています。記録一覧から開き直してください。")
        }
    }

    func save() async {
        guard canSave, !saving, !didSave, !isReading, let repositories else { return }
        // Keep the latest edit before validation/registration; failed saves leave this draft for retry.
        await flushDraft()
        draftTask?.cancel(); draftTask = nil
        saving = true; error = nil
        KMContactDiagnosticRecorder.shared.recordAction(.receiptSaveStarted, screen: .records)
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
            let confirmed = KMConfirmedReceipt(merchant: merchant, purchasedDate: purchasedDate,
                purchasedTime: time.isEmpty ? nil : time, totalAmountYen: total, categoryId: fallback,
                accountId: accountId, excludedFromSpending: excluded, memo: memo.isEmpty ? nil : memo,
                taxAmountYen: taxYen, items: items, adjustments: adjustments)
            if editing {
                guard let current = receipt else { throw KMDataError.invalidData("登録済みのレシートを確認できません。記録一覧を開き直してください。") }
                try await ensureCurrent(current)
                // PWA local-receipts.ts:edit rejects a stale updatedAt before touching the ledger.
                let saved = try await repositories.receipts.editReceipt(id: current.id, value: confirmed,
                    expectedUpdatedAt: current.updatedAt, at: now)
                receipt = saved
                await saveLearning(receiptId: saved.id, fallback: fallback, repositories: repositories,
                    successMessage: "変更は保存しましたが、カテゴリの学習を保存できませんでした。")
                didSave = true; status = "変更を保存しました。"
                return
            }
            var updated = receipt ?? KMReceipt(id: "receipt:\(UUID().uuidString)", createdAt: now, updatedAt: now,
                aiSuggestion: .init(source: .unclassified), registration: .init(status: .pending))
            if receipt != nil { try await ensureCurrent(updated) }
            updated.confirmedValue = confirmed
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
            await saveLearning(receiptId: saved.id, fallback: fallback, repositories: repositories,
                successMessage: "レシートは登録しましたが、カテゴリの学習を保存できませんでした。")
        } catch {
            KMContactDiagnosticRecorder.shared.recordFailure(error, screen: .records)
            self.error = error.localizedDescription
        }
    }

    private func saveLearning(receiptId: String, fallback: String, repositories: KMRepositories, successMessage: String) async {
        guard let observation = KMCategoryLearningService.observation(
            receiptId: receiptId, merchant: merchant, defaultCategoryId: fallback,
            items: items.map { (name: $0.name, categoryId: $0.categoryId) },
            availableCategoryIds: Set(categories.map(\.id)), confirmedAt: now
        ) else { return }
        do { try await repositories.categoryLearning.saveCategoryObservation(observation) }
        catch {
            // PWA local-ui.ts reports the same failure for both edit and register saves.
            KMContactDiagnosticRecorder.shared.recordFailure(error, screen: .records)
            self.error = "\(successMessage)\(error.localizedDescription)"
        }
    }
}
