import type { ReconciliationReceipt, ReconciliationStatement } from "../src/lib/reconciliation-engine";

export type ReconciliationEvalCase = {
  id: string;
  statements: ReconciliationStatement[];
  receipts: ReconciliationReceipt[];
  expectedMatches: Array<{ statementId: string; receiptId: string }>;
  expectedStatementStatuses: Record<string, "matched" | "needs_review" | "unmatched_statement">;
  expectedReceiptStatuses: Record<string, "matched" | "needs_review" | "unmatched_receipt">;
};

const statement = (id: string, merchant: string, amountYen: number, usedDate = "2026-09-29", kind: "purchase" | "refund" = "purchase"): ReconciliationStatement => ({
  statementTransactionId: id, provider: "synthetic", externalId: null, kind, usedDate, postedDate: null, merchant, amountYen, paymentMethod: null,
});
const receipt = (id: string, merchant: string, amountYen: number, purchasedDate = "2026-09-29"): ReconciliationReceipt => ({
  receiptId: id, actualTransactionId: `actual-${id}`, merchant, purchasedDate, amountYen, actualAccountId: `account-${id}`,
});
const pair = (id: string, sm: string, rm = sm, amount = 1280, sd = "2026-09-29", rd = sd): ReconciliationEvalCase => ({
  id, statements: [statement(`s-${id}`, sm, amount, sd)], receipts: [receipt(`r-${id}`, rm, amount, rd)],
  expectedMatches: [{ statementId: `s-${id}`, receiptId: `r-${id}` }],
  expectedStatementStatuses: { [`s-${id}`]: "matched" }, expectedReceiptStatuses: { [`r-${id}`]: "matched" },
});

/** Artificial records only. Each scenario runs in isolation so case order cannot affect results. */
export const reconciliationEvalDataset: ReconciliationEvalCase[] = [
  pair("exact-01", "青空食堂", "青空食堂", 1280),
  pair("exact-02", "みどり書店", "みどり書店", 2450),
  pair("exact-03", "架空スーパー", "架空スーパー", 5280),
  pair("nfkc-case-space", "ＡＢＣ Store", "abc   store", 980),
  pair("merchant-spacing", "青空 食堂", "青空食堂", 1680),
  pair("merchant-separator", "北口・商店", "北口商店", 750),
  pair("date-plus-1", "青空食堂", "青空食堂", 1280, "2026-09-29", "2026-09-30"),
  pair("date-minus-1", "青空食堂", "青空食堂", 1280, "2026-09-29", "2026-09-28"),
  pair("date-plus-2", "青空食堂", "青空食堂", 1280, "2026-09-29", "2026-10-01"),
  { id: "date-plus-3-review", statements: [statement("s-d3", "青空食堂", 1280)], receipts: [receipt("r-d3", "青空食堂", 1280, "2026-10-02")], expectedMatches: [], expectedStatementStatuses: { "s-d3": "needs_review" }, expectedReceiptStatuses: { "r-d3": "needs_review" } },
  { id: "date-plus-7-review", statements: [statement("s-d7", "青空食堂", 1280)], receipts: [receipt("r-d7", "青空食堂", 1280, "2026-10-06")], expectedMatches: [], expectedStatementStatuses: { "s-d7": "needs_review" }, expectedReceiptStatuses: { "r-d7": "needs_review" } },
  { id: "date-plus-8-no-candidate", statements: [statement("s-d8", "青空食堂", 1280)], receipts: [receipt("r-d8", "青空食堂", 1280, "2026-10-07")], expectedMatches: [], expectedStatementStatuses: { "s-d8": "unmatched_statement" }, expectedReceiptStatuses: { "r-d8": "unmatched_receipt" } },
  { id: "small-amount-delta", statements: [statement("s-delta", "青空食堂", 1280)], receipts: [receipt("r-delta", "青空食堂", 1230)], expectedMatches: [], expectedStatementStatuses: { "s-delta": "needs_review" }, expectedReceiptStatuses: { "r-delta": "needs_review" } },
  { id: "different-merchant-exact-amount", statements: [statement("s-unrelated", "山川電器", 1280)], receipts: [receipt("r-unrelated", "海辺書房", 1280)], expectedMatches: [], expectedStatementStatuses: { "s-unrelated": "needs_review" }, expectedReceiptStatuses: { "r-unrelated": "needs_review" } },
  { id: "large-amount-delta", statements: [statement("s-large", "青空食堂", 1280)], receipts: [receipt("r-large", "青空食堂", 980)], expectedMatches: [], expectedStatementStatuses: { "s-large": "unmatched_statement" }, expectedReceiptStatuses: { "r-large": "unmatched_receipt" } },
  { id: "same-date-merchant-amount-2x2", statements: [statement("s-dup-a", "青空食堂", 500), statement("s-dup-b", "青空食堂", 500)], receipts: [receipt("r-dup-a", "青空食堂", 500), receipt("r-dup-b", "青空食堂", 500)], expectedMatches: [], expectedStatementStatuses: { "s-dup-a": "needs_review", "s-dup-b": "needs_review" }, expectedReceiptStatuses: { "r-dup-a": "needs_review", "r-dup-b": "needs_review" } },
  { id: "one-receipt-two-statements", statements: [statement("s-one-a", "青空食堂", 500), statement("s-one-b", "青空食堂", 500)], receipts: [receipt("r-one", "青空食堂", 500)], expectedMatches: [], expectedStatementStatuses: { "s-one-a": "needs_review", "s-one-b": "needs_review" }, expectedReceiptStatuses: { "r-one": "needs_review" } },
  { id: "one-statement-two-receipts", statements: [statement("s-one", "青空食堂", 500)], receipts: [receipt("r-two-a", "青空食堂", 500), receipt("r-two-b", "青空食堂", 500)], expectedMatches: [], expectedStatementStatuses: { "s-one": "needs_review" }, expectedReceiptStatuses: { "r-two-a": "needs_review", "r-two-b": "needs_review" } },
  { id: "refund-not-supported", statements: [statement("s-refund", "青空食堂", 500, "2026-09-29", "refund")], receipts: [receipt("r-refund", "青空食堂", 500)], expectedMatches: [], expectedStatementStatuses: { "s-refund": "unmatched_statement" }, expectedReceiptStatuses: { "r-refund": "unmatched_receipt" } },
  { id: "no-receipt", statements: [statement("s-no-receipt", "山川電器", 5280)], receipts: [], expectedMatches: [], expectedStatementStatuses: { "s-no-receipt": "unmatched_statement" }, expectedReceiptStatuses: {} },
  { id: "no-statement", statements: [], receipts: [receipt("r-no-statement", "山川電器", 5280)], expectedMatches: [], expectedStatementStatuses: {}, expectedReceiptStatuses: { "r-no-statement": "unmatched_receipt" } },
  { id: "no-candidate-different-date-and-amount", statements: [statement("s-none", "青空食堂", 1000, "2026-09-01")], receipts: [receipt("r-none", "青空食堂", 3000, "2026-09-29")], expectedMatches: [], expectedStatementStatuses: { "s-none": "unmatched_statement" }, expectedReceiptStatuses: { "r-none": "unmatched_receipt" } },
  { id: "strong-unique-merchant-variant", statements: [statement("s-variant", "北口食堂", 1380)], receipts: [receipt("r-variant", "北口 食堂", 1380)], expectedMatches: [{ statementId: "s-variant", receiptId: "r-variant" }], expectedStatementStatuses: { "s-variant": "matched" }, expectedReceiptStatuses: { "r-variant": "matched" } },
  pair("exact-04", "湖畔ベーカリー", "湖畔ベーカリー", 690),
  pair("exact-05", "架空薬局", "架空薬局", 1560),
  pair("exact-06", "丘の上カフェ", "丘の上カフェ", 920),
  pair("exact-07", "駅前八百屋", "駅前八百屋", 2140),
  pair("exact-08", "南町クリニック", "南町クリニック", 3240),
  pair("exact-09", "つばさ文具", "つばさ文具", 870),
  pair("exact-10", "港町食堂", "港町食堂", 1740),
  pair("exact-11", "架空ホームセンター", "架空ホームセンター", 6980),
  pair("exact-12", "星空映画館", "星空映画館", 3600),
  { id: "ambiguous-near-pair", statements: [statement("s-near-a", "青空食堂", 500), statement("s-near-b", "青空食堂", 510)], receipts: [receipt("r-near-a", "青空食堂", 500), receipt("r-near-b", "青空食堂", 510)], expectedMatches: [], expectedStatementStatuses: { "s-near-a": "needs_review", "s-near-b": "needs_review" }, expectedReceiptStatuses: { "r-near-a": "needs_review", "r-near-b": "needs_review" } },
];
