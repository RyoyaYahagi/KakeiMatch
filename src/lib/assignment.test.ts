import { describe, expect, it } from "vitest";
import {
  lexicographicMaximumAssignment,
  maximumWeightAssignment,
  maximumWeight,
} from "./assignment";

function enumerateMaximum(weights: readonly (readonly number[])[]): { total: number; assignments: number[][] } {
  const rowCount = weights.length;
  const columnCount = weights[0]?.length ?? 0;
  let best = -1;
  const assignments: number[][] = [];
  const current = new Array<number>(rowCount).fill(-1);
  const used = new Array<boolean>(columnCount).fill(false);
  const visit = (row: number): void => {
    if (row === rowCount) {
      let total = 0;
      for (let index = 0; index < rowCount; index += 1) {
        const column = current[index]!;
        if (column >= 0) total += weights[index]![column]!;
      }
      if (total > best) {
        best = total;
        assignments.length = 0;
      }
      if (total === best) assignments.push([...current]);
      return;
    }
    current[row] = -1;
    visit(row + 1);
    for (let column = 0; column < columnCount; column += 1) {
      if (used[column] || weights[row]![column]! <= 0) continue;
      used[column] = true;
      current[row] = column;
      visit(row + 1);
      used[column] = false;
    }
    current[row] = -1;
  };
  visit(0);
  return { total: best, assignments };
}

function bruteLexicographic(weights: readonly (readonly number[])[]): number[] {
  const { assignments } = enumerateMaximum(weights);
  const columnCount = weights[0]?.length ?? 0;
  const sortKey = (assignment: readonly number[]) => assignment.map((column) => column < 0 ? columnCount : column);
  assignments.sort((left, right) => {
    const a = sortKey(left);
    const b = sortKey(right);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index]! - b[index]!;
    }
    return 0;
  });
  return assignments[0] ?? [];
}

describe("maximumWeightAssignment", () => {
  it("matches brute force on small rectangular matrices", () => {
    const cases: number[][][] = [
      [[3, 0], [0, 4]],
      [[1, 2, 0], [0, 1, 2]],
      [[0, 0], [0, 0]],
      [[5], [5], [5]],
      [[2, 4, 1], [3, 0, 5]],
      [[9, 1], [1, 9], [5, 5]],
    ];
    for (const weights of cases) {
      const actual = maximumWeightAssignment(weights);
      expect(actual.total).toBe(enumerateMaximum(weights).total);
      expect(maximumWeight(weights)).toBe(actual.total);
      let recomputed = 0;
      const used = new Set<number>();
      for (let row = 0; row < weights.length; row += 1) {
        const column = actual.assignment[row]!;
        if (column < 0) continue;
        expect(used.has(column)).toBe(false);
        used.add(column);
        recomputed += weights[row]![column]!;
      }
      expect(recomputed).toBe(actual.total);
    }
  });

  it("returns the lexicographically smallest maximum assignment", () => {
    const cases: number[][][] = [
      [[5, 5], [5, 5]],
      [[5, 5, 5], [5, 5, 0]],
      [[4, 4, 0], [4, 4, 0], [0, 0, 4]],
      [[2, 2, 2], [2, 2, 2], [0, 0, 0]],
      [[0, 1], [1, 0]],
      [[7, 6, 0], [6, 7, 0], [0, 0, 7]],
    ];
    for (const weights of cases) {
      const rows = weights.map((_, index) => index);
      const columns = (weights[0] ?? []).map((_, index) => index);
      const actual = lexicographicMaximumAssignment(weights, rows, columns);
      expect(actual).toEqual(bruteLexicographic(weights));
    }
  });

  it("uses the supplied row and column order for the tie-break", () => {
    const weights = [
      [5, 5],
      [5, 5],
    ];
    expect(lexicographicMaximumAssignment(weights, [0, 1], [1, 0])).toEqual([1, 0]);
    expect(lexicographicMaximumAssignment(weights, [1, 0], [0, 1])).toEqual([1, 0]);
  });

  it("keeps unassigned after every real column", () => {
    const weights = [
      [1, 1],
      [1, 0],
    ];
    expect(lexicographicMaximumAssignment(weights, [0, 1], [0, 1])).toEqual([1, 0]);
  });
});
