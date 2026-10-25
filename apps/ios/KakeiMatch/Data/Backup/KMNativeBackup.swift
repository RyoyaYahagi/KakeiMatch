import Foundation
import CryptoKit

struct KMNativeBackupManifest: Codable, Sendable {
    struct Entry: Codable, Sendable { var path: String; var size: Int; var sha256: String }
    var format: String
    var formatVersion: Int
    var schemaVersion: Int
    var exportedAt: Date
    var entries: [Entry]
}

struct KMNativeBackupContents: Sendable { var exportedAt: Date; var database: Data; var artifacts: [(String, Data)] }

/// iOS-only, uncompressed container. Its magic, extension, and manifest discriminator are
/// intentionally distinct from the PWA KMATCHB1/.kmb format.
@MainActor enum KMNativeBackup {
    static let magic = Data("KMIOB001".utf8)
    static let format = "kakeimatch-ios-native-backup"
    static let formatVersion = 1
    static let schemaVersion = 1
    static let maxManifest = 2 * 1024 * 1024
    static let maxEntry = 128 * 1024 * 1024
    static let maxTotal = 256 * 1024 * 1024
    static let maxEntries = 10_000

    static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    static func package(database: Data, artifacts: [(String, Data)], exportedAt: Date) throws -> Data {
        var entries: [(String, Data)] = [("household.sqlite", database)]
        entries += artifacts.map { ("artifacts/\(Data($0.0.utf8).map { String(format: "%02x", $0) }.joined())", $0.1) }
        let paths = entries.map(\.0)
        guard entries.count <= maxEntries, Set(paths).count == paths.count, paths.allSatisfy(KMPortableBackup.safePath),
              entries.allSatisfy({ $0.1.count <= maxEntry }), entries.reduce(0, { $0 + $1.1.count }) <= maxTotal else { throw KMPortableBackup.invalid() }
        let manifest = KMNativeBackupManifest(format: format, formatVersion: formatVersion, schemaVersion: schemaVersion, exportedAt: exportedAt,
            entries: entries.map { .init(path: $0.0, size: $0.1.count, sha256: sha256($0.1)) })
        let encoder = KMJSON.encoder(); encoder.outputFormatting = [.sortedKeys]
        let json = try encoder.encode(manifest)
        guard json.count <= maxManifest else { throw KMPortableBackup.invalid() }
        var result = magic
        let length = UInt32(json.count)
        result.append(contentsOf: [UInt8(length >> 24), UInt8((length >> 16) & 255), UInt8((length >> 8) & 255), UInt8(length & 255)])
        result.append(json)
        for (_, bytes) in entries { result.append(bytes) }
        return result
    }

    static func read(url: URL) throws -> KMNativeBackupContents {
        let properties = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard properties.isRegularFile == true, let size = properties.fileSize, size >= 12, size <= maxTotal + maxManifest + 12 else { throw KMPortableBackup.invalid() }
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        guard data.prefix(8) == magic else { throw KMPortableBackup.invalid() }
        let manifestSize = data[8..<12].reduce(0) { $0 * 256 + Int($1) }
        guard manifestSize > 0, manifestSize <= maxManifest, 12 + manifestSize <= data.count else { throw KMPortableBackup.invalid() }
        let manifestData = data.subdata(in: 12..<12 + manifestSize)
        guard let json = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
              Set(json.keys) == Set(["format", "formatVersion", "schemaVersion", "exportedAt", "entries"]),
              let format = json["format"] as? String, format == Self.format,
              let version = json["formatVersion"] as? Int, version == formatVersion,
              let schema = json["schemaVersion"] as? Int, schema == schemaVersion,
              let entryRows = json["entries"] as? [[String: Any]], !entryRows.isEmpty, entryRows.count <= maxEntries else {
            throw KMDataError.unsupported("このiOSバックアップ形式は未対応です。データは変更されていません。")
        }
        let manifest = try KMJSON.decoder().decode(KMNativeBackupManifest.self, from: manifestData)
        var seen = Set<String>(), total = 0, offset = 12 + manifestSize
        var payloads: [(String, Data)] = []
        for row in entryRows {
            guard Set(row.keys) == Set(["path", "size", "sha256"]),
                  let path = row["path"] as? String, KMPortableBackup.safePath(path), seen.insert(path).inserted,
                  let count = row["size"] as? Int, count >= 0, count <= maxEntry,
                  let hash = row["sha256"] as? String, hash.count == 64 else { throw KMPortableBackup.invalid() }
            total += count
            guard total <= maxTotal, count <= data.count - offset else { throw KMPortableBackup.invalid() }
            let payload = data.subdata(in: offset..<offset + count); offset += count
            guard sha256(payload) == hash else { throw KMDataError.invalidData("バックアップのチェックサムが一致しません。") }
            payloads.append((path, payload))
        }
        guard offset == data.count, manifest.entries.count == payloads.count,
              zip(manifest.entries, payloads).allSatisfy({ pair in pair.0.path == pair.1.0 && pair.0.size == pair.1.1.count && pair.0.sha256 == sha256(pair.1.1) }),
              let db = payloads.first(where: { $0.0 == "household.sqlite" })?.1,
              payloads.filter({ $0.0 != "household.sqlite" }).allSatisfy({ $0.0.hasPrefix("artifacts/") }) else { throw KMPortableBackup.invalid() }
        return KMNativeBackupContents(exportedAt: manifest.exportedAt, database: db,
            artifacts: payloads.filter { $0.0 != "household.sqlite" }.map { ($0.0, $0.1) })
    }
}
