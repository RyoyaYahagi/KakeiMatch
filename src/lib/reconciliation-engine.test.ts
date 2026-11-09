import { describe, expect, it } from "vitest";
import {
  GLOBAL_ASSIGNMENT_REASON,
  inspectReconciliationAssignment,
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
  it.each([
    ["アオゾラストア", "あおぞらストア"],
    ["ｱｵｿﾞﾗｽﾄｱ", "あおぞらストア"],
    ["あおぞらストア", "アオゾラストア"],
  ])("retains the kana variant of %s ahead of three similar but different stores", (merchant, equivalent) => {
    const result = runReconciliationEngine({
      statements: [statement("s", { merchant })],
      receipts: [receipt("correct", { merchant: equivalent }),
        ...["アオゾラカフェ", "アオゾラホテル", "アオゾラ薬局"].map((name, index) => receipt(`noise-${index}`, { merchant: name }))],
    });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]).toMatchObject({ receiptId: "correct", merchantSimilarity: 1, score: 0.75 });
    expect(result.candidates[0]?.reasons).toContain("merchant_similar");
    expect(result.statementResults[0]?.status).toBe("needs_review");
  });

  it("does not turn kana equivalence into an automatic match or a learned alias", () => {
    const result = runReconciliationEngine({
      statements: [statement("s", { merchant: "アオゾラストア" })],
      receipts: [receipt("r", { merchant: "あおぞらストア" })],
    });
    expect(result.candidates[0]?.merchantSimilarity).toBe(1);
    expect(result.candidates[0]?.reasons).not.toContain("merchant_alias_match");
    expect(result.statementResults[0]?.status).toBe("needs_review");
    expect(merchantAliasKey("アオゾラストア", "別名")).not.toBe(merchantAliasKey("あおぞらストア", "別名"));
  });

  it("matches an exact unique amount, date, and merchant and returns the version", () => {
    const result = runReconciliationEngine({ statements: [statement("s1")], receipts: [receipt("r1")] });
    expect(result.ruleVersion).toBe(RECONCILIATION_RULE_VERSION);
    expect(result.statementResults[0]).toMatchObject({ status: "matched", matchedReceiptId: "r1" });
    expect(result.receiptResults[0]).toMatchObject({ status: "matched", matchedStatementTransactionId: "s1" });
    expect(result.candidates[0]).toMatchObject({ rank: 1, score: 0.75, amountDeltaYen: 0, dateDistanceDays: 0, merchantSimilarity: 1 });
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

  it("keeps non-exact amount candidates even with unrelated merchant names", () => {
    const result = runReconciliationEngine({
      statements: [statement("s1")],
      receipts: [receipt("r1", { merchant: "全く別の薬局", amountYen: 1160 })],
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.statementResults[0]?.status).toBe("needs_review");
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

  it("keeps an unrelated merchant with the same amount for review", () => {
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


  it("prioritizes amount and date over an exact merchant name", () => {
    const result = runReconciliationEngine({
      statements: [statement("s1")],
      receipts: [receipt("merchant", { amountYen: 1160, purchasedDate: "2026-09-09" }),
        receipt("date-amount", { merchant: "無関係カフェ" })],
    });
    expect(result.candidates.map(row => row.receiptId)).toEqual(["date-amount", "merchant"]);
  });

  it("ranks the mapped source higher while retaining other sources for review", () => {
    const result = runReconciliationEngine({
      statements: [statement("s1", { preferredAccountIds: ["account-2"] })],
      receipts: [receipt("other", { amountYen: 1160 }), receipt("same", { actualAccountId: "account-2", merchant: "別表記", amountYen: 1160 })],
    });
    expect(result.candidates.map(row => row.receiptId)).toEqual(["same", "other"]);
    expect(result.candidates[0]?.reasons).toContain("payment_source_match");
    expect(result.candidates[0]?.score).toBe(0.73);
    expect(result.candidates[1]?.reasons).not.toContain("payment_source_match");
    expect(result.statementResults[0]?.status).toBe("needs_review");
  });

  it("puts the globally assigned review pair first, then keeps review score order", () => {
    const result = runReconciliationEngine({
      statements: [statement("s", { preferredAccountIds: ["account-2"] })],
      receipts: [receipt("correct", { actualAccountId: "account-2", merchant: "別の表記", purchasedDate: "2026-09-03" }),
        ...["a", "b", "c"].map(id => receipt(id))],
    });
    expect(result.candidates).toHaveLength(3);
    // The assignment tie-break selects receipt "a"; it is not automatic because
    // b and c are equal-weight alternatives (delta = 0).
    expect(result.candidates.map(row => row.receiptId)).toEqual(["a", "correct", "b"]);
    expect(result.candidates[0]?.reasons).toContain("global_assignment_pair");
    expect(result.candidates[0]?.reasons).not.toContain("payment_source_match");
    expect(result.candidates[1]?.reasons).toContain("payment_source_match");
    expect(result.statementResults[0]?.status).toBe("needs_review");
    expect(result.statementResults[0]?.reasonCodes).toContain("global_assignment_pair");
  });

  it("does not let payment source alone outweigh a maximum allowed amount difference", () => {
    const result = runReconciliationEngine({
      statements: [statement("s", { preferredAccountIds: ["account-2"] })],
      receipts: [receipt("mapped", { actualAccountId: "account-2", amountYen: 1100 }),
        receipt("exact", { merchant: "別の表記", purchasedDate: "2026-09-03" })],
    });
    expect(result.candidates.map(row => row.receiptId)).toEqual(["exact", "mapped"]);
  });

  it("retains an automatic pair when more than three review candidates outrank it", () => {
    const result = runReconciliationEngine({
      statements: [statement("s1", { preferredAccountIds: ["account-2"] })],
      receipts: [receipt("automatic", { purchasedDate: "2026-09-09" }),
        ...["a", "b", "c"].map(id => receipt(id, { actualAccountId: "account-2", merchant: "別表記" }))],
    });
    expect(result.statementResults[0]).toMatchObject({ status: "matched", matchedReceiptId: "automatic" });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]?.receiptId).toBe("automatic");
    expect(result.candidates[1]!.score).toBeGreaterThan(result.candidates[0]!.score);
  });

  it.each([100, 101, 300, 301])("applies the amount tolerance at %i yen without merchant evidence", delta => {
    const amount = delta >= 300 ? 10000 : 1200;
    const result = runReconciliationEngine({
      statements: [statement("s1", { amountYen: amount })],
      receipts: [receipt("r1", { amountYen: amount - delta, merchant: "別の店" })],
    });
    expect(result.candidates).toHaveLength(delta === 100 || delta === 300 ? 1 : 0);
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

describe("global assignment automatic matching", () => {
  it("collects a two-row chain that the mutual-best margin rule misses", () => {
    const statements = [
      statement("s0", { merchant: "架空商店A", amountYen: 1000, usedDate: "2026-09-10" }),
      statement("s1", { merchant: "架空商店B", amountYen: 1000, usedDate: "2026-09-12" }),
    ];
    const receipts = [
      receipt("r0", { merchant: "架空商店A", amountYen: 1000, purchasedDate: "2026-09-10" }),
      receipt("r1", { merchant: "架空商店B", amountYen: 1000, purchasedDate: "2026-09-12" }),
    ];
    const diagnostics = inspectReconciliationAssignment({ statements, receipts });
    expect(diagnostics.optimumWeight).toBe(2_000_000);
    expect(diagnostics.deltas.map((row) => row.delta)).toEqual([225_000, 225_000]);
    expect(diagnostics.deltas.every((row) => row.automatic)).toBe(true);
    const result = runReconciliationEngine({ statements, receipts });
    expect(result.statementResults.map((row) => [row.status, row.matchedReceiptId])).toEqual([["matched", "r0"], ["matched", "r1"]]);
    expect(result.receiptResults.every((row) => row.status === "matched")).toBe(true);
  });

  it("does not auto-match an equal-weight twin and keeps the assigned pair first for review", () => {
    const statements = [statement("s")];
    const receipts = [receipt("r-a"), receipt("r-b")];
    const diagnostics = inspectReconciliationAssignment({ statements, receipts });
    expect(diagnostics.deltas).toHaveLength(1);
    expect(diagnostics.deltas[0]?.delta).toBe(0);
    expect(diagnostics.assignment).toEqual([{ statementTransactionId: "s", receiptId: "r-a" }]);
    const result = runReconciliationEngine({ statements, receipts });
    expect(result.statementResults[0]).toMatchObject({ status: "needs_review", matchedReceiptId: null });
    expect(result.statementResults[0]?.reasonCodes).toContain(GLOBAL_ASSIGNMENT_REASON);
    expect(result.candidates[0]).toMatchObject({ receiptId: "r-a", rank: 1 });
    expect(result.candidates[0]?.reasons).toContain(GLOBAL_ASSIGNMENT_REASON);
  });

  it("removes manual statements from the assignment matrix", () => {
    const statements = [statement("s-manual"), statement("s-auto")];
    const receipts = [receipt("r")];
    const result = runReconciliationEngine({ statements, receipts, manualStatementIds: new Set(["s-manual"]) });
    expect(result.statementResults).toEqual([
      expect.objectContaining({ statementTransactionId: "s-auto", status: "matched", matchedReceiptId: "r" }),
      expect.objectContaining({ statementTransactionId: "s-manual", status: "needs_review", matchedReceiptId: null }),
    ]);
  });

  it("uses UTF-8 byte order for the statement and receipt tie-break", () => {
    const statements = [statement("s-あ"), statement("s-😀")];
    const receipts = [receipt("r-あ"), receipt("r-😀")];
    const diagnostics = inspectReconciliationAssignment({ statements, receipts });
    expect(diagnostics.assignment).toEqual([
      { statementTransactionId: "s-あ", receiptId: "r-あ" },
      { statementTransactionId: "s-😀", receiptId: "r-😀" },
    ]);
  });

  it("abstains when two aliases compete with equal weight", () => {
    const statements = [statement("s", { merchant: "架空ストア", amountYen: 1300, usedDate: "2026-09-10" })];
    const receipts = [
      receipt("r-a-truth", { merchant: "別名ストア", amountYen: 1300, purchasedDate: "2026-09-10" }),
      receipt("r-b-comp", { merchant: "別名商店", amountYen: 1300, purchasedDate: "2026-09-10" }),
    ];
    const aliases = new Set([
      merchantAliasKey(statements[0]!.merchant, receipts[0]!.merchant),
      merchantAliasKey(statements[0]!.merchant, receipts[1]!.merchant),
    ]);
    const diagnostics = inspectReconciliationAssignment({ statements, receipts, aliases });
    expect(diagnostics.deltas).toHaveLength(1);
    expect(diagnostics.deltas[0]?.delta).toBe(0);
    const result = runReconciliationEngine({ statements, receipts, aliases });
    expect(result.statementResults[0]).toMatchObject({ status: "needs_review", matchedReceiptId: null });
    expect(result.candidates[0]?.receiptId).toBe("r-a-truth");
    expect(result.candidates[0]?.reasons).toContain(GLOBAL_ASSIGNMENT_REASON);
  });

  it("pins the 1.3.0 rule version", () => {
    expect(RECONCILIATION_RULE_VERSION).toBe("1.3.0");
  });
});
