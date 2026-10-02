import { describe, expect, it } from "vitest";
import {
  merchantAliasKey,
  normalizeReconciliationMerchant,
  reconciliationMerchantSimilarity,
  RECONCILIATION_RULE_VERSION,
  runReconciliationEngine,
  type ReconciliationReceipt,
  type ReconciliationStatement,
} from "./reconciliation-engine";

function statement(id: string, patch: Partial<ReconciliationStatement> = {}): ReconciliationStatement {
  return {
    statementTransactionId: id,
    provider: "synthetic",
    externalId: `external-${id}`,
    kind: "purchase",
    usedDate: "2026-09-10",
    postedDate: null,
    merchant: "架空ストア新宿",
    amountYen: 1200,
    paymentMethod: null,
    ...patch,
  };
}

function receipt(id: string, patch: Partial<ReconciliationReceipt> = {}): ReconciliationReceipt {
  return {
    receiptId: id,
    actualTransactionId: `actual-${id}`,
    merchant: "架空ストア新宿",
    purchasedDate: "2026-09-10",
    amountYen: 1200,
    actualAccountId: "account-1",
    ...patch,
  };
}

describe("reconciliation merchant comparison", () => {
  it("normalizes NFKC, trim, ASCII case, whitespace, and common separators", () => {
    expect(normalizeReconciliationMerchant("  ＡＢＣ　 STORE・新宿  ")).toBe("abcstore新宿");
    expect(normalizeReconciliationMerchant("コーヒー・店")).toBe("コーヒー店");
    expect(normalizeReconciliationMerchant("北口 食堂")).toBe("北口食堂");
  });

  it("compares Japanese merchant names with stable character bigram Dice similarity", () => {
    expect(reconciliationMerchantSimilarity("", "")).toBe(0);
    expect(reconciliationMerchantSimilarity("架空 ストア", "架空　ストア")).toBe(1);
    expect(reconciliationMerchantSimilarity("青空 食堂", "青空食堂")).toBe(1);
    expect(reconciliationMerchantSimilarity("北口 食堂", "北口食堂")).toBe(1);
    expect(reconciliationMerchantSimilarity("セブン－イレブン新宿店", "セブン イレブン新宿店")).toBeGreaterThan(0.7);
    expect(reconciliationMerchantSimilarity("架空ストア新宿", "全く別の薬局")).toBeLessThan(0.2);
    expect(reconciliationMerchantSimilarity("同じ店", "同じ店")).toBe(1);
  });

  it("uses order-independent normalized keys for explicit aliases", () => {
    expect(merchantAliasKey("ＡＢＣ store", "xyz")).toBe(merchantAliasKey("xyz", "abc STORE"));
  });
});

describe("runReconciliationEngine", () => {
  it("matches an exact unique amount, date, and merchant and returns the version", () => {
    const result = runReconciliationEngine({ statements: [statement("s1")], receipts: [receipt("r1")] });
    expect(result.ruleVersion).toBe(RECONCILIATION_RULE_VERSION);
    expect(result.statementResults[0]).toMatchObject({ status: "matched", matchedReceiptId: "r1" });
    expect(result.receiptResults[0]).toMatchObject({ status: "matched", matchedStatementTransactionId: "s1" });
    expect(result.candidates[0]).toMatchObject({ rank: 1, score: 1, amountDeltaYen: 0, dateDistanceDays: 0, merchantSimilarity: 1 });
    expect(["matched", "needs_review", "unmatched_statement"]).toContain(result.statementResults[0]?.status);
  });

  it.each([1, 2, 3, 7])("keeps an exact amount candidate at %i day(s)", (distance) => {
    const result = runReconciliationEngine({
      statements: [statement("s1")],
      receipts: [receipt("r1", { purchasedDate: `2026-09-${String(10 - distance).padStart(2, "0")}` })],
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.dateDistanceDays).toBe(distance);
    expect(result.statementResults[0]?.status).toBe(distance <= 2 ? "matched" : "needs_review");
  });

  it("excludes candidates more than seven days apart", () => {
    const result = runReconciliationEngine({ statements: [statement("s1")], receipts: [receipt("r1", { purchasedDate: "2026-09-02" })] });
    expect(result.candidates).toHaveLength(0);
    expect(result.statementResults[0]?.status).toBe("unmatched_statement");
    expect(result.receiptResults[0]?.status).toBe("unmatched_receipt");
  });

  it("keeps a small amount difference as a review candidate but never auto-matches it", () => {
    const result = runReconciliationEngine({
      statements: [statement("s1")],
      receipts: [receipt("r1", { amountYen: 1160 })],
    });
    expect(result.candidates[0]).toMatchObject({ amountDeltaYen: 40 });
    expect(result.candidates[0]?.reasons).toContain("amount_close");
    expect(result.statementResults[0]?.status).toBe("needs_review");
    expect(result.receiptResults[0]?.status).toBe("needs_review");
  });

  it("requires merchant similarity for non-exact amount candidates", () => {
    const result = runReconciliationEngine({
      statements: [statement("s1")],
      receipts: [receipt("r1", { merchant: "全く別の薬局", amountYen: 1160 })],
    });
    expect(result.candidates).toHaveLength(0);
  });

  it("accepts an explicit alias as a review candidate and a conservative auto-match signal", () => {
    const pair = {
      statements: [statement("s1", { merchant: "青空ストア" })],
      receipts: [receipt("r1", { merchant: "青空商店" })],
    };
    const withoutAlias = runReconciliationEngine(pair);
    expect(withoutAlias.candidates).toHaveLength(1);
    expect(withoutAlias.statementResults[0]?.status).toBe("needs_review");
    const withAlias = runReconciliationEngine({ ...pair, aliases: new Set([merchantAliasKey("青空ストア", "青空商店")]) });
    expect(withAlias.statementResults[0]?.status).toBe("matched");
    expect(withAlias.candidates[0]?.reasons).toContain("merchant_alias_match");
  });

  it("does not create candidates for an unrelated merchant with the same amount", () => {
    const result = runReconciliationEngine({
      statements: [statement("s1", { merchant: "架空ストア新宿" })],
      receipts: [receipt("r1", { merchant: "無関係カフェ" })],
    });
    // Exact amount is a valid broad candidate gate; conservative auto matching still requires merchant evidence.
    expect(result.candidates).toHaveLength(1);
    expect(result.statementResults[0]?.status).toBe("needs_review");
  });

  it("retains amount exact as a candidate reason and never invents a confirmed state", () => {
    const result = runReconciliationEngine({ statements: [statement("s1")], receipts: [receipt("r1")] });
    expect(result.candidates[0]?.reasons).toContain("amount_exact");
    expect([...result.statementResults, ...result.receiptResults].every((row) => String(row.status) !== "confirmed")).toBe(true);
  });

  it("marks same-day, same-merchant, same-amount duplicate 2×2 rows ambiguous", () => {
    const result = runReconciliationEngine({
      statements: [statement("s1"), statement("s2")],
      receipts: [receipt("r1"), receipt("r2")],
    });
    expect(result.statementResults.map((row) => row.status)).toEqual(["needs_review", "needs_review"]);
    expect(result.receiptResults.map((row) => row.status)).toEqual(["needs_review", "needs_review"]);
    expect(result.candidates).toHaveLength(4);
    expect(result.candidates.every((candidate) => candidate.reasons.includes("ambiguous_candidates"))).toBe(true);
    expect(result.statementResults.every((row) => row.reasonCodes.includes("ambiguous_candidates"))).toBe(true);
    expect(result.receiptResults.every((row) => row.reasonCodes.includes("ambiguous_candidates"))).toBe(true);
  });

  it("never assigns one receipt to two statements", () => {
    const result = runReconciliationEngine({ statements: [statement("s1"), statement("s2", { usedDate: "2026-09-11", merchant: "無関係カフェ" })], receipts: [receipt("r1")] });
    expect(result.statementResults.filter((row) => row.status === "matched")).toHaveLength(1);
    expect(new Set(result.statementResults.flatMap((row) => row.matchedReceiptId ? [row.matchedReceiptId] : [])).size).toBe(1);
  });

  it("never assigns one statement to two receipts", () => {
    const result = runReconciliationEngine({ statements: [statement("s1")], receipts: [receipt("r1"), receipt("r2", { purchasedDate: "2026-09-11", merchant: "無関係カフェ" })] });
    expect(result.receiptResults.filter((row) => row.status === "matched")).toHaveLength(1);
    expect(new Set(result.receiptResults.flatMap((row) => row.matchedStatementTransactionId ? [row.matchedStatementTransactionId] : [])).size).toBe(1);
  });

  it("leaves refund rows unmatched and identifies the unsupported reason", () => {
    const result = runReconciliationEngine({ statements: [statement("refund", { kind: "refund" })], receipts: [receipt("r1")] });
    expect(result.statementResults[0]).toMatchObject({ status: "unmatched_statement", reasonCodes: ["refund_not_supported"] });
    expect(result.candidates).toHaveLength(0);
    expect(result.receiptResults[0]?.status).toBe("unmatched_receipt");
  });

  it("is deterministic regardless of input order and keeps only the top three statement candidates", () => {
    const statements = [statement("s2"), statement("s1")];
    const receipts = [receipt("r5"), receipt("r4"), receipt("r3"), receipt("r2"), receipt("r1")];
    const first = runReconciliationEngine({ statements, receipts });
    const second = runReconciliationEngine({ statements: [...statements].reverse(), receipts: [...receipts].reverse() });
    expect(first).toEqual(second);
    expect(first.candidates.filter((candidate) => candidate.statementTransactionId === "s1")).toHaveLength(3);
    expect(first.candidates.filter((candidate) => candidate.statementTransactionId === "s1").map((candidate) => candidate.rank)).toEqual([1, 2, 3]);
  });

  it("does not use provider, payment method, or account strings as matching evidence", () => {
    const pair = { statements: [statement("s1", { provider: "paypay", paymentMethod: "visa" })], receipts: [receipt("r1", { actualAccountId: "visa" })] };
    const baseline = runReconciliationEngine({ statements: [statement("s1")], receipts: [receipt("r1")] });
    expect(runReconciliationEngine(pair)).toEqual(baseline);
  });

  it("omits resolved rows and rejected pairs when generating the next run", () => {
    const result = runReconciliationEngine({
      statements: [statement("resolved"), statement("remaining")],
      receipts: [receipt("used"), receipt("available")],
      excludedStatementIds: new Set(["resolved"]),
      excludedReceiptIds: new Set(["used"]),
      rejectedPairs: new Set(["remaining\0available"]),
    });
    expect(result.statementResults.map((row) => row.statementTransactionId)).toEqual(["remaining"]);
    expect(result.receiptResults.map((row) => row.receiptId)).toEqual(["available"]);
    expect(result.candidates).toEqual([]);
    expect(result.statementResults[0]?.status).toBe("unmatched_statement");
  });

  it("matches statements against records in any payment source without account scoping", () => {
    const result = runReconciliationEngine({
      statements: [statement("s1")],
      receipts: [receipt("r1", { actualAccountId: "account-2" }), receipt("r2", { actualAccountId: "account-3", amountYen: 5000 })],
    });

    expect(result.candidates.map((candidate) => candidate.receiptId)).toEqual(["r1"]);
    expect(result.statementResults[0]).toMatchObject({ status: "matched", matchedReceiptId: "r1" });
  });

  it("keeps identical records in different payment sources for review instead of auto-matching", () => {
    const result = runReconciliationEngine({
      statements: [statement("s1")],
      receipts: [receipt("r1", { actualAccountId: "account-1" }), receipt("r2", { actualAccountId: "account-2" })],
    });

    expect(result.candidates.map((candidate) => candidate.receiptId)).toEqual(["r1", "r2"]);
    expect(result.statementResults[0]).toMatchObject({ status: "needs_review", matchedReceiptId: null,
      reasonCodes: expect.arrayContaining(["ambiguous_candidates"]) });
  });
});
