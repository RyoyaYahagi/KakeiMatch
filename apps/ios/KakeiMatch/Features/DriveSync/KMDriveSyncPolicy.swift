import CryptoKit
import Foundation

/// Whether an automatic upload has anything new to send. Pure so the screen's
/// conditions can be tested without defaults, Google Sign-In, or repositories.
enum KMDriveSyncPolicy {
    static func shouldUpload(isEnabled: Bool, isSignedIn: Bool, hasScope: Bool,
                             fingerprint: String, lastUploadedFingerprint: String?) -> Bool {
        guard isEnabled, isSignedIn, hasScope else { return false }
        return fingerprint != lastUploadedFingerprint
    }
}

/// Fingerprint of the snapshot contents with `generatedAt` blanked out, so two
/// builds a minute apart compare equal while any change to accounts,
/// transactions, or monthly totals changes the value.
enum KMDriveSnapshotFingerprint {
    static func compute(_ snapshot: KMMuseSnapshot) throws -> String {
        var content = snapshot
        content.generatedAt = ""
        let data = try content.jsonData()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
