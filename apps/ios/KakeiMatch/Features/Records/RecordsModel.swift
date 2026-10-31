import Foundation
import Observation

@MainActor @Observable
final class KMRecordsModel {
    enum Page { case list, search, detail, pending }
    var page = Page.list
    var filter = KMRecordsFilter.all
    var search = KMRecordsSearchDraft()
    var appliedSearch = KMRecordsSearchDraft()
    var days: [KMRecordDay] = []
    var searchRows: [KMTransaction] = []
    var searchTotal = 0
    var accounts: [KMAccount] = []
    var categories: [KMCategory] = []
    var receipts: [KMReceipt] = []
    var reviewIDs: Set<String> = []
    var selected: KMTransaction?
    var selectedReceipt: KMReceipt?
    var selectedPayroll: KMPayrollRecord?
    var draft: KMRecordEditDraft?
    var originalDraft: KMRecordEditDraft?
    var editing: String?
    var searchOrigin = false
    var busy = false
    var loaded = false
    var error: String?
    var message: String?
    @ObservationIgnored private var repositories: KMRepositories?
    @ObservationIgnored private var revision = 0

    var pending: [KMReceipt] { receipts.filter { $0.registration.status != .applied && $0.registration.status != .deleted } }
    var changed: Bool { draft != originalDraft }
    var canEdit: Bool { selectedReceipt != nil || selected?.isSplit != true }
    var now: Date {
        guard let repositories, repositories.fixtureName != nil else { return Date() }
        return KMFixtureClock.now(reference: repositories.referenceDate)
    }

    func configure(_ repositories: KMRepositories?) async {
        self.repositories = repositories
        await reload()
    }

    func reload() async {
        guard let repositories else { error = "家計簿を開けませんでした。アプリを開き直してください。"; return }
        revision += 1
        let request = revision
        busy = true; error = nil
        do {
            let days = try await repositories.transactions.recordDays(matching: KMTransactionQuery(kind: filter.kind))
            let receipts = try await repositories.receipts.receipts()
            let accounts = try await repositories.accounts.accounts(asOf: KMDate(instant: repositories.referenceDate), includeClosed: true)
            let categories = try await repositories.categories.categories(includeHidden: true)
            let run = try await repositories.reconciliation.latestRun()
            let decisions = try await repositories.reconciliation.resolutions()
            let suspected = try await repositories.reconciliation.suspectedStatements()
            guard request == revision else { return }
            self.days = days; self.receipts = receipts; self.accounts = accounts; self.categories = categories
            reviewIDs = KMRecordsPresentation.reviewIDs(run: run, resolutions: decisions, suspected: suspected, receipts: receipts)
            loaded = true
            if page == .search { try await fetchSearch(appliedSearch) }
        } catch { if request == revision { self.error = error.localizedDescription } }
        if request == revision { busy = false }
    }

    func showSearch() async {
        guard !busy else { return }
        page = .search; searchOrigin = true; search = appliedSearch; editing = nil
        await performSearch()
    }

    func performSearch(clear: Bool = false) async {
        guard let repositories, !busy else { return }
        if clear { search = KMRecordsSearchDraft() }
        busy = true; error = nil
        do {
            let query = try search.query()
            let rows = try await repositories.transactions.transactions(matching: query)
            let total = try KMRecordsPresentation.total(rows)
            appliedSearch = search; searchRows = rows; searchTotal = total
        } catch {
            searchRows = []; searchTotal = 0; self.error = error.localizedDescription
        }
        busy = false
    }

    private func fetchSearch(_ draft: KMRecordsSearchDraft) async throws {
        guard let repositories else { return }
        let rows = try await repositories.transactions.transactions(matching: draft.query())
        searchTotal = try KMRecordsPresentation.total(rows); searchRows = rows
    }

    func showList() async {
        guard !busy else { return }
        page = .list; searchOrigin = false; editing = nil; selected = nil; selectedReceipt = nil; selectedPayroll = nil; draft = nil
        await reload()
    }

    func open(_ row: KMTransaction) async {
        guard let repositories, !busy else { return }
        busy = true; error = nil; message = nil
        do {
            guard let current = try await repositories.transactions.transaction(id: row.id) else {
                throw KMDataError.notFound("記録が見つかりません。記録一覧を読み込み直してください。")
            }
            let receipts = try await repositories.receipts.receipts()
            let payroll = try await repositories.payroll.payrollRecords()
            selected = current
            selectedReceipt = receipts.first { $0.registration.actualTransactionId == current.id && $0.registration.status == .applied }
            // PWA transactionDetail: the confirmed snapshot linked to this income stays visible after edits.
            selectedPayroll = payroll.first { $0.actualTransactionId == current.id }
            draft = KMRecordEditDraft(current, receipt: selectedReceipt); originalDraft = draft
            editing = nil; page = .detail
        } catch { self.error = error.localizedDescription }
        busy = false
    }

    func backFromDetail() async {
        guard !busy else { return }
        editing = nil; selected = nil; selectedReceipt = nil; selectedPayroll = nil; draft = nil; error = nil
        if searchOrigin { page = .search; await reload() }
        else { await showList() }
    }

    func save() async {
        guard let repositories, let row = selected, let draft, !busy else { return }
        busy = true; error = nil
        do {
            if let receipt = selectedReceipt, var value = receipt.confirmedValue {
                value.totalAmountYen = try draft.amountYen(allowsZero: receipt.image != nil)
                value.purchasedDate = try KMDate(draft.date); value.merchant = draft.payee
                value.categoryId = draft.categoryId; value.accountId = draft.accountId; value.memo = draft.memo
                value.excludedFromSpending = row.excludedFromSpending
                _ = try await repositories.receipts.editReceipt(id: receipt.id, value: value, expectedUpdatedAt: receipt.updatedAt, at: now)
            } else if row.kind == .transfer {
                _ = try await repositories.transactions.saveTransfer(KMTransferInput(amountYen: draft.amountYen(), date: KMDate(draft.date),
                    sourceAccountId: draft.accountId, destinationAccountId: draft.destinationId, memo: draft.memo,
                    importedId: row.importedId ?? "manual:\(row.id)"), id: row.id)
            } else {
                _ = try await repositories.transactions.saveManual(KMManualTransactionInput(kind: row.kind, amountYen: draft.amountYen(),
                    date: KMDate(draft.date), payeeName: draft.payee, categoryId: draft.categoryId, accountId: draft.accountId,
                    memo: draft.memo, importedId: row.importedId ?? "manual:\(row.id)", excludedFromSpending: row.excludedFromSpending == true), id: row.id)
            }
            busy = false
            await open(row)
            message = "変更を保存しました。"
        } catch { self.error = error.localizedDescription; busy = false }
    }

    func setExcluded(_ excluded: Bool) async {
        guard let repositories, let row = selected, !busy else { return }
        busy = true; error = nil
        do {
            try await repositories.transactions.setSpendingExclusion(id: row.id, excluded: excluded)
            selected?.excludedFromSpending = excluded
            message = "保存しました。"
        } catch { self.error = "保存できませんでした。もう一度お試しください。" }
        busy = false
    }

    /// The shell owns the undo toast so it stays visible after leaving this tab.
    /// Returns the audit only when the deletion succeeded.
    func remove() async -> KMTransactionDeletion? {
        guard let repositories, let row = selected, !busy else { return nil }
        busy = true; error = nil
        do {
            var expected = [row]
            if let peerID = row.transferId, let peer = try await repositories.transactions.transaction(id: peerID) { expected.append(peer) }
            let audit = try await repositories.transactions.deleteTransaction(id: row.id, expected: expected, at: now)
            busy = false
            await backFromDetail()
            return audit
        } catch { self.error = error.localizedDescription; busy = false; return nil }
    }

    func deletePending(_ receipt: KMReceipt) async {
        guard let repositories, !busy else { return }
        busy = true; error = nil
        do { try await repositories.receipts.deleteReceipt(id: receipt.id); busy = false; await showList() }
        catch { self.error = error.localizedDescription; busy = false }
    }
}
