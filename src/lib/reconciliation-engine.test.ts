import { describe, expect, it } from "vitest";
import {
  inspectReconciliationRanking,
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

  it("normalizes the confirmed Vpass prefix and Japanese corporate-form variants", () => {
    const variants = ["株式会社青空食堂", "（株）青空食堂", "㈱青空食堂", "カブシキガイシャ青空食堂",
      "青空食堂株式会社", "青空食堂（株）", "青空食堂㈱", "青空食堂カブシキガイシャ"];
    for (const merchant of variants) {
      expect(normalizeReconciliationMerchant(merchant)).toBe("青空食堂");
      expect(reconciliationMerchantSimilarity(merchant, "青空食堂")).toBe(1);
    }
    expect(normalizeReconciliationMerchant("架空株式会社ストア")).toBe("架空株式会社ストア");

    const result = runReconciliationEngine({
      statements: [statement("s", { merchant: "Ｖｉｓａ国内利用 Vs ﾀﾞｲﾄﾞ-ﾄﾞﾘﾝｺ ｶ" })],
      receipts: [receipt("r", { merchant: "ﾀﾞｲﾄﾞ-ﾄﾞﾘﾝｺ ｶ" })],
    });
    expect(result.candidates[0]?.merchantSimilarity).toBe(1);
    expect(result.statementResults[0]).toMatchObject({ status: "matched", matchedReceiptId: "r" });
  });

  it("waives the auto merchant gate for a same-source unique exact-amount pair", () => {
    const result = runReconciliationEngine({
      statements: [statement("s", { merchant: "無関係な明細名", preferredAccountIds: ["account-2"] })],
      receipts: [receipt("r", { merchant: "内容なし", actualAccountId: "account-2" })],
    });
    expect(result.ruleVersion).toBe("1.2.4");
    expect(result.statementResults[0]).toMatchObject({ status: "matched", matchedReceiptId: "r" });
    expect(result.candidates[0]?.merchantSimilarity).toBe(0);
  });

  it.each(["receipt", "statement", "excluded receipt", "excluded statement", "rejected pair"] as const)(
    "does not waive the merchant gate when a same-amount %s competes within seven days",
    (competitor) => {
      const statementRows = [statement("s", { merchant: "明細不明", preferredAccountIds: ["account-2"] })];
      const receiptRows = [receipt("r", { merchant: "内容なし", actualAccountId: "account-2" })];
      const options: Parameters<typeof runReconciliationEngine>[0] = {
        statements: statementRows,
        receipts: receiptRows,
      };
      if (competitor === "receipt" || competitor === "rejected pair") {
        receiptRows.push(receipt("r-competing", { purchasedDate: "2026-09-17", actualAccountId: "account-3" }));
        if (competitor === "rejected pair") options.rejectedPairs = new Set(["s\0r-competing"]);
      } else if (competitor === "statement" || competitor === "excluded statement") {
        statementRows.push(statement("s-competing", { usedDate: "2026-09-17", merchant: "別の明細", preferredAccountIds: [] }));
        if (competitor === "excluded statement") options.excludedStatementIds = new Set(["s-competing"]);
      } else {
        receiptRows.push(receipt("r-competing", { purchasedDate: "2026-09-17", actualAccountId: "account-3" }));
        options.excludedReceiptIds = new Set(["r-competing"]);
      }
      const result = runReconciliationEngine(options);
      expect(result.statementResults.find((row) => row.statementTransactionId === "s")?.status).toBe("needs_review");
    },
  );

  it("counts only purchase statements as exact-amount competitors", () => {
    const result = runReconciliationEngine({
      statements: [
        statement("s", { merchant: "明細不明", preferredAccountIds: ["account-2"] }),
        statement("refund", { kind: "refund", usedDate: "2026-09-17" }),
      ],
      receipts: [receipt("r", { merchant: "内容なし", actualAccountId: "account-2" })],
    });
    expect(result.statementResults.find((row) => row.statementTransactionId === "s")?.status).toBe("matched");
  });

  it("does not count an exact-amount row outside the seven-day window as a competitor", () => {
    const result = runReconciliationEngine({
      statements: [statement("s", { merchant: "明細不明", preferredAccountIds: ["account-2"] })],
      receipts: [
        receipt("r", { merchant: "内容なし", actualAccountId: "account-2" }),
        receipt("outside", { purchasedDate: "2026-09-18", actualAccountId: "account-3" }),
      ],
    });
    expect(result.statementResults[0]).toMatchObject({ status: "matched", matchedReceiptId: "r" });
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

  it("retains the mapped source ahead of three same-amount alternatives with closer dates and merchants", () => {
    const result = runReconciliationEngine({
      statements: [statement("s", { preferredAccountIds: ["account-2"] })],
      receipts: [receipt("correct", { actualAccountId: "account-2", merchant: "別の表記", purchasedDate: "2026-09-03" }),
        ...["a", "b", "c"].map(id => receipt(id))],
    });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]?.receiptId).toBe("correct");
    expect(result.candidates[0]?.reasons).toContain("payment_source_match");
    expect(result.candidates.slice(1).every(row => row.receiptId !== "correct")).toBe(true);
    expect(result.statementResults[0]?.status).toBe("needs_review");
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

  it("promotes the global review assignment partner without changing automatic decisions", () => {
    const statements = [
      statement("s1", { merchant: "架空商店アルファ", amountYen: 1000 }),
      statement("s2", { merchant: "無関係カフェ", amountYen: 1000, preferredAccountIds: ["acct-1"] }),
    ];
    const receipts = [
      receipt("r1", { merchant: "架空商店アルファ", amountYen: 1000, actualAccountId: "acct-1" }),
      receipt("r2", { merchant: "架空商店アルファ", amountYen: 1000, purchasedDate: "2026-09-11", actualAccountId: "acct-2" }),
    ];
    const input = { statements, receipts };
    const result = runReconciliationEngine(input);

    // Both rows stay in review; the assignment only reorders existing candidates.
    expect(result.statementResults.map((row) => row.status)).toEqual(["needs_review", "needs_review"]);
    expect(result.candidates.filter((candidate) => candidate.statementTransactionId === "s1").map((candidate) => candidate.receiptId)).toEqual(["r2", "r1"]);
    expect(result.candidates.filter((candidate) => candidate.statementTransactionId === "s2").map((candidate) => candidate.receiptId)).toEqual(["r1", "r2"]);
    expect(new Set(result.candidates.map((candidate) => `${candidate.statementTransactionId}\0${candidate.receiptId}`))).toEqual(new Set([
      "s1\0r1", "s1\0r2", "s2\0r1", "s2\0r2",
    ]));
    expect(inspectReconciliationRanking(input)).toEqual({
      assignments: [
        { statementTransactionId: "s1", receiptId: "r2" },
        { statementTransactionId: "s2", receiptId: "r1" },
      ],
    });
  });

  it("promotes the assignment partner only when its review score is nearly tied", () => {
    const guardCase = (amountDeltaYen: number) => {
      const statements = [
        statement("s1", { merchant: "架空商店アルファ", amountYen: 10000 }),
        statement("s2", { merchant: "架空商店アルファ", amountYen: 10000, preferredAccountIds: ["acct-1"] }),
      ];
      const receipts = [
        receipt("r1", { merchant: "架空商店アルファ", amountYen: 10000, purchasedDate: "2026-09-07", actualAccountId: "acct-1" }),
        receipt("r2", { merchant: "架空商店アルファ", amountYen: 10000 - amountDeltaYen, purchasedDate: "2026-09-07", actualAccountId: "acct-2" }),
      ];
      const input = { statements, receipts };
      const result = runReconciliationEngine(input);
      const candidates = result.candidates.filter((candidate) => candidate.statementTransactionId === "s1");
      return {
        input,
        candidates,
        partner: candidates.find((candidate) => candidate.receiptId === "r2")!,
        leader: candidates.find((candidate) => candidate.receiptId === "r1")!,
        result,
      };
    };

    // 82 yen at a 300 yen tolerance is just over the 0.15 review-score gap.
    const blocked = guardCase(82);
    expect(blocked.leader.score - blocked.partner.score).toBeGreaterThan(0.15);
    expect(blocked.candidates.map((candidate) => candidate.receiptId)).toEqual(["r1", "r2"]);
    expect(blocked.candidates.map((candidate) => candidate.rank)).toEqual([1, 2]);
    expect(blocked.result.statementResults.map((row) => row.status)).toEqual(["needs_review", "needs_review"]);
    expect(inspectReconciliationRanking(blocked.input).assignments).toEqual([
      { statementTransactionId: "s1", receiptId: "r2" },
      { statementTransactionId: "s2", receiptId: "r1" },
    ]);

    // 81 yen is just under the boundary, so the assignment partner leads.
    const promoted = guardCase(81);
    expect(promoted.leader.score - promoted.partner.score).toBeLessThanOrEqual(0.15);
    expect(promoted.candidates.map((candidate) => candidate.receiptId)).toEqual(["r2", "r1"]);
    expect(promoted.candidates.map((candidate) => candidate.rank)).toEqual([1, 2]);
    expect(promoted.result.statementResults.map((row) => row.status)).toEqual(["needs_review", "needs_review"]);
    expect(inspectReconciliationRanking(promoted.input).assignments).toEqual([
      { statementTransactionId: "s1", receiptId: "r2" },
      { statementTransactionId: "s2", receiptId: "r1" },
    ]);
  });

  it("promotes at exactly the 0.15 review-score boundary and blocks just above it", () => {
    // 4400 yen gives a 132 yen tolerance. r1 is 108 yen off, so its amount
    // score is 2/11 and 0.55 * 2/11 + 0.15 (date) + 0.05 (merchant) = 0.3.
    // r2 is exactly at the tolerance (amount score 0), has zero merchant
    // similarity, and has the same date, so its review score is exactly 0.15.
    // 0.3 - 0.15 is exactly the binary64 value of 0.15 in JS.
    const boundaryCase = (partnerDate: string) => {
      const statements = [
        statement("s1", { merchant: "架空商店アルファ", amountYen: 4400 }),
        statement("s2", { merchant: "架空商店アルファ", amountYen: 4400, preferredAccountIds: ["acct-1"] }),
      ];
      const receipts = [
        receipt("r1", { merchant: "架空商店アルファ", amountYen: 4292, purchasedDate: "2026-09-10", actualAccountId: "acct-1" }),
        receipt("r2", { merchant: "無関係薬局", amountYen: 4268, purchasedDate: partnerDate, actualAccountId: "acct-2" }),
      ];
      const input = { statements, receipts };
      const result = runReconciliationEngine(input);
      const candidates = result.candidates.filter((candidate) => candidate.statementTransactionId === "s1");
      return {
        input,
        candidates,
        leader: candidates.find((candidate) => candidate.receiptId === "r1")!,
        partner: candidates.find((candidate) => candidate.receiptId === "r2")!,
        result,
      };
    };

    const exact = boundaryCase("2026-09-10");
    expect(exact.leader.score).toBe(0.3);
    expect(exact.partner.score).toBe(0.15);
    expect(exact.leader.score - exact.partner.score).toBe(0.15);
    expect(exact.candidates.map((candidate) => candidate.receiptId)).toEqual(["r2", "r1"]);
    expect(exact.candidates.map((candidate) => candidate.rank)).toEqual([1, 2]);
    expect(exact.result.statementResults.map((row) => row.status)).toEqual(["needs_review", "needs_review"]);
    expect(inspectReconciliationRanking(exact.input).assignments).toEqual([
      { statementTransactionId: "s1", receiptId: "r2" },
      { statementTransactionId: "s2", receiptId: "r1" },
    ]);

    // One day farther makes the partner 0.13125, a 0.16875 gap.
    const above = boundaryCase("2026-09-09");
    expect(above.leader.score - above.partner.score).toBeGreaterThan(0.15);
    expect(above.candidates.map((candidate) => candidate.receiptId)).toEqual(["r1", "r2"]);
    expect(above.candidates.map((candidate) => candidate.rank)).toEqual([1, 2]);
    expect(above.result.statementResults.map((row) => row.status)).toEqual(["needs_review", "needs_review"]);
    expect(inspectReconciliationRanking(above.input).assignments).toEqual([
      { statementTransactionId: "s1", receiptId: "r2" },
      { statementTransactionId: "s2", receiptId: "r1" },
    ]);
  });

  it("keeps the old candidate set when every candidate conflicts (4x4 reproduction)", () => {
    const statements = ["s0", "s1", "s2", "s3"].map((id) => statement(id, {
      merchant: "同額商店", amountYen: 1000, usedDate: "2026-01-01",
    }));
    const receipts = ["r0", "r1", "r2", "r3"].map((id) => receipt(id, {
      merchant: "同額商店", amountYen: 1000, purchasedDate: "2026-01-01", actualAccountId: `acct-${id}`,
    }));
    const result = runReconciliationEngine({ statements, receipts });
    const receiptIdsFor = (statementId: string) => result.candidates
      .filter((candidate) => candidate.statementTransactionId === statementId)
      .map((candidate) => candidate.receiptId);

    // The assignment may reorder these rows, but the set must stay exactly the
    // 1.2.0 output: r0, r1, r2 for every statement. r3 must not appear.
    expect(receiptIdsFor("s0")).toEqual(["r0", "r1", "r2"]);
    expect(new Set(receiptIdsFor("s1"))).toEqual(new Set(["r0", "r1", "r2"]));
    expect(new Set(receiptIdsFor("s2"))).toEqual(new Set(["r0", "r1", "r2"]));
    expect(receiptIdsFor("s3")).toEqual(["r0", "r1", "r2"]);
    expect(result.candidates.some((candidate) => candidate.receiptId === "r3")).toBe(false);
    expect(result.statementResults.map((row) => row.status)).toEqual(["needs_review", "needs_review", "needs_review", "needs_review"]);
    // The assignment itself still chooses r3 for s3; it just cannot promote it.
    expect(inspectReconciliationRanking({ statements, receipts }).assignments).toEqual([
      { statementTransactionId: "s0", receiptId: "r0" },
      { statementTransactionId: "s1", receiptId: "r1" },
      { statementTransactionId: "s2", receiptId: "r2" },
      { statementTransactionId: "s3", receiptId: "r3" },
    ]);
  });

  it("keeps manual statements out of the review assignment and preserves automatic pairs", () => {
    const statements = [
      statement("s1", { merchant: "架空商店アルファ", amountYen: 1000 }),
      statement("s2", { merchant: "無関係カフェ", amountYen: 1000, preferredAccountIds: ["acct-1"] }),
    ];
    const receipts = [
      receipt("r1", { merchant: "架空商店アルファ", amountYen: 1000, actualAccountId: "acct-1" }),
      receipt("r2", { merchant: "架空商店アルファ", amountYen: 1000, purchasedDate: "2026-09-11", actualAccountId: "acct-2" }),
    ];
    const automatic = runReconciliationEngine({ statements: [statement("auto")], receipts: [receipt("auto-r")] });
    expect(automatic.statementResults[0]).toMatchObject({ status: "matched", matchedReceiptId: "auto-r" });
    expect(automatic.candidates[0]?.receiptId).toBe("auto-r");

    const manual = runReconciliationEngine({ statements, receipts, manualStatementIds: new Set(["s1"]) });
    expect(manual.candidates.filter((candidate) => candidate.statementTransactionId === "s1").map((candidate) => candidate.receiptId)).toEqual(["r1", "r2"]);
    expect(inspectReconciliationRanking({ statements, receipts, manualStatementIds: new Set(["s1"]) })).toEqual({
      assignments: [{ statementTransactionId: "s2", receiptId: "r1" }],
    });
  });
});
