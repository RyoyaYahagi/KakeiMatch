import Foundation
import CryptoKit
import JavaScriptCore

struct KMBackupManifest: Codable, Sendable {
    struct Entry: Codable, Sendable { var path: String; var size: Int; var sha256: String }
    struct Raw: Codable, Equatable, Sendable {
        var id: String; var ownerKind: String; var ownerId: String; var contentType: String; var createdAt: Date
        var present: Bool; var entry: String?; var size: Int?; var sha256: String?
    }
    struct Missing: Codable, Equatable, Sendable { var id: String; var ownerKind: String; var ownerId: String; var contentType: String? }
    var backupFormatVersion: Int; var localDataSchemaVersion: Int; var exportedAt: Date
    var entries: [Entry]; var rawArtifacts: [Raw]; var missingRawArtifacts: [Missing]
}
struct KMBackupArtifact: Sendable { var metadata: KMBackupManifest.Raw; var data: Data }
struct KMPortableContents: Sendable {
    var manifest: KMBackupManifest; var manifestJSON: Data; var localJSON: Data; var actualZIP: Data
    var records: [KMPortableRecord]; var artifacts: [KMBackupArtifact]
}
struct KMPortableRecord: Sendable {
    var id: String; var kind: KMLocalDataKind; var value: Data; var updatedAt: Date
    func decode<T: Decodable>(_ type: T.Type) throws -> T { try KMJSON.decoder().decode(type, from: value) }
    func object() throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: value) as? [String: Any] else { throw KMDataError.invalidData("端末記録が不正です。") }; return object
    }
}

/// Strict Zod schemas/refinements are built from the reference TS, not approximated by Codable.
/// JavaScriptCore executes only a bundled program and JSON data. No network, eval of input, or engine API.
@MainActor enum KMBackupSchema {
    static func validate(manifest: Data, local: Data, bundle: Bundle = .main) throws -> (KMBackupManifest, [KMPortableRecord]) {
        guard let source = bundle.url(forResource: "backup-validator", withExtension: "js"), let context = JSContext(),
              let manifestText = String(data: manifest, encoding: .utf8), let localText = String(data: local, encoding: .utf8) else {
            throw KMDataError.invalidData("バックアップの検証機能またはUTF-8を読み込めません。")
        }
        context.evaluateScript(try String(contentsOf: source, encoding: .utf8))
        guard context.exception == nil,
              let result = context.objectForKeyedSubscript("KMBackupValidation")?.objectForKeyedSubscript("validate")?.call(withArguments: [manifestText, localText]),
              context.exception == nil, let text = result.toString(), let bytes = text.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], object["error"] == nil,
              let manifestObject = object["manifest"], let localObject = object["local"] as? [String: Any],
              let rows = localObject["records"] as? [[String: Any]] else {
            throw KMDataError.invalidData("バックアップの目録または端末記録が未対応・不正です。")
        }
        let manifestValue = try KMJSON.decoder().decode(KMBackupManifest.self, from: JSONSerialization.data(withJSONObject: manifestObject))
        let records = try rows.map { row -> KMPortableRecord in
            struct Envelope: Decodable { var id: String; var kind: KMLocalDataKind; var updatedAt: Date }
            let envelope = try KMJSON.decoder().decode(Envelope.self, from: JSONSerialization.data(withJSONObject: row))
            guard let value = row["value"] else { throw KMDataError.invalidData("端末記録の値がありません。") }
            return KMPortableRecord(id: envelope.id, kind: envelope.kind, value: try JSONSerialization.data(withJSONObject: value), updatedAt: envelope.updatedAt)
        }
        return (manifestValue, records)
    }
}

@MainActor enum KMPortableBackup {
    static let maxManifest = 2 * 1024 * 1024, maxLocal = 64 * 1024 * 1024
    static let maxEntry = 128 * 1024 * 1024, maxTotal = 256 * 1024 * 1024, maxEntries = 10_000
    static let emptyLocal = Data(#"{"format":"kakeimatch-local-data","schemaVersion":2,"exportedAt":"2026-01-01T00:00:00Z","records":[],"blobs":[]}"#.utf8)
    static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func safePath(_ path: String) -> Bool {
        path.utf16.count <= 256 && !path.hasPrefix("/") && !path.contains("\\")
            && !path.split(separator: "/", omittingEmptySubsequences: false).contains { $0.isEmpty || $0 == "." || $0 == ".." }
            && path.range(of: #"^[a-z0-9._/-]+$"#, options: .regularExpression) != nil
    }
    static func read(url: URL) throws -> KMPortableContents {
        let properties = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard properties.isRegularFile == true, let size = properties.fileSize, size >= 12, size <= maxTotal + maxManifest + 12 else { throw invalid() }
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() } // Read-only handle; no persistence/cleanup outcome is hidden.
        let header = try read(file, count: 12)
        guard header.prefix(8) == Data("KMATCHB1".utf8) else { throw invalid() }
        let manifestLength = header.suffix(4).reduce(0) { $0 * 256 + Int($1) }
        guard manifestLength > 0, manifestLength <= maxManifest, manifestLength + 12 <= size else { throw invalid() }
        let manifestJSON = try read(file, count: manifestLength)
        let (manifest, _) = try KMBackupSchema.validate(manifest: manifestJSON, local: emptyLocal)
        var paths = Set<String>(), total = 0
        // Inspect ALL lengths/counts/names before reading any payload.
        for entry in manifest.entries {
            guard safePath(entry.path), paths.insert(entry.path).inserted, entry.size <= maxEntry else { throw invalid() }
            total += entry.size
            guard total <= maxTotal else { throw invalid() }
        }
        let rawPaths = manifest.rawArtifacts.compactMap(\.entry)
        let expected = Set(["actual-budget.zip", "local-data.json"] + rawPaths)
        guard total + 12 + manifestLength == size, paths == expected, rawPaths.count == manifest.rawArtifacts.count,
              Set(rawPaths).count == rawPaths.count, manifest.entries.count == 2 + manifest.rawArtifacts.filter(\.present).count,
              expected.count == manifest.entries.count,
              let actual = manifest.entries.first(where: { $0.path == "actual-budget.zip" }), actual.size > 0,
              let local = manifest.entries.first(where: { $0.path == "local-data.json" }), local.size <= maxLocal else { throw invalid() }
        var payloads: [String: Data] = [:]
        for entry in manifest.entries {
            let data = try read(file, count: entry.size)
            guard sha256(data) == entry.sha256 else { throw KMDataError.invalidData("バックアップのチェックサムが一致しません。") }
            payloads[entry.path] = data
        }
        guard (try file.read(upToCount: 1) ?? Data()).isEmpty, let localJSON = payloads["local-data.json"], let actualZIP = payloads["actual-budget.zip"] else { throw invalid() }
        let (_, records) = try KMBackupSchema.validate(manifest: manifestJSON, local: localJSON)
        var ids = Set<String>(), artifacts: [KMBackupArtifact] = []
        for raw in manifest.rawArtifacts {
            guard ids.insert(raw.id).inserted, raw.present, let path = raw.entry, let data = payloads[path],
                  raw.size == data.count, let descriptor = manifest.entries.first(where: { $0.path == path }), raw.sha256 == descriptor.sha256 else { throw invalid() }
            artifacts.append(KMBackupArtifact(metadata: raw, data: data))
        }
        let receipts = try records.filter { $0.kind == .receiptMetadata }.map { try $0.decode(KMReceipt.self) }
        let imports = Set(records.filter { $0.kind == .statementImport }.map(\.id))
        for artifact in artifacts {
            let raw = artifact.metadata
            if raw.ownerKind == "receipt" {
                guard let image = receipts.first(where: { $0.id == raw.ownerId })?.image,
                      image.blobId == raw.id, image.contentType == raw.contentType, image.sizeBytes == artifact.data.count else { throw invalid() }
            } else {
                guard raw.ownerKind == "statement-import", imports.contains(raw.ownerId), raw.id == "statement-source:\(raw.ownerId)" else { throw invalid() }
            }
        }
        var missing: [KMBackupManifest.Missing] = []
        // Preserve record order, as the TS expectedMissingArtifacts function does.
        for record in records {
            if record.kind == .receiptMetadata, let image = receipts.first(where: { $0.id == record.id })?.image, !ids.contains(image.blobId) {
                missing.append(.init(id: image.blobId, ownerKind: "receipt", ownerId: record.id, contentType: image.contentType))
            }
            if record.kind == .statementImport, !ids.contains("statement-source:\(record.id)") {
                missing.append(.init(id: "statement-source:\(record.id)", ownerKind: "statement-import", ownerId: record.id, contentType: nil))
            }
        }
        guard missing == manifest.missingRawArtifacts else { throw invalid() }
        return KMPortableContents(manifest: manifest, manifestJSON: manifestJSON, localJSON: localJSON, actualZIP: actualZIP, records: records, artifacts: artifacts)
    }
    private static func read(_ file: FileHandle, count: Int) throws -> Data {
        var bytes = Data(); bytes.reserveCapacity(count)
        while bytes.count < count {
            guard let chunk = try file.read(upToCount: min(count - bytes.count, 1024 * 1024)), !chunk.isEmpty else { throw invalid() }
            bytes.append(chunk)
        }
        return bytes
    }
    static func invalid() -> KMDataError { .invalidData("バックアップの形式・名前・件数・長さ・原本の対応が不正です。") }
}
