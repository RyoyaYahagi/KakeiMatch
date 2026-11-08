import Foundation
import Observation

/// Drives the Muse snapshot export screen. Household data is read only through
/// `KMMuseSnapshotBuilder`; the model never calls a repository write operation and never
/// reads the exported file back into the app.
@MainActor @Observable
final class KMMuseExportModel {
    private(set) var fromMonth: KMYearMonth
    private(set) var toMonth: KMYearMonth
    let currentMonth: KMYearMonth

    private(set) var isWorking = false
    private(set) var exportedFileURL: URL?
    private(set) var status: String?
    private(set) var isFailure = false

    private let now: () -> Date
    private let appVersion: () -> String?
    private let directory: URL
    /// Kept after the visible result is cleared so a later export can remove the old temp file.
    private var lastExportURL: URL?

    init(today: Date = Date(), now: @escaping () -> Date = { Date() },
         appVersion: @escaping () -> String? = { KMMuseExportPresentation.appVersion() },
         directory: URL = KMMuseExportPresentation.exportDirectory) {
        let range = KMMuseExportPresentation.defaultRange(today: today)
        fromMonth = range.from
        toMonth = range.to
        currentMonth = KMDate(instant: today).yearMonth
        self.now = now
        self.appVersion = appVersion
        self.directory = directory
    }

    var monthOptions: [KMYearMonth] { KMMuseExportPresentation.monthOptions(currentMonth: currentMonth) }
    var rangeError: String? {
        KMMuseExportPresentation.validationMessage(from: fromMonth, to: toMonth, currentMonth: currentMonth)
    }
    var canExport: Bool { rangeError == nil && !isWorking }
    var rangeSummary: String { KMMuseExportPresentation.rangeSummary(from: fromMonth, to: toMonth) }

    func setFromMonth(_ month: KMYearMonth) {
        guard month != fromMonth else { return }
        fromMonth = month
        resetOutput()
    }

    func setToMonth(_ month: KMYearMonth) {
        guard month != toMonth else { return }
        toMonth = month
        resetOutput()
    }

    func export(_ repositories: KMRepositories?) async {
        guard !isWorking else { return }
        if let rangeError {
            exportedFileURL = nil
            status = rangeError
            isFailure = true
            return
        }
        guard let repositories else {
            exportedFileURL = nil
            status = KMMuseExportPresentation.storeUnavailable
            isFailure = true
            return
        }

        isWorking = true
        status = KMMuseExportPresentation.processing
        isFailure = false
        defer { isWorking = false }

        let instant = now()
        do {
            removePreviousExport()
            let builder = KMMuseSnapshotBuilder(
                transactions: repositories.transactions,
                accounts: repositories.accounts,
                categories: repositories.categories)
            let snapshot = try await builder.build(
                fromMonth: fromMonth, toMonth: toMonth, generatedAt: instant, appVersion: appVersion())
            let data = try snapshot.jsonData()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(KMMuseExportPresentation.fileName(now: instant))
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
            try data.write(to: url, options: .atomic)
            exportedFileURL = url
            lastExportURL = url
            status = KMMuseExportPresentation.exported
            isFailure = false
        } catch {
            exportedFileURL = nil
            status = KMMuseExportPresentation.failure(error)
            isFailure = true
        }
    }

    private func resetOutput() {
        exportedFileURL = nil
        status = nil
        isFailure = false
    }

    /// Only the file this model created is removed; the previous result is never shared after
    /// a new export starts.
    private func removePreviousExport() {
        guard let previous = lastExportURL ?? exportedFileURL else { return }
        try? FileManager.default.removeItem(at: previous)
        lastExportURL = nil
        exportedFileURL = nil
    }
}
