/**
 * Maximum-weight bipartite assignment with a deterministic lexicographic
 * tie-break. Weights are non-negative integers and a partial assignment is
 * allowed: an edge with weight 0 is treated as "not assigned".
 *
 * The Hungarian implementation is self-contained; callers must not depend on
 * a graph-library implementation detail. Tie-breaking is part of the contract:
 * rows are decided in the supplied order, and each row takes the smallest
 * column (in the supplied column order) that can still be extended to a
 * maximum-weight assignment. "Unassigned" is considered after every real
 * column.
 */

export type AssignmentResult = {
  total: number;
  /** Column index per row; -1 means unassigned. */
  assignment: number[];
};

type WeightMatrix = readonly (readonly number[])[];

function emptyAssignment(): AssignmentResult {
  return { total: 0, assignment: [] };
}

/** Hungarians' O(n^3) minimum-cost assignment on a square matrix. */
function hungarian(cost: readonly (readonly number[])[]): number[] {
  const size = cost.length;
  if (size === 0) return [];
  const u = new Array<number>(size + 1).fill(0);
  const v = new Array<number>(size + 1).fill(0);
  const p = new Array<number>(size + 1).fill(0);
  const way = new Array<number>(size + 1).fill(0);
  const infinity = Number.MAX_SAFE_INTEGER;

  for (let row = 1; row <= size; row += 1) {
    p[0] = row;
    let currentColumn = 0;
    const minv = new Array<number>(size + 1).fill(infinity);
    const used = new Array<boolean>(size + 1).fill(false);
    do {
      used[currentColumn] = true;
      const currentRow = p[currentColumn]!;
      let delta = infinity;
      let nextColumn = 0;
      const costRow = cost[currentRow - 1]!;
      for (let column = 1; column <= size; column += 1) {
        if (used[column]) continue;
        const reduced = costRow[column - 1]! - u[currentRow]! - v[column]!;
        if (reduced < minv[column]!) {
          minv[column] = reduced;
          way[column] = currentColumn;
        }
        if (minv[column]! < delta) {
          delta = minv[column]!;
          nextColumn = column;
        }
      }
      for (let column = 0; column <= size; column += 1) {
        if (used[column]) {
          u[p[column]!] = u[p[column]!]! + delta;
          v[column] = v[column]! - delta;
        } else {
          minv[column] = minv[column]! - delta;
        }
      }
      currentColumn = nextColumn;
    } while (p[currentColumn] !== 0);

    do {
      const previousColumn = way[currentColumn]!;
      p[currentColumn] = p[previousColumn]!;
      currentColumn = previousColumn;
    } while (currentColumn !== 0);
  }

  const assignment = new Array<number>(size).fill(-1);
  for (let column = 1; column <= size; column += 1) {
    if (p[column]! > 0) assignment[p[column]! - 1] = column - 1;
  }
  return assignment;
}

function maxWeightFor(weights: WeightMatrix, rows: readonly number[], columns: readonly number[]): AssignmentResult {
  if (rows.length === 0 || columns.length === 0) return emptyAssignment();
  const size = Math.max(rows.length, columns.length);
  const maximum = 1_000_000;
  const cost = Array.from({ length: size }, (_, rowIndex) => Array.from({ length: size }, (_, columnIndex) => {
    const weight = rowIndex < rows.length && columnIndex < columns.length
      ? weights[rows[rowIndex]!]![columns[columnIndex]!]!
      : 0;
    return maximum - weight;
  }));
  const square = hungarian(cost);
  const assignment = new Array<number>(rows.length).fill(-1);
  let total = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const columnIndex = square[rowIndex] ?? -1;
    if (columnIndex < 0 || columnIndex >= columns.length) continue;
    const weight = weights[rows[rowIndex]!]![columns[columnIndex]!]!;
    if (weight <= 0) continue;
    assignment[rowIndex] = columns[columnIndex]!;
    total += weight;
  }
  return { total, assignment };
}

/** Returns the maximum total weight and one maximizing assignment. */
export function maximumWeightAssignment(weights: WeightMatrix): AssignmentResult {
  if (weights.length === 0 || (weights[0]?.length ?? 0) === 0) return emptyAssignment();
  const rows = weights.map((_, index) => index);
  const columns = (weights[0] ?? []).map((_, index) => index);
  return maxWeightFor(weights, rows, columns);
}

/** Returns only the maximum total weight. */
export function maximumWeight(weights: WeightMatrix): number {
  return maximumWeightAssignment(weights).total;
}

/**
 * Lexicographically smallest maximum-weight assignment.
 *
 * @param rowOrder rows in the order their assigned column IDs are compared.
 * @param columnOrder columns in ascending ID order.
 */
export function lexicographicMaximumAssignment(
  weights: WeightMatrix,
  rowOrder: readonly number[],
  columnOrder: readonly number[],
): number[] {
  if (weights.length === 0) return [];
  const columnCount = weights[0]?.length ?? 0;
  if (columnCount === 0) return new Array<number>(weights.length).fill(-1);
  if (rowOrder.length !== weights.length) throw new Error("assignment_row_order_incomplete");
  const total = maximumWeightAssignment(weights).total;
  const assignment = new Array<number>(weights.length).fill(-1);
  const decided = new Set<number>();
  const usedColumns = new Set<number>();
  let fixedWeight = 0;

  for (const row of rowOrder) {
    if (row < 0 || row >= weights.length) throw new Error("assignment_row_out_of_range");
    let chosen = -1;
    for (const column of columnOrder) {
      if (column < 0 || column >= columnCount || usedColumns.has(column)) continue;
      const weight = weights[row]![column]!;
      if (weight <= 0) continue;
      const remainingRows = Array.from({ length: weights.length }, (_, index) => index)
        .filter((index) => index !== row && !decided.has(index));
      const remainingColumns = Array.from({ length: columnCount }, (_, index) => index)
        .filter((index) => index !== column && !usedColumns.has(index));
      const remaining = maxWeightFor(weights, remainingRows, remainingColumns).total;
      if (fixedWeight + weight + remaining === total) {
        chosen = column;
        break;
      }
    }

    if (chosen >= 0) {
      assignment[row] = chosen;
      usedColumns.add(chosen);
      fixedWeight += weights[row]![chosen]!;
    } else {
      const remainingRows = Array.from({ length: weights.length }, (_, index) => index)
        .filter((index) => index !== row && !decided.has(index));
      const remainingColumns = Array.from({ length: columnCount }, (_, index) => index)
        .filter((index) => !usedColumns.has(index));
      const remaining = maxWeightFor(weights, remainingRows, remainingColumns).total;
      if (fixedWeight + remaining !== total) throw new Error("assignment_tie_break_infeasible");
    }
    decided.add(row);
  }
  return assignment;
}
