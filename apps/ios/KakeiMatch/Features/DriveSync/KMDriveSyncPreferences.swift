import Foundation

/// UserDefaults values for the Drive auto-save setting. The last failure reason
/// stays in memory only; only what survives a relaunch is stored here.
struct KMDriveSyncPreferences {
    static let enabledKey = "kakeimatch.driveSync.enabled"
    static let lastSentAtKey = "kakeimatch.driveSync.lastSentAt"
    static let lastFingerprintKey = "kakeimatch.driveSync.lastFingerprint"
    static let lastAccountIDKey = "kakeimatch.driveSync.lastAccountID"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Missing means OFF. Reading the raw bool is intentional: the default must
    /// not depend on a previous user or a previous install.
    var isEnabled: Bool {
        get { defaults.bool(forKey: Self.enabledKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.enabledKey) }
    }

    var lastSentAt: Date? {
        get { defaults.object(forKey: Self.lastSentAtKey) as? Date }
        nonmutating set {
            if let newValue { defaults.set(newValue, forKey: Self.lastSentAtKey) }
            else { defaults.removeObject(forKey: Self.lastSentAtKey) }
        }
    }

    var lastFingerprint: String? {
        get { defaults.string(forKey: Self.lastFingerprintKey) }
        nonmutating set {
            if let newValue { defaults.set(newValue, forKey: Self.lastFingerprintKey) }
            else { defaults.removeObject(forKey: Self.lastFingerprintKey) }
        }
    }

    /// The Google account that produced the last successful upload. Missing
    /// means the history cannot be attributed to a signed-in account.
    var lastAccountID: String? {
        get { defaults.string(forKey: Self.lastAccountIDKey) }
        nonmutating set {
            if let newValue { defaults.set(newValue, forKey: Self.lastAccountIDKey) }
            else { defaults.removeObject(forKey: Self.lastAccountIDKey) }
        }
    }

    /// Drops the "already sent" state when a different Google account connects.
    func clearUploadHistory() {
        lastSentAt = nil
        lastFingerprint = nil
        lastAccountID = nil
    }
}
