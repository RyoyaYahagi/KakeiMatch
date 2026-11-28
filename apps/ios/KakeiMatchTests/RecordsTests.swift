import Foundation
import Testing
@testable import KakeiMatch

struct RecordsPresentationTests {
    @Test func dayLabelsUseTokyoGregorianCalendar() {
        #expect(KMRecordsPresentation.dayLabel(KMDate(rawValue: "2026-10-13")) == "10月13日（火）")
        #expect(KMRecordsPresentation.dayLabel(KMDate(rawValue: "2024-02-29")) == "2月29日（木）")
    }

    @Test func queryUsesAllHistoryAndRejectsInvalidValues() throws {
        var draft = KMRecordsSearchDraft()
        #expect(try draft.query().limit == nil)
        draft.keyword = "スーパーみどり"; draft.minimum = "0"; draft.maximum = "5700"
        draft.startDate = "2026-10-01"; draft.kind = "expense"
        let query = try draft.query()
        #expect(query.minAmountYen == 0 && query.maxAmountYen == 5700 && query.kind == .expense)
        #expect(query.startDate?.rawValue == "2026-10-01")
        for bad in ["1.5", "-1", "1e3", "１２", "9007199254740992", "9223372036854775808"] {
            var invalid = draft; invalid.minimum = bad
            #expect(throws: (any Error).self) { try invalid.query() }
        }
        draft.endDate = "2026-09-30"
        #expect(throws: (any Error).self) { try draft.query() }
        draft.endDate = "2026-10-32"
        #expect(throws: (any Error).self) { try draft.query() }
        draft.endDate = ""; draft.minimum = "6000"
        #expect(throws: (any Error).self) { try draft.query() }
    }

    @Test func dateRangeSettersBuildStartAndEndWithoutReversing() throws {
        var draft = KMRecordsSearchDraft()
        draft.setStartDate("2026-10-05")
        draft.setEndDate("2026-10-20")
        let range = try draft.query()
        #expect(range.startDate == KMDate(rawValue: "2026-10-05"))
        #expect(range.endDate == KMDate(rawValue: "2026-10-20"))

        draft.setEndDate("2026-10-01")
        #expect(draft.startDate == "2026-10-01" && draft.endDate == "2026-10-01")
        let adjustedStart = try draft.query()
        #expect(adjustedStart.startDate == KMDate(rawValue: "2026-10-01"))
        #expect(adjustedStart.endDate == KMDate(rawValue: "2026-10-01"))

        draft.setStartDate("2026-10-25")
        #expect(draft.startDate == "2026-10-25" && draft.endDate == "2026-10-25")
        let adjustedEnd = try draft.query()
        #expect(adjustedEnd.startDate == KMDate(rawValue: "2026-10-25"))
        #expect(adjustedEnd.endDate == KMDate(rawValue: "2026-10-25"))

        draft.setStartDate("")
        #expect(draft.startDate.isEmpty && draft.endDate == "2026-10-25")
        #expect(try draft.query().startDate == nil)
        #expect(try draft.query().endDate == KMDate(rawValue: "2026-10-25"))

        draft.setEndDate("")
        #expect(draft.startDate.isEmpty && draft.endDate.isEmpty)
        #expect(try draft.query().endDate == nil)
    }

    @Test func categorySearchDraftBuildsMonthRangeAndCategoryId() throws {
        let oct = KMRecordsSearchDraft.forCategory("cat-food", in: KMYearMonth(rawValue: "2026-10"))
        #expect(oct == KMRecordsSearchDraft(startDate: "2026-10-01", endDate: "2026-10-31", categoryId: "cat-food"))
        let octQuery = try oct.query()
        #expect(octQuery.startDate == KMDate(rawValue: "2026-10-01"))
        #expect(octQuery.endDate == KMDate(rawValue: "2026-10-31"))
        #expect(octQuery.categoryId == "cat-food")
        #expect(octQuery.kind == nil && octQuery.keyword.isEmpty && octQuery.limit == nil)

        let apr = KMRecordsSearchDraft.forCategory("cat-daily", in: KMYearMonth(rawValue: "2026-04"))
        #expect(apr.startDate == "2026-04-01" && apr.endDate == "2026-04-30" && apr.categoryId == "cat-daily")

        let leapFeb = KMRecordsSearchDraft.forCategory("cat-comm", in: KMYearMonth(rawValue: "2024-02"))
        #expect(leapFeb.startDate == "2024-02-01" && leapFeb.endDate == "2024-02-29" && leapFeb.categoryId == "cat-comm")

        let nonLeapFeb = KMRecordsSearchDraft.forCategory("cat-comm", in: KMYearMonth(rawValue: "2026-02"))
        #expect(nonLeapFeb.startDate == "2026-02-01" && nonLeapFeb.endDate == "2026-02-28" && nonLeapFeb.categoryId == "cat-comm")
    }

    @Test func expenseMemoTitleAndAccessibleDateFollowPWA() {
        let row = KMTransaction(id: "record", date: KMDate(rawValue: "2026-10-07"), amountYen: -3284, kind: .expense,
            payeeName: "スーパーみどり", categoryName: "食費", accountId: "card", categoryId: "food", memo: "  牛乳とパン  ")
        let accounts = [KMAccount(id: "card", name: "合成カード")]
        let all = KMRecordsPresentation.summary(row, accounts: accounts, receipt: nil, needsReview: true)
        #expect(all.title == "スーパーみどり" && all.note == "食費 · 牛乳とパン")
        #expect(all.accessibilityLabel == "スーパーみどり · 10/7 · 食費 · 牛乳とパン · 要確認 · −¥3,284")
        let expense = KMRecordsPresentation.summary(row, accounts: accounts, receipt: nil, filter: .expense)
        #expect(expense.title == "牛乳とパン" && expense.note == "スーパーみどり · 合成カード")
        var blank = row; blank.memo = " \n "
        #expect(KMRecordsPresentation.summary(blank, accounts: accounts, receipt: nil, filter: .expense).title == "食費")
    }

    @Test func searchTransferShowsDestinationAndNoReviewOrReceiptAnnotation() {
        let row = KMTransaction(id: "transfer", date: KMDate(rawValue: "2026-10-01"), amountYen: -1000, kind: .transfer,
            accountId: "cash", transferAccountId: "bank")
        let summary = KMRecordsPresentation.summary(row, accounts: [.init(id: "bank", name: "合成銀行")], receipt: nil, search: true, needsReview: true)
        #expect(summary.note == "10/1 · 振替 · 振替先 合成銀行")
        #expect(!summary.needsReview && summary.showDate)
    }

    @Test func totalsExcludeTransfersAndExcludedRecordsAndCheckOverflow() throws {
        let date = KMDate(rawValue: "2026-10-01")
        let rows = [KMTransaction(id: "expense", date: date, amountYen: -100, kind: .expense, accountId: "cash"),
                    KMTransaction(id: "income", date: date, amountYen: 200, kind: .income, accountId: "cash"),
                    KMTransaction(id: "transfer", date: date, amountYen: -900, kind: .transfer, accountId: "cash"),
                    KMTransaction(id: "excluded", date: date, amountYen: -500, kind: .expense, accountId: "cash", excludedFromSpending: true)]
        #expect(try KMRecordsPresentation.total(rows) == 100)
        var overflow = rows[1]; overflow.amountYen = KMYen.maxSafe
        #expect(throws: (any Error).self) { try KMRecordsPresentation.total([overflow, rows[1]]) }
    }

    @Test func editAmountRejectsFractionAndZeroExceptImageReceipts() throws {
        let row = KMTransaction(id: "x", date: KMDate(rawValue: "2026-10-01"), amountYen: -100, kind: .expense, accountId: "cash")
        var draft = KMRecordEditDraft(row, receipt: nil)
        draft.amount = "0"
        #expect(throws: (any Error).self) { try draft.amountYen() }
        #expect(try draft.amountYen(allowsZero: true) == 0)
        draft.amount = "1.5"
        #expect(throws: (any Error).self) { try draft.amountYen() }
    }
}

@MainActor struct RecordsModelTests {
    @Test func fixtureListFilterSearchAndDetailReturn() async throws {
        let repo = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMRecordsModel(); await model.configure(repo)
        #expect(model.loaded && model.error == nil && model.days.count == 10)
        #expect(model.days.first?.date.rawValue == "2026-10-13")
        #expect(model.reviewIDs == ["fixture-transaction-000"])
        model.filter = .income; await model.reload()
        #expect(model.days.count == 1 && model.days.first?.records.count == 1)
        await model.showSearch(); model.search.keyword = "スーパーみどり"; await model.performSearch()
        #expect(model.searchRows.count == 2 && model.searchTotal == -5700)
        await model.open(try #require(model.searchRows.first))
        #expect(model.page == .detail && model.searchOrigin)
        await model.backFromDetail()
        #expect(model.page == .search && model.searchRows.count == 2 && model.search.keyword == "スーパーみどり")
        model.search.minimum = "9000"; model.search.maximum = "1"; await model.performSearch()
        #expect(model.error != nil && model.searchRows.isEmpty)
    }

    @Test func openReturnsBusyInsteadOfIgnoringTheTap() async throws {
        let repo = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMRecordsModel(); await model.configure(repo)
        let row = try #require(model.days.first?.records.first)
        model.busy = true
        let result = await model.open(row)
        #expect(result == .busy)
        #expect(model.page == .list && model.selected == nil)
        #expect(model.message != nil)
    }

    @Test func openRestoresTheSearchScreenWhenTheRecordDisappears() async throws {
        let repo = try KMFixtureLoader.load(named: "reconciliation")
        let model = KMRecordsModel(); await model.configure(repo)
        await model.showSearch()
        #expect(model.page == .search)
        let missing = KMTransaction(id: "missing-record", date: KMDate(rawValue: "2026-10-01"),
            amountYen: -100, kind: .expense, accountId: "fixture-account-1")
        let result = await model.open(missing)
        #expect(result == .failed("記録が見つかりません。記録一覧を読み込み直してください。"))
        #expect(model.page == .search && model.error != nil && model.selected == nil)
    }

    @Test func multiFieldSaveDeleteAndUndoUseRepositories() async throws {
        let repo = try KMFixtureLoader.load(named: "migration")
        let model = KMRecordsModel(); await model.configure(repo)
        let row = try #require(model.days.first?.records.first)
        await model.open(row)
        model.draft?.memo = "合成の編集メモ"; model.draft?.amount = "1200"
        await model.save()
        #expect(model.error == nil && !model.changed)
        let saved = try #require(try await repo.transactions.transaction(id: row.id))
        #expect(saved.memo == "合成の編集メモ" && saved.amountYen == -1200 && saved.id == row.id)
        _ = await model.remove()
        #expect(model.error == nil && model.page == .list)
        #expect(try await repo.transactions.transaction(id: row.id) == nil)
        let notice = KMDeletionNoticeModel()
        await notice.configure(repo)
        #expect(notice.deletion != nil)
        #expect(await notice.undo())
        #expect(notice.deletion == nil)
        #expect(notice.status == KMDeletionNoticeText.restored)
        #expect(try await repo.transactions.transaction(id: row.id)?.memo == "合成の編集メモ")
    }

    @Test func recreatedFixtureModelKeepsTheSharedClockOrigin() async throws {
        let repo = try KMFixtureLoader.load(named: "reconciliation")
        let first = KMRecordsModel(); await first.configure(repo)
        let firstNow = first.now
        // タブを離れると RecordsModel は作り直される。fixture の基準時刻を作り直しごとに
        // 決め直すと、shell の削除通知より時計が遅れ、10秒の取り消し期限が縮む。
        try await Task.sleep(for: .milliseconds(200))
        let second = KMRecordsModel(); await second.configure(repo)
        #expect(second.now.timeIntervalSince(firstNow) >= 0.1)
    }

    @Test func failedSaveRetainsDraftAndPendingIsNotCountedAsLedger() async throws {
        let repo = try KMFixtureLoader.load(named: "receipt")
        let model = KMRecordsModel(); await model.configure(repo)
        #expect(model.pending.count == 1)
        #expect(KMRecordsPresentation.pendingTitle(try #require(model.pending.first)) == "スーパーみどり")
        await model.open(try #require(model.days.first?.records.first))
        model.draft?.amount = "0"; model.draft?.memo = "保存失敗でも保持"
        await model.save()
        #expect(model.error != nil && model.draft?.memo == "保存失敗でも保持" && model.changed)
        #expect(try await repo.transactions.transactions(matching: .init(limit: nil)).count == 11)
    }

    @Test func transferSaveDeleteUndoPreservesPeer() async throws {
        let repo = try KMFixtureLoader.load(named: "migration")
        let transfer = try await repo.transactions.saveTransfer(.init(amountYen: 1000, date: KMDate("2026-10-14"),
            sourceAccountId: "fixture-account-1", destinationAccountId: "fixture-account-2", memo: "合成振替", importedId: "records-transfer"), id: nil)
        let model = KMRecordsModel(); await model.configure(repo); await model.open(transfer)
        model.draft?.amount = "2000"; await model.save()
        #expect(model.error == nil && model.selected?.amountYen == -2000)
        let audit = await model.remove(); #expect(model.error == nil && audit?.transactions.count == 2)
        let notice = KMDeletionNoticeModel(); await notice.configure(repo)
        #expect(await notice.undo()); #expect(model.error == nil)
        #expect(try await repo.transactions.transaction(id: transfer.id)?.amountYen == -2000)
    }

    @Test func initialSearchOpensSearchPageWithMonthAndCategoryFilter() async throws {
        let store = KMInMemoryStore(transactions: [
            KMTransaction(id: "oct-food-1", date: KMDate(rawValue: "2026-10-01"), amountYen: -800, kind: .expense,
                          payeeName: "合成スーパー", categoryName: "食費", accountId: "cash", categoryId: "food"),
            KMTransaction(id: "oct-food-2", date: KMDate(rawValue: "2026-10-31"), amountYen: -1_200, kind: .expense,
                          payeeName: "合成ベーカリー", categoryName: "食費", accountId: "cash", categoryId: "food"),
            KMTransaction(id: "oct-daily", date: KMDate(rawValue: "2026-10-15"), amountYen: -500, kind: .expense,
                          payeeName: "合成ドラッグ", categoryName: "日用品", accountId: "cash", categoryId: "daily"),
            KMTransaction(id: "sep-food", date: KMDate(rawValue: "2026-09-30"), amountYen: -900, kind: .expense,
                          payeeName: "先月スーパー", categoryName: "食費", accountId: "cash", categoryId: "food"),
            KMTransaction(id: "nov-food", date: KMDate(rawValue: "2026-11-01"), amountYen: -700, kind: .expense,
                          payeeName: "翌月スーパー", categoryName: "食費", accountId: "cash", categoryId: "food"),
        ], accounts: [.init(id: "cash", name: "合成現金")],
           categories: [.init(id: "food", name: "食費"), .init(id: "daily", name: "日用品")])
        let repo = KMRepositories(inMemory: store, referenceDate: Date(timeIntervalSince1970: 1_790_000_000))

        let initial = KMRecordsSearchDraft.forCategory("food", in: KMYearMonth(rawValue: "2026-10"))
        let model = KMRecordsModel(initialSearch: initial)
        await model.configure(repo)

        #expect(model.page == .search)
        #expect(model.searchOrigin)
        #expect(model.appliedSearch == initial)
        #expect(model.search == initial)
        #expect(model.searchRows.map(\.id) == ["oct-food-2", "oct-food-1"])
        #expect(model.searchTotal == -2_000)

        let defaultModel = KMRecordsModel()
        await defaultModel.configure(repo)
        #expect(defaultModel.page == .list)
        #expect(!defaultModel.searchOrigin)
        #expect(defaultModel.appliedSearch == KMRecordsSearchDraft())
    }

    @Test func searchConditionChangesApplyImmediatelyWithoutExplicitSubmit() async throws {
        let store = KMInMemoryStore(transactions: [
            KMTransaction(id: "sep-food", date: KMDate(rawValue: "2026-09-30"), amountYen: -900, kind: .expense,
                          payeeName: "先月スーパー", categoryName: "食費", accountId: "cash", categoryId: "food"),
            KMTransaction(id: "oct-food-1", date: KMDate(rawValue: "2026-10-05"), amountYen: -800, kind: .expense,
                          payeeName: "合成スーパー", categoryName: "食費", accountId: "cash", categoryId: "food"),
            KMTransaction(id: "oct-food-2", date: KMDate(rawValue: "2026-10-25"), amountYen: -1_200, kind: .expense,
                          payeeName: "合成ベーカリー", categoryName: "食費", accountId: "cash", categoryId: "food"),
            KMTransaction(id: "oct-daily", date: KMDate(rawValue: "2026-10-10"), amountYen: -500, kind: .expense,
                          payeeName: "合成ドラッグ", categoryName: "日用品", accountId: "cash", categoryId: "daily"),
            KMTransaction(id: "oct-salary", date: KMDate(rawValue: "2026-10-20"), amountYen: 200_000, kind: .income,
                          payeeName: "合成給与", categoryName: "給与", accountId: "bank", categoryId: "salary"),
        ], accounts: [.init(id: "cash", name: "合成現金"), .init(id: "bank", name: "合成銀行")],
           categories: [.init(id: "food", name: "食費"), .init(id: "daily", name: "日用品"), .init(id: "salary", name: "給与")])
        let repo = KMRepositories(inMemory: store, referenceDate: Date(timeIntervalSince1970: 1_790_000_000))

        let model = KMRecordsModel()
        await model.configure(repo)
        await model.showSearch()
        #expect(model.searchRows.count == 5)

        // Category change updates results without calling performSearch().
        model.search.categoryId = "food"
        await model.waitForPendingSearch()
        #expect(model.error == nil)
        #expect(model.appliedSearch.categoryId == "food")
        #expect(model.searchRows.map(\.id) == ["oct-food-2", "oct-food-1", "sep-food"])
        #expect(model.searchTotal == -2_900)

        // Period with both startDate and endDate updates results live.
        var ranged = model.search
        ranged.setStartDate("2026-10-01")
        ranged.setEndDate("2026-10-15")
        model.search = ranged
        await model.waitForPendingSearch()
        #expect(model.error == nil)
        #expect(model.appliedSearch.startDate == "2026-10-01")
        #expect(model.appliedSearch.endDate == "2026-10-15")
        #expect(model.searchRows.map(\.id) == ["oct-food-1"])
        #expect(model.searchTotal == -800)

        // Setting endDate before startDate aligns startDate instead of producing an invalid/empty search.
        model.search.setEndDate("2026-09-30")
        await model.waitForPendingSearch()
        #expect(model.error == nil)
        #expect(model.search.startDate == "2026-09-30" && model.search.endDate == "2026-09-30")
        #expect(model.searchRows.map(\.id) == ["sep-food"])

        // Kind change updates results live as well.
        var incomeDraft = KMRecordsSearchDraft()
        incomeDraft.kind = "income"
        model.search = incomeDraft
        await model.waitForPendingSearch()
        #expect(model.error == nil)
        #expect(model.searchRows.map(\.id) == ["oct-salary"])
        #expect(model.searchTotal == 200_000)
    }
}
