import { describe, expect, it } from "vitest";
import { isApplyError, orderReviewItems, reasonLabel, type ReviewItem } from "./reconciliation-view-model";

function item(overrides: Partial<ReviewItem>): ReviewItem {
  return {
    statementTransactionId: "statement-a", status: "needs_review",
    statement: { kind: "purchase", usedDate: "2026-09-01", merchant: "架空商店", amountYen: 1250, provider: "paypay" },
    reasonCodes: [], candidates: [], resolution: null, ...overrides,
  };
}

describe("reconciliation review view model", () => {
  it("recognizes a saved decision whose household update failed", () => {
    expect(isApplyError(item({ resolution: { id: "resolution-a", status: "failed", resolution: "same_expense", source: "user", lastErrorCode: "actual_write_failed" } }))).toBe(true);
  });
  it("orders apply errors, needs review, and unmatched statements without adding unmatched receipts", () => {
    const error = item({ statementTransactionId: "error", resolution: { id: "r", status: "failed", resolution: "same_expense", source: "user", lastErrorCode: null } });
    const review = item({ statementTransactionId: "review" });
    const unmatched = item({ statementTransactionId: "unmatched", status: "unmatched_statement" });
    expect(orderReviewItems([unmatched, review, error]).map((row) => row.statementTransactionId)).toEqual(["error", "review", "unmatched"]);
  });
  it("turns known machine reasons into Japanese and hides unknown internal values", () => {
    expect(reasonLabel("date_close")).toBe("日付が近いです");
    expect(reasonLabel("unrecognized_internal_reason")).toBeNull();
  });
});
