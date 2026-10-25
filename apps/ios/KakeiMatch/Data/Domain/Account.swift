import Foundation

// TS: src/lib/actual-browser-ledger.ts ActualAccountType.
enum KMAccountType: String, Codable, CaseIterable, Sendable { case bank, creditCard = "credit_card", cash, other }

// TS: src/lib/local-backup-format.ts statementImport.provider / account-metadata.statementProvider.
enum KMStatementProvider: String, Codable, CaseIterable, Sendable {
    case smbcCard = "smbc_card", rakutenCard = "rakuten_card", aeonCard = "aeon_card", paypay, paypayCard = "paypay_card"
}

// TS: src/lib/actual-browser-ledger.ts ManagedAccountBalance + account-metadata.statementProvider; offbudget is Actual account metadata.
struct KMAccount: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var closed: Bool = false
    var accountType: KMAccountType = .other
    var balanceYen: Int = 0
    var statementProvider: KMStatementProvider? = nil
    var offbudget: Bool? = nil
}

// TS: Actual API getPayees() / src/lib/actual-browser-ledger.ts payee lookup.
struct KMPayee: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var transferAccountId: String? = nil
}
