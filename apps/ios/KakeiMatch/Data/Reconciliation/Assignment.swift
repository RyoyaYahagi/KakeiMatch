import Foundation

/// Maximum-weight bipartite assignment with the same integer weights and
/// lexicographic tie-break as the TypeScript review ranking. Partial matching
/// is allowed; weight 0 means "no edge" and remains unassigned.
///
/// Issue #380 uses this only for review-candidate ordering. Automatic matching
/// keeps its 1.2.0 rules and never consumes this assignment.
enum KMReconciliationAssignment {
    static func maximumWeight(_ weights: [[Int]]) -> Int {
        guard let first = weights.first, !first.isEmpty else { return 0 }
        return maxWeight(weights, rows: Array(0..<weights.count), columns: Array(0..<first.count)).total
    }

    static func lexicographicAssignment(_ weights: [[Int]], rowOrder: [Int], columnOrder: [Int]) -> [Int] {
        guard let first = weights.first, !first.isEmpty else { return Array(repeating: -1, count: weights.count) }
        precondition(rowOrder.count == weights.count)
        let total = maximumWeight(weights)
        var assignment = Array(repeating: -1, count: weights.count)
        var decided = Set<Int>()
        var usedColumns = Set<Int>()
        var fixedWeight = 0
        let columnCount = first.count
        let rowIndices = Array(0..<weights.count)
        let columnIndices = Array(0..<columnCount)

        for row in rowOrder {
            precondition(row >= 0 && row < weights.count)
            var chosen = -1
            for column in columnOrder where column >= 0 && column < columnCount && !usedColumns.contains(column) {
                let weight = weights[row][column]
                if weight <= 0 { continue }
                let remainingRows = rowIndices.filter { $0 != row && !decided.contains($0) }
                let remainingColumns = columnIndices.filter { $0 != column && !usedColumns.contains($0) }
                let remaining = maxWeight(weights, rows: remainingRows, columns: remainingColumns).total
                if fixedWeight + weight + remaining == total {
                    chosen = column
                    break
                }
            }
            if chosen >= 0 {
                assignment[row] = chosen
                usedColumns.insert(chosen)
                fixedWeight += weights[row][chosen]
            } else {
                let remainingRows = rowIndices.filter { $0 != row && !decided.contains($0) }
                let remainingColumns = columnIndices.filter { !usedColumns.contains($0) }
                let remaining = maxWeight(weights, rows: remainingRows, columns: remainingColumns).total
                precondition(fixedWeight + remaining == total, "assignment tie-break infeasible")
            }
            decided.insert(row)
        }
        return assignment
    }

    private static func maxWeight(_ weights: [[Int]], rows: [Int], columns: [Int]) -> (total: Int, assignment: [Int]) {
        guard !rows.isEmpty, !columns.isEmpty else { return (0, Array(repeating: -1, count: rows.count)) }
        let size = max(rows.count, columns.count)
        let maximum = 1_000_000
        var cost = Array(repeating: Array(repeating: maximum, count: size), count: size)
        for (rowIndex, row) in rows.enumerated() {
            for (columnIndex, column) in columns.enumerated() {
                cost[rowIndex][columnIndex] = maximum - weights[row][column]
            }
        }
        let square = hungarian(cost)
        var assignment = Array(repeating: -1, count: rows.count)
        var total = 0
        for rowIndex in rows.indices {
            let squareColumn = square[rowIndex]
            guard squareColumn >= 0 && squareColumn < columns.count else { continue }
            let column = columns[squareColumn]
            let weight = weights[rows[rowIndex]][column]
            guard weight > 0 else { continue }
            assignment[rowIndex] = column
            total += weight
        }
        return (total, assignment)
    }

    private static func hungarian(_ cost: [[Int]]) -> [Int] {
        let size = cost.count
        guard size > 0 else { return [] }
        var u = Array(repeating: 0, count: size + 1)
        var v = Array(repeating: 0, count: size + 1)
        var p = Array(repeating: 0, count: size + 1)
        var way = Array(repeating: 0, count: size + 1)
        let infinity = Int.max / 4

        for row in 1...size {
            p[0] = row
            var currentColumn = 0
            var minv = Array(repeating: infinity, count: size + 1)
            var used = Array(repeating: false, count: size + 1)
            repeat {
                used[currentColumn] = true
                let currentRow = p[currentColumn]
                var delta = infinity
                var nextColumn = 0
                let costRow = cost[currentRow - 1]
                for column in 1...size where !used[column] {
                    let reduced = costRow[column - 1] - u[currentRow] - v[column]
                    if reduced < minv[column] {
                        minv[column] = reduced
                        way[column] = currentColumn
                    }
                    if minv[column] < delta {
                        delta = minv[column]
                        nextColumn = column
                    }
                }
                for column in 0...size {
                    if used[column] {
                        u[p[column]] += delta
                        v[column] -= delta
                    } else {
                        minv[column] -= delta
                    }
                }
                currentColumn = nextColumn
            } while p[currentColumn] != 0

            repeat {
                let previousColumn = way[currentColumn]
                p[currentColumn] = p[previousColumn]
                currentColumn = previousColumn
            } while currentColumn != 0
        }

        var assignment = Array(repeating: -1, count: size)
        for column in 1...size where p[column] > 0 {
            assignment[p[column] - 1] = column - 1
        }
        return assignment
    }
}
