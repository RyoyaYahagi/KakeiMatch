import Foundation

/// Same amount/cleared-only update used by the decision service and durable ledger writer.
enum KMLedgerReconciliation {
    static func updated(_ row: KMTransaction, amountYen: Int?, cleared: Bool) throws -> KMTransaction {
        var result = row
        if let amount = amountYen {
            guard try KMYen.checked(amount) < 0, row.kind == .expense else { throw KMReconciliationError("actual_readback_mismatch") }
            guard row.isSplit != true || amount == row.amountYen else { throw KMReconciliationError("split_amount_adjustment_unsupported") }
            result.amountYen = amount
        }
        result.cleared = cleared
        result.splits = result.splits?.map { child in var value = child; value.cleared = cleared; return value }
        return result
    }
}
