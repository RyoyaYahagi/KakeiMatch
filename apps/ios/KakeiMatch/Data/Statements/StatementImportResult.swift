import Foundation

struct KMStatementImportResult: Equatable, Sendable {
    var id: String
    var added: Int
    var duplicates: Int
    var excluded: Int
    var duplicateRowsInFile: Int
    var needsReviewRows: [KMStatementImport.NeedsReviewRow]
}
