import CryptoKit
import Foundation

@MainActor extension KMInMemoryStore {
    func importStatement(data: Data, provider: KMStatementProvider, at timestamp: Date) async throws -> KMStatementImportResult {
        try importParsedStatement(KMStatementParser.parse(data: data, provider: provider), data: data, provider: provider, at: timestamp)
    }
    /// Parser output boundary; no ledger expense is created until the user resolves the statement.
    func importParsedStatement(_ parsed: KMStatementParseResult, data: Data, provider: KMStatementProvider, at timestamp: Date) throws -> KMStatementImportResult {
        guard parsed.fatalErrors.isEmpty, let signature = parsed.headerSignature, data.count <= KMStatementParser.maxBytes else {
            throw KMDataError.invalidData("明細を取り込めませんでした。ファイル形式または行の内容を確認してください。")
        }
        let hash = Self.sha256(data)
        let old = importValues.first { $0.value.provider == provider && $0.value.fileHash == hash }
        let importId = old?.id ?? UUID().uuidString
        var current = statementValues
        var added = 0, duplicates = parsed.duplicateRowsInFile
        for row in parsed.transactions {
            guard row.provider == provider, row.amountYen > 0, row.duplicateOrdinal > 0 else { throw KMDataError.invalidData("明細の内容を確認してください。") }
            _ = try KMYen.checked(row.amountYen)
            let external = row.externalId.flatMap { key in current.first { $0.provider == provider && $0.externalId == key } }
            if let external {
                guard external.kind == row.kind, external.usedDate == row.usedDate, external.usedTime == row.usedTime,
                      external.merchant == row.merchant, external.amountYen == row.amountYen else {
                    throw KMDataError.invalidData("同じ取引番号に異なる明細が見つかりました。")
                }
            }
            let key = try Self.statementIdentity(provider: provider, externalId: row.externalId, fingerprint: row.sourceFingerprint, ordinal: row.duplicateOrdinal)
            let existing = try current.contains { value in
                try Self.statementIdentity(provider: value.provider, externalId: value.externalId, fingerprint: value.sourceFingerprint, ordinal: value.duplicateOrdinal) == key
            }
            if existing || external != nil { duplicates += 1; continue }
            current.append(.init(id: Self.sha256(key), importId: importId, provider: provider, externalId: row.externalId,
                kind: row.kind, usedDate: row.usedDate, usedTime: row.usedTime, postedDate: row.postedDate, merchant: row.merchant,
                amountYen: row.amountYen, paymentMethod: row.paymentMethod, sourceFingerprint: row.sourceFingerprint, duplicateOrdinal: row.duplicateOrdinal))
            added += 1
        }
        let reviews = parsed.needsReviewRows.map { KMStatementImport.NeedsReviewRow(rowNumber: $0.rowNumber, reason: $0.reason) }
        let value = old?.value ?? .init(provider: provider, fileHash: hash, encoding: parsed.encoding, headerSignature: signature,
            totalRows: parsed.totalRows, excludedRows: parsed.excludedRows.count, duplicateRowsInFile: parsed.duplicateRowsInFile,
            needsReviewRows: reviews, createdAt: timestamp)
        let artifactId = "statement-source:\(importId)"
        let artifact = KMBackupArtifact(metadata: .init(id: artifactId, ownerKind: "statement-import", ownerId: importId,
            contentType: "text/csv", createdAt: timestamp, present: true, entry: nil, size: data.count, sha256: hash), data: data)
        // Publish after every fallible validation, including conflicting external IDs.
        statementValues = current
        if let index = importValues.firstIndex(where: { $0.id == importId }) { importValues[index].updatedAt = timestamp }
        else { importValues.append(.init(id: importId, kind: .statementImport, value: value, updatedAt: timestamp)) }
        imageValues[artifactId] = data
        pendingArtifacts.removeAll { $0.metadata.id == artifactId }; pendingArtifacts.append(artifact)
        return .init(id: importId, added: added, duplicates: duplicates, excluded: parsed.excludedRows.count,
            duplicateRowsInFile: parsed.duplicateRowsInFile, needsReviewRows: reviews)
    }
    static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func statementIdentity(provider: KMStatementProvider, externalId: String?, fingerprint: String, ordinal: Int) throws -> Data {
        try JSONSerialization.data(withJSONObject: [provider.rawValue, externalId ?? fingerprint, externalId == nil ? ordinal as Any : NSNull()], options: [.withoutEscapingSlashes])
    }
}
