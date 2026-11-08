import Foundation
import Observation

/// Drives the Muse snapshot export screen. Household data is read only through
/// `KMMuseSnapshotBuilder`; the model never calls a repository write operation and never
/// reads the exported file back into the app.
@MainActor @Observable
final class KMMuseExportModel {
    /// The Asia/Tokyo month the screen treats as "this month". It is stored instead of computed so
    /// Observation redraws the pickers when it changes; `refreshCurrentMonth()` moves it.
    private(set) var currentMonth: KMYearMonth
    private(set) var fromMonth: KMYearMonth
    private(set) var toMonth: KMYearMonth

    private(set) var isWorking = false
    private(set) var exportedFileURL: URL?
    private(set) var status: String?
    private(set) var isFailure = false
    /// Cleanup failures stay visible separately from the export result, because a new export can
    /// succeed while an older plain-text file remains on disk.
    private(set) var cleanupError: String?

    private let now: () -> Date
    private let appVersion: () -> String?
    private let directory: URL
    private let removeItem: (URL) throws -> Void

    init(now: @escaping () -> Date = { Date() },
         appVersion: @escaping () -> String? = { KMMuseExportPresentation.appVersion() },
         directory: URL = KMMuseExportPresentation.exportDirectory,
         removeItem: @escaping (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) }) {
        let today = now()
        currentMonth = KMDate(instant: today).yearMonth
        let range = KMMuseExportPresentation.defaultRange(today: today)
        fromMonth = range.from
        toMonth = range.to
        self.now = now
        self.appVersion = appVersion
        self.directory = directory
        self.removeItem = removeItem
    }

    /// Re-reads "this month" from the injected clock. The screen calls this when it appears, when
    /// the app becomes active again, and when the calendar day changes, so a screen left open across
    /// a month or year boundary stops offering the previous month's limit. A range that ends after
    /// the new current month is clamped exactly like the pre-export refresh in `export`.
    func refreshCurrentMonth() {
        let month = KMDate(instant: now()).yearMonth
        guard month != currentMonth else { return }
        currentMonth = month
        guard toMonth > currentMonth else { return }
        toMonth = currentMonth
        if fromMonth > toMonth { fromMonth = toMonth }
        resetOutput()
    }

    var selectableYears: [Int] { KMMuseExportPresentation.selectableYears(currentMonth: currentMonth) }
    var rangeError: String? {
        KMMuseExportPresentation.validationMessage(from: fromMonth, to: toMonth, currentMonth: currentMonth)
    }
    var canExport: Bool { rangeError == nil && !isWorking }
    /// False while an export is running: the previous file may still be open in the share sheet or
    /// a save dialog, and a new export will replace what the screen offers.
    var canShare: Bool { exportedFileURL != nil && !isWorking }
    var rangeSummary: String { KMMuseExportPresentation.rangeSummary(from: fromMonth, to: toMonth) }

    func selectableMonths(for year: Int) -> [Int] {
        let last = max(1, KMMuseExportPresentation.lastSelectableMonth(year: year, currentMonth: currentMonth))
        return Array(1...last)
    }

    /// Removes snapshots left by an earlier screen or app launch that are old enough to no longer be
    /// in use. The file this model can still share is kept regardless of its age.
    func prepare() {
        cleanupError = removeStaleExports(keeping: exportedFileURL)
    }

    func setFromMonth(_ month: KMYearMonth) {
        guard !isWorking, month != fromMonth else { return }
        fromMonth = month
        resetOutput()
    }

    func setToMonth(_ month: KMYearMonth) {
        guard !isWorking, month != toMonth else { return }
        toMonth = month
        resetOutput()
    }

    func setFromYear(_ year: Int) {
        guard !isWorking else { return }
        let month = min(fromMonth.month, max(1, KMMuseExportPresentation.lastSelectableMonth(
            year: year, currentMonth: currentMonth)))
        setFromMonth(KMYearMonth(year: year, month: month))
    }

    func setFromMonthNumber(_ month: Int) {
        guard !isWorking else { return }
        let last = max(1, KMMuseExportPresentation.lastSelectableMonth(
            year: fromMonth.year, currentMonth: currentMonth))
        setFromMonth(KMYearMonth(year: fromMonth.year, month: min(max(month, 1), last)))
    }

    func setToYear(_ year: Int) {
        guard !isWorking else { return }
        let month = min(toMonth.month, max(1, KMMuseExportPresentation.lastSelectableMonth(
            year: year, currentMonth: currentMonth)))
        setToMonth(KMYearMonth(year: year, month: month))
    }

    func setToMonthNumber(_ month: Int) {
        guard !isWorking else { return }
        let last = max(1, KMMuseExportPresentation.lastSelectableMonth(
            year: toMonth.year, currentMonth: currentMonth))
        setToMonth(KMYearMonth(year: toMonth.year, month: min(max(month, 1), last)))
    }

    func export(_ repositories: KMRepositories?) async {
        guard !isWorking else { return }
        refreshCurrentMonth()
        if let rangeError {
            status = rangeError
            isFailure = true
            return
        }
        guard let repositories else {
            status = KMMuseExportPresentation.storeUnavailable
            isFailure = true
            return
        }

        isWorking = true
        status = KMMuseExportPresentation.processing
        isFailure = false
        defer { isWorking = false }

        let selectedFrom = fromMonth
        let selectedTo = toMonth
        let instant = now()

        // A cleanup failure only leaves an older plain-text file behind. The new export is still
        // what the user asked for, and blocking here would neither remove the old file nor give
        // them fresh data, so report the Japanese reason and continue.
        cleanupError = removeStaleExports(keeping: exportedFileURL)

        do {
            let builder = KMMuseSnapshotBuilder(
                transactions: repositories.transactions,
                accounts: repositories.accounts,
                categories: repositories.categories)
            let snapshot = try await builder.build(
                fromMonth: selectedFrom, toMonth: selectedTo, generatedAt: instant, appVersion: appVersion())
            let data = try snapshot.jsonData()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = try newFileURL(for: instant)
            // The snapshot contains payee names and memos in plain text. `.kmib` backups currently
            // use `.atomic` only; this file tightens that with complete protection while it sits in
            // the temporary directory, and the share sheet reads it while the app is foregrounded.
            try data.write(to: url, options: [.atomic, .completeFileProtection])

            // The pickers are disabled while working and the setters ignore changes, so this is a
            // defensive check against any state changed outside the screen. Never publish a file
            // whose range differs from what the screen says.
            guard fromMonth == selectedFrom, toMonth == selectedTo,
                  snapshot.range.fromMonth == selectedFrom.rawValue,
                  snapshot.range.toMonth == selectedTo.rawValue else {
                do { try removeItem(url) } catch {
                    cleanupError = KMMuseExportPresentation.cleanupFailureMessage(error)
                }
                status = KMMuseExportPresentation.rangeChanged
                isFailure = true
                return
            }

            exportedFileURL = url
            cleanupError = removeStaleExports(keeping: url)
            status = KMMuseExportPresentation.exported
            isFailure = false
        } catch {
            status = KMMuseExportPresentation.failure(error)
            isFailure = true
        }
    }

    private func resetOutput() {
        exportedFileURL = nil
        status = nil
        isFailure = false
    }

    /// Returns a Japanese reason when at least one stale snapshot could not be deleted.
    private func removeStaleExports(keeping keep: URL?) -> String? {
        let keepURL = keep?.standardizedFileURL
        do {
            guard FileManager.default.fileExists(atPath: directory.path) else { return nil }
            let urls = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            var firstError: Error?
            for url in urls where isSnapshotFile(url) {
                guard url.standardizedFileURL != keepURL else { continue }
                guard isOldEnoughToDelete(url) else { continue }
                do { try removeItem(url) } catch { firstError = firstError ?? error }
            }
            return firstError.map { KMMuseExportPresentation.cleanupFailureMessage($0) }
        } catch {
            return KMMuseExportPresentation.cleanupFailureMessage(error)
        }
    }

    /// A snapshot becomes stale ten minutes after it was written. That is long enough for the user
    /// to finish sharing or saving the file, and short enough that plain-text household data does
    /// not stay in the temporary directory for the rest of the day. The timestamp comes from the
    /// injected clock so tests can move past it.
    private static let staleExportLifetime: TimeInterval = 10 * 60

    private func isOldEnoughToDelete(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
              let modified = values.contentModificationDate else {
            // Without a timestamp it is not safe to assume the file is old; the share sheet may
            // still be reading it.
            return false
        }
        return now().timeIntervalSince(modified) >= Self.staleExportLifetime
    }

    private func isSnapshotFile(_ url: URL) -> Bool {
        url.lastPathComponent.hasPrefix("kakeimatch-snapshot-") && url.pathExtension == "json"
    }

    /// The generated name has one-second resolution. If that name is the file currently being
    /// shared, or a file too new to be treated as stale, keep it alive and add a suffix instead of
    /// replacing it in place. Only a snapshot older than the stale lifetime is overwritten.
    private func newFileURL(for instant: Date) throws -> URL {
        let name = KMMuseExportPresentation.fileName(now: instant)
        let stem = String(name.dropLast(".json".count))
        var url = directory.appendingPathComponent(name)
        var suffix = 2
        while FileManager.default.fileExists(atPath: url.path) {
            if url.standardizedFileURL == exportedFileURL?.standardizedFileURL || !isOldEnoughToDelete(url) {
                url = directory.appendingPathComponent("\(stem)-\(suffix).json")
                suffix += 1
            } else {
                try removeItem(url)
            }
        }
        return url
    }
}

private extension KMYearMonth {
    init(year: Int, month: Int) {
        self.init(rawValue: String(format: "%04d-%02d", year, month))
    }
}
