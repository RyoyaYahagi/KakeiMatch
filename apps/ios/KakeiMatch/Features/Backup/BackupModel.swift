import Foundation
import Observation

/// Drives the backup/restore screen. All data access goes through the existing
/// `KMSQLiteStore` backup API: exportNativeBackup / importBackup / returnToPreviousProfile.
/// The model never writes household data itself and never bypasses backup validation.
@MainActor @Observable
final class KMBackupModel {
    private(set) var lastExportAt: Date?
    private(set) var canRestorePrevious = false
    private(set) var isLoading = true
    private(set) var isWorking = false
    private(set) var exportedFileURL: URL?
    private(set) var exportStatus: String?
    private(set) var importStatus: String?
    private(set) var previousStatus: String?

    func load(_ repositories: KMRepositories?) async {
        isLoading = true
        defer { isLoading = false }
        guard let repositories else { return }
        do {
            lastExportAt = try await repositories.settings.settings().lastExportAt
            canRestorePrevious = hasPreviousProfile(repositories)
        } catch {
            exportStatus = "保存状況を確認できません。\(error.localizedDescription)"
        }
    }

    func export(_ repositories: KMRepositories?) async {
        guard !isWorking else { return }
        guard let repositories, let store = repositories.localStore else {
            exportStatus = KMBackupPresentation.storeUnavailable
            return
        }
        isWorking = true
        exportStatus = nil
        defer { isWorking = false }
        do {
            let generated = try await store.exportNativeBackup()
            let renamed = generated.deletingLastPathComponent()
                .appendingPathComponent(KMBackupPresentation.exportFileName(now: Date()))
            var output = generated
            if (try? FileManager.default.moveItem(at: generated, to: renamed)) != nil { output = renamed }
            if let previous = exportedFileURL, previous != output { try? FileManager.default.removeItem(at: previous) }
            exportedFileURL = output
            lastExportAt = (try? await repositories.settings.settings())?.lastExportAt ?? Date()
            exportStatus = KMBackupPresentation.exported
        } catch {
            exportStatus = KMBackupPresentation.exportFailure(error)
        }
    }

    /// Restores a picked `.kmib`/`.kmb` file. The store validates the whole file and only
    /// switches the profile pointer after a verified readback; on failure the current
    /// household (and the active pointer) stay exactly as they were.
    @discardableResult
    func restore(from url: URL, repositories: KMRepositories?, confirmed: Bool) async -> Bool {
        guard confirmed else { return false }
        guard !isWorking else { return false }
        guard let repositories, let store = repositories.localStore else {
            importStatus = KMBackupPresentation.storeUnavailable
            return false
        }
        isWorking = true
        importStatus = nil
        defer { isWorking = false }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            try await store.importBackup(from: url)
            lastExportAt = (try? await repositories.settings.settings())?.lastExportAt
            canRestorePrevious = hasPreviousProfile(repositories)
            importStatus = KMBackupPresentation.restored
            return true
        } catch {
            importStatus = KMBackupPresentation.restoreFailure(error)
            return false
        }
    }

    @discardableResult
    func restorePrevious(_ repositories: KMRepositories?) async -> Bool {
        guard !isWorking else { return false }
        guard let repositories, let store = repositories.localStore else {
            previousStatus = KMBackupPresentation.storeUnavailable
            return false
        }
        isWorking = true
        previousStatus = nil
        defer { isWorking = false }
        do {
            try await store.returnToPreviousProfile()
            lastExportAt = (try? await repositories.settings.settings())?.lastExportAt
            canRestorePrevious = hasPreviousProfile(repositories)
            previousStatus = KMBackupPresentation.previousRestored
            return true
        } catch {
            previousStatus = KMBackupPresentation.previousFailure(error)
            return false
        }
    }

    private func hasPreviousProfile(_ repositories: KMRepositories) -> Bool {
        guard let store = repositories.localStore, let pointer = try? store.profile() else { return false }
        return pointer.previous != nil
    }
}
