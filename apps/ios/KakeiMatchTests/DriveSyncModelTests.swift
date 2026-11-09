import Foundation
import Testing
@testable import KakeiMatch

@MainActor
private final class DriveSyncLinkStub: KMDriveLinking {
    var isSignedIn: Bool
    var hasDriveScope: Bool
    var accountID: String?
    var accountEmail: String?
    var nextSignInAccountID = "synthetic-b"
    var signInResult = true
    var signInError: (any Error)?
    private(set) var restoreCount = 0
    private(set) var signInCount = 0
    private(set) var signOutCount = 0

    init(signedIn: Bool = true, hasScope: Bool = true) {
        isSignedIn = signedIn
        hasDriveScope = hasScope
        accountID = signedIn ? "synthetic-a" : nil
        accountEmail = signedIn ? "synthetic@example.test" : nil
    }

    func restoreIfNeeded() async { restoreCount += 1 }

    func signIn() async throws -> Bool {
        signInCount += 1
        if let signInError { throw signInError }
        guard signInResult else { return false }
        isSignedIn = true
        hasDriveScope = true
        accountID = nextSignInAccountID
        accountEmail = "synthetic@example.test"
        return true
    }

    func signOut() {
        signOutCount += 1
        isSignedIn = false
        hasDriveScope = false
        accountID = nil
        accountEmail = nil
    }

    func accessToken(forceRefresh: Bool) async throws -> String {
        guard isSignedIn else { throw KMDriveUploadError.notSignedIn }
        return forceRefresh ? "synthetic-forced-token" : "synthetic-token"
    }
}

@MainActor
private final class DriveSyncWriterSpy: KMDriveSnapshotWriting {
    private(set) var uploads: [Data] = []
    var error: (any Error)?
    var beforeUpload: (@MainActor () async -> Void)?
    var ignoresCancellation = false

    func upload(data: Data, cancellation: KMDriveUploadCancellation) async throws {
        if let beforeUpload { await beforeUpload() }
        if !ignoresCancellation, cancellation.isCancelled { throw KMDriveUploadError.cancelled }
        if let error { throw error }
        uploads.append(data)
    }
}

@MainActor
private final class DriveSyncUploadGate {
    private var started: CheckedContinuation<Void, Never>?
    private var release: CheckedContinuation<Void, Never>?
    private var hasStarted = false

    func wait() async {
        hasStarted = true
        started?.resume()
        started = nil
        await withCheckedContinuation { release = $0 }
    }

    func waitUntilStarted() async {
        if hasStarted { return }
        await withCheckedContinuation { started = $0 }
    }

    func open() {
        release?.resume()
        release = nil
    }
}

/// Delegates the three reads the snapshot builder uses and records each one, so
/// a test can prove that an OFF toggle never reaches the household.
@MainActor
private final class DriveSyncCountingStore: TransactionRepository, AccountRepository, CategoryRepository {
    private let base: KMInMemoryStore
    private(set) var transactionReads = 0
    private(set) var homeReads = 0
    private(set) var accountReads = 0
    private(set) var categoryReads = 0
    private(set) var lastQuery: KMTransactionQuery?
    private(set) var homeMonths: [KMYearMonth] = []

    init(base: KMInMemoryStore) { self.base = base }

    func transactions(matching query: KMTransactionQuery) async throws -> [KMTransaction] {
        transactionReads += 1
        lastQuery = query
        return try await base.transactions(matching: query)
    }
    func transaction(id: String) async throws -> KMTransaction? { try await base.transaction(id: id) }
    func recordDays(matching query: KMTransactionQuery) async throws -> [KMRecordDay] {
        try await base.recordDays(matching: query)
    }
    func home(month: KMYearMonth) async throws -> KMHomeSnapshot {
        homeReads += 1
        homeMonths.append(month)
        return try await base.home(month: month)
    }
    func homeDashboard(month: KMYearMonth, today: KMDate) async throws -> KMHomeDashboard {
        try await base.homeDashboard(month: month, today: today)
    }
    func saveManual(_ input: KMManualTransactionInput, id: String?) async throws -> KMTransaction {
        throw KMDataError.invalidData("unexpected write")
    }
    func saveTransfer(_ input: KMTransferInput, id: String?) async throws -> KMTransaction {
        throw KMDataError.invalidData("unexpected write")
    }
    func importExternalTransaction(_ input: KMExternalTransactionInput) async throws -> KMExternalTransactionResult {
        throw KMDataError.invalidData("unexpected write")
    }
    func setSpendingExclusion(id: String, excluded: Bool) async throws {
        throw KMDataError.invalidData("unexpected write")
    }
    func deleteTransaction(id: String) async throws { throw KMDataError.invalidData("unexpected write") }
    func deleteTransaction(id: String, expected: [KMTransaction]?, at timestamp: Date) async throws -> KMTransactionDeletion {
        throw KMDataError.invalidData("unexpected write")
    }
    func transactionDeletions() async throws -> [KMTransactionDeletion] {
        throw KMDataError.invalidData("unexpected write")
    }
    func undoTransactionDeletion(id: String, at timestamp: Date) async throws {
        throw KMDataError.invalidData("unexpected write")
    }

    func accounts(includeClosed: Bool) async throws -> [KMAccount] {
        accountReads += 1
        return try await base.accounts(includeClosed: includeClosed)
    }
    func accounts(asOf date: KMDate, includeClosed: Bool) async throws -> [KMAccount] {
        accountReads += 1
        return try await base.accounts(asOf: date, includeClosed: includeClosed)
    }
    func createAccount(_ account: KMAccount, startingBalanceYen: Int, startingDate: KMDate) async throws {
        throw KMDataError.invalidData("unexpected write")
    }
    func saveAccount(_ account: KMAccount) async throws { throw KMDataError.invalidData("unexpected write") }
    func deleteAccount(id: String) async throws { throw KMDataError.invalidData("unexpected write") }

    func categories(includeHidden: Bool) async throws -> [KMCategory] {
        categoryReads += 1
        return try await base.categories(includeHidden: includeHidden)
    }
    func categoryGroups() async throws -> [KMCategoryGroup] { try await base.categoryGroups() }
    func saveCategory(_ category: KMCategory) async throws { throw KMDataError.invalidData("unexpected write") }
    func deleteCategory(id: String) async throws { throw KMDataError.invalidData("unexpected write") }
    func saveCategoryGroup(_ group: KMCategoryGroup) async throws {
        throw KMDataError.invalidData("unexpected write")
    }
    func deleteCategoryGroup(id: String) async throws { throw KMDataError.invalidData("unexpected write") }
    func reorderCategoryGroups(ids: [String]) async throws { throw KMDataError.invalidData("unexpected write") }
    func reorderCategories(groupId: String, ids: [String]) async throws {
        throw KMDataError.invalidData("unexpected write")
    }
}

@MainActor
struct DriveSyncModelTests {
    private func instant(_ value: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return try #require(formatter.date(from: value))
    }

    private func makeBase() -> KMInMemoryStore {
        KMInMemoryStore(
            transactions: [
                KMTransaction(id: "tx-drive-1", date: KMDate(rawValue: "2026-10-05"), amountYen: -1280,
                    kind: .expense, payeeName: "合成ベーカリー", categoryName: "食費", accountId: "acc-drive",
                    excludedFromSpending: false, categoryId: "cat-drive-food", memo: "合成メモ"),
                KMTransaction(id: "tx-drive-2", date: KMDate(rawValue: "2026-09-20"), amountYen: 250000,
                    kind: .income, payeeName: "合成株式会社", categoryName: "給与", accountId: "acc-drive",
                    excludedFromSpending: false, categoryId: "cat-drive-salary"),
            ],
            accounts: [
                KMAccount(id: "acc-drive", name: "合成銀行", accountType: .bank, balanceYen: 248720),
            ],
            categories: [
                KMCategory(id: "cat-drive-food", name: "食費"),
                KMCategory(id: "cat-drive-salary", name: "給与", isIncome: true),
            ])
    }

    private func repositories(transactions: any TransactionRepository, accounts: any AccountRepository,
                              categories: any CategoryRepository, base: KMInMemoryStore) -> KMRepositories {
        KMRepositories(transactions: transactions, accounts: accounts, categories: categories,
            payees: base, receipts: base, statements: base, reconciliation: base, budgets: base,
            recurring: base, payroll: base, categoryLearning: base, settings: base)
    }

    private func preferences() throws -> (KMDriveSyncPreferences, UserDefaults, String) {
        let name = "DriveSyncModelTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defaults.removePersistentDomain(forName: name)
        return (KMDriveSyncPreferences(defaults: defaults), defaults, name)
    }

    private func expectedFingerprint(_ repositories: KMRepositories, today: Date,
                                     appVersion: String? = nil) async throws -> String {
        let range = KMMuseExportPresentation.defaultRange(today: today)
        let builder = KMMuseSnapshotBuilder(
            transactions: repositories.transactions,
            accounts: repositories.accounts,
            categories: repositories.categories)
        let snapshot = try await builder.build(
            fromMonth: range.from, toMonth: range.to,
            generatedAt: today.addingTimeInterval(-3_600), appVersion: appVersion)
        return try KMDriveSnapshotFingerprint.compute(snapshot)
    }

    @Test func offDoesNotReadRepositoriesOrCallTheWriter() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub()
        let writer = DriveSyncWriterSpy()
        let now = try instant("2026-11-15T03:00:00Z")
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { now }, appVersion: { nil })

        await model.syncIfNeeded(repositories: repositories)

        #expect(counting.transactionReads == 0)
        #expect(counting.homeReads == 0)
        #expect(counting.accountReads == 0)
        #expect(counting.categoryReads == 0)
        #expect(writer.uploads.isEmpty)
        #expect(link.restoreCount == 0)
        #expect(model.failureMessage == nil)
    }

    @Test func signedOutOrMissingScopeStopsBeforeBuilding() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        prefs.isEnabled = true
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub(signedIn: false)
        let writer = DriveSyncWriterSpy()
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { Date() }, appVersion: { nil })

        await model.syncIfNeeded(repositories: repositories)

        #expect(counting.transactionReads == 0)
        #expect(writer.uploads.isEmpty)
        #expect(model.failureMessage == KMDriveSyncPresentation.notSignedIn)

        link.isSignedIn = true
        link.hasDriveScope = false
        await model.syncIfNeeded(repositories: repositories)
        #expect(counting.transactionReads == 0)
        #expect(model.failureMessage == KMDriveSyncPresentation.missingScope)
    }

    @Test func aSecondCallWhileSendingIsIgnored() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        prefs.isEnabled = true
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub()
        let writer = DriveSyncWriterSpy()
        let gate = DriveSyncUploadGate()
        writer.beforeUpload = { await gate.wait() }
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { Date() }, appVersion: { nil })

        let first = Task { await model.syncNow(repositories: repositories) }
        await gate.waitUntilStarted()
        #expect(model.isSyncing)
        await model.syncNow(repositories: repositories)
        gate.open()
        await first.value

        #expect(writer.uploads.count == 1)
        #expect(counting.transactionReads == 1)
        #expect(!model.isSyncing)
    }

    @Test func failureDoesNotAdvanceTheFingerprint() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        prefs.isEnabled = true
        let oldDate = try instant("2026-11-01T00:00:00Z")
        prefs.lastSentAt = oldDate
        prefs.lastFingerprint = "previous"
        prefs.lastAccountID = "synthetic-a"
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub()
        let writer = DriveSyncWriterSpy()
        writer.error = KMDriveUploadError.server(status: 503, message: "unavailable")
        let today = try instant("2026-11-15T03:00:00Z")
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { today }, appVersion: { nil })

        await model.syncNow(repositories: repositories)

        #expect(prefs.lastFingerprint == "previous")
        #expect(prefs.lastSentAt == oldDate)
        #expect(model.failureMessage?.contains("503") == true)
        #expect(model.isFailureStatus)
        #expect(model.lastSentAt == oldDate)
    }

    @Test func successStoresLastSentAtAndFingerprint() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        prefs.isEnabled = true
        let today = try instant("2026-11-15T03:00:00Z")
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub()
        let writer = DriveSyncWriterSpy()
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { today }, appVersion: { nil })

        let expected = try await expectedFingerprint(repositories, today: today)
        await model.syncIfNeeded(repositories: repositories)

        #expect(writer.uploads.count == 1)
        #expect(prefs.lastSentAt == today)
        #expect(prefs.lastFingerprint == expected)
        #expect(model.lastSentAt == today)
        #expect(model.failureMessage == nil)
        #expect(model.statusText == "最後に保存: 2026年11月15日 12:00")
    }

    @Test func automaticSyncSkipsUnchangedContentButManualSendDoesNot() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        prefs.isEnabled = true
        let today = try instant("2026-11-15T03:00:00Z")
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub()
        let writer = DriveSyncWriterSpy()
        let expected = try await expectedFingerprint(repositories, today: today)
        prefs.lastFingerprint = expected
        prefs.lastAccountID = "synthetic-a"
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { today }, appVersion: { nil })

        await model.syncIfNeeded(repositories: repositories)
        #expect(writer.uploads.isEmpty)

        await model.syncNow(repositories: repositories)
        #expect(writer.uploads.count == 1)
    }

    @Test func usesTheDefaultRangeAndBuildsInMemory() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        prefs.isEnabled = true
        let today = try instant("2026-11-15T03:00:00Z")
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub()
        let writer = DriveSyncWriterSpy()
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { today }, appVersion: { "0.1.0 (1)" })

        await model.syncNow(repositories: repositories)

        let data = try #require(writer.uploads.first)
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let range = try #require(json["range"] as? [String: Any])
        #expect(range["fromMonth"] as? String == "2026-09")
        #expect(range["toMonth"] as? String == "2026-11")
        let months = (json["monthly"] as? [[String: Any]])?.compactMap { $0["month"] as? String }
        #expect(months == ["2026-09", "2026-10", "2026-11"])
        let expectedMonths = [
            try KMYearMonth("2026-09"), try KMYearMonth("2026-10"), try KMYearMonth("2026-11"),
        ]
        #expect(counting.homeMonths == expectedMonths)
        let query = try #require(counting.lastQuery)
        #expect(query.startDate == (try KMYearMonth("2026-09")).firstDay)
        #expect(query.endDate == (try KMYearMonth("2026-11")).lastDay)
        #expect(json["generatedAt"] as? String == "2026-11-15T12:00:00+09:00")
    }

    @Test func manualSendWorksWhileAutoSaveIsOff() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub()
        let writer = DriveSyncWriterSpy()
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { Date() }, appVersion: { nil })

        await model.syncIfNeeded(repositories: repositories)
        #expect(writer.uploads.isEmpty)

        await model.syncNow(repositories: repositories)
        #expect(writer.uploads.count == 1)
        #expect(prefs.isEnabled == false)
    }

    @Test func enablingSignsInOnlyWhenNeededAndKeepsOffOnCancel() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        let link = DriveSyncLinkStub(signedIn: false)
        let model = KMDriveSyncModel(linker: link, writer: DriveSyncWriterSpy(), preferences: prefs,
                                     now: { Date() }, appVersion: { nil })

        link.signInResult = false
        await model.setEnabled(true)
        #expect(link.signInCount == 1)
        #expect(!model.isEnabled)
        #expect(!prefs.isEnabled)
        #expect(model.failureMessage == nil)

        link.signInResult = true
        await model.setEnabled(true)
        #expect(model.isEnabled)
        #expect(prefs.isEnabled)
        #expect(model.isSignedIn)
        #expect(model.hasDriveScope)

        await model.setEnabled(false)
        #expect(!model.isEnabled)
        #expect(!prefs.isEnabled)
    }

    @Test func enablingWithAMissingScopeStaysOff() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        let link = DriveSyncLinkStub(signedIn: true, hasScope: false)
        let model = KMDriveSyncModel(linker: link, writer: DriveSyncWriterSpy(), preferences: prefs,
                                     now: { Date() }, appVersion: { nil })

        await model.setEnabled(true)

        #expect(!model.isEnabled)
        #expect(!prefs.isEnabled)
        #expect(model.failureMessage == KMDriveSyncPresentation.missingScope)
    }

    @Test func prepareRestoresSignInEvenWhenAutoSaveIsOff() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        let link = DriveSyncLinkStub(signedIn: false)
        let model = KMDriveSyncModel(linker: link, writer: DriveSyncWriterSpy(), preferences: prefs,
                                     now: { Date() }, appVersion: { nil })

        await model.prepare()

        #expect(link.restoreCount == 1)
        #expect(model.isEnabled == false)
    }

    @Test func signOutClearsTheConnectionButKeepsTheToggle() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        prefs.isEnabled = true
        let link = DriveSyncLinkStub(signedIn: true)
        let model = KMDriveSyncModel(linker: link, writer: DriveSyncWriterSpy(), preferences: prefs,
                                     now: { Date() }, appVersion: { nil })

        model.signOut()

        #expect(!model.isSignedIn)
        #expect(model.accountEmail == nil)
        #expect(model.isEnabled)
        #expect(link.signOutCount == 1)
        #expect(!model.canSendNow)
    }

    @Test func switchingAccountsDoesNotSkipTheNewAccountsFirstAutomaticUpload() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        prefs.isEnabled = true
        let today = try instant("2026-11-15T03:00:00Z")
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub(signedIn: true)
        link.accountID = "account-a"
        let writer = DriveSyncWriterSpy()
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { today }, appVersion: { nil })

        await model.syncIfNeeded(repositories: repositories)
        #expect(writer.uploads.count == 1)
        #expect(prefs.lastAccountID == "account-a")
        #expect(model.lastSentAt == today)

        // A's history must not make B's first automatic upload look unchanged.
        model.signOut()
        #expect(model.lastSentAt == nil)
        link.nextSignInAccountID = "account-b"
        await model.signIn()
        #expect(link.accountID == "account-b")
        #expect(prefs.lastAccountID == nil)
        #expect(model.lastSentAt == nil)

        await model.syncIfNeeded(repositories: repositories)
        #expect(writer.uploads.count == 2)
        #expect(prefs.lastAccountID == "account-b")
        #expect(model.lastSentAt == today)
    }

    @Test func signingBackIntoTheSameAccountKeepsItsUploadHistory() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        prefs.isEnabled = true
        let today = try instant("2026-11-15T03:00:00Z")
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub(signedIn: true)
        link.accountID = "account-a"
        let writer = DriveSyncWriterSpy()
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { today }, appVersion: { nil })

        await model.syncIfNeeded(repositories: repositories)
        #expect(writer.uploads.count == 1)

        model.signOut()
        link.nextSignInAccountID = "account-a"
        await model.signIn()
        #expect(prefs.lastAccountID == "account-a")
        #expect(model.lastSentAt == today)

        await model.syncIfNeeded(repositories: repositories)
        #expect(writer.uploads.count == 1, "同じアカウントで内容が同じなら再送しない")
    }

    @Test func turningOffWhileTheUploadIsWaitingStopsItAndPersistsOff() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        prefs.isEnabled = true
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub(signedIn: true)
        let writer = DriveSyncWriterSpy()
        let gate = DriveSyncUploadGate()
        writer.beforeUpload = { await gate.wait() }
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { Date() }, appVersion: { nil })

        let sync = Task { await model.syncIfNeeded(repositories: repositories) }
        await gate.waitUntilStarted()
        #expect(model.isSyncing)

        await model.setEnabled(false)
        #expect(!model.isEnabled)
        #expect(!prefs.isEnabled)

        gate.open()
        await sync.value

        #expect(writer.uploads.isEmpty)
        #expect(prefs.lastFingerprint == nil)
        #expect(prefs.lastSentAt == nil)
        #expect(model.lastSentAt == nil)
        #expect(model.failureMessage == nil)
        #expect(!model.isSyncing)
    }

    @Test func signingOutWhileTheUploadIsWaitingStopsItAndDoesNotSaveSuccess() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        prefs.isEnabled = true
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub(signedIn: true)
        let writer = DriveSyncWriterSpy()
        let gate = DriveSyncUploadGate()
        writer.beforeUpload = { await gate.wait() }
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { Date() }, appVersion: { nil })

        let sync = Task { await model.syncIfNeeded(repositories: repositories) }
        await gate.waitUntilStarted()
        #expect(model.isSyncing)

        model.signOut()
        #expect(!model.isSignedIn)
        #expect(model.isEnabled)
        #expect(prefs.isEnabled)

        gate.open()
        await sync.value

        #expect(writer.uploads.isEmpty)
        #expect(prefs.lastFingerprint == nil)
        #expect(prefs.lastSentAt == nil)
        #expect(model.lastSentAt == nil)
        #expect(model.failureMessage == nil)
        #expect(!model.isSyncing)
    }

    @Test func signOutAfterTheWriterReturnsDoesNotSaveSuccessState() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        prefs.isEnabled = true
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub(signedIn: true)
        let writer = DriveSyncWriterSpy()
        // Simulate a request that completed before the cancellation was observed.
        writer.ignoresCancellation = true
        let gate = DriveSyncUploadGate()
        writer.beforeUpload = { await gate.wait() }
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { Date() }, appVersion: { nil })

        let sync = Task { await model.syncIfNeeded(repositories: repositories) }
        await gate.waitUntilStarted()
        model.signOut()
        gate.open()
        await sync.value

        #expect(writer.uploads.count == 1)
        #expect(prefs.lastFingerprint == nil)
        #expect(prefs.lastSentAt == nil)
        #expect(model.lastSentAt == nil)
        #expect(model.failureMessage == nil)
    }

    @Test func accountChangeAfterTheWriterReturnsDoesNotSaveSuccessState() async throws {
        let (prefs, defaults, name) = try preferences()
        defer { defaults.removePersistentDomain(forName: name) }
        prefs.isEnabled = true
        let base = makeBase()
        let counting = DriveSyncCountingStore(base: base)
        let repositories = repositories(transactions: counting, accounts: counting,
                                        categories: counting, base: base)
        let link = DriveSyncLinkStub(signedIn: true)
        link.accountID = "account-a"
        let writer = DriveSyncWriterSpy()
        writer.ignoresCancellation = true
        let gate = DriveSyncUploadGate()
        writer.beforeUpload = { await gate.wait() }
        let model = KMDriveSyncModel(linker: link, writer: writer, preferences: prefs,
                                     now: { Date() }, appVersion: { nil })

        let sync = Task { await model.syncIfNeeded(repositories: repositories) }
        await gate.waitUntilStarted()
        link.accountID = "account-b"
        gate.open()
        await sync.value

        #expect(writer.uploads.count == 1)
        #expect(prefs.lastFingerprint == nil)
        #expect(prefs.lastSentAt == nil)
        #expect(model.lastSentAt == nil)
        #expect(model.failureMessage == nil)
    }
}
