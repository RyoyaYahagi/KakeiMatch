export type ReviewStatus = "matched" | "needs_review" | "unmatched_statement";

export type ReviewItem = {
  statementTransactionId: string;
  status: ReviewStatus;
  statement: { kind: "purchase" | "refund"; usedDate: string; merchant: string; amountYen: number; provider: string };
  reasonCodes: string[];
  candidates: Array<{ receiptId: string; merchant: string; purchasedDate: string; amountYen: number; amountDeltaYen: number; dateDistanceDays: number; reasons: string[] }>;
  resolution?: { id: string; status: string; resolution: string; source: string; lastErrorCode: string | null } | null;
};

export type ReconciliationReview = {
  runId: string;
  completedAt: string;
  summary: { automatic: number; needsReview: number; unmatchedStatement: number; unmatchedReceipt: number; failed: number };
  items: ReviewItem[];
  categories: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; name: string }>;
  accountError?: boolean;
};

export function isApplyError(item: ReviewItem): boolean { return item.resolution?.status === "failed"; }

export function orderReviewItems(items: ReviewItem[]): ReviewItem[] {
  const priority: Record<ReviewStatus, number> = { matched: 3, needs_review: 1, unmatched_statement: 2 };
  return [...items].sort((a, b) => {
    const rankA = isApplyError(a) ? 0 : priority[a.status];
    const rankB = isApplyError(b) ? 0 : priority[b.status];
    return rankA - rankB || a.statement.usedDate.localeCompare(b.statement.usedDate);
  });
}

const reasonLabels: Record<string, string> = {
  amount_exact: "金額が一致しています", amount_close: "金額に差があります",
  date_close: "日付が近いです", date_within_window: "日付が照合範囲内です",
  merchant_similar: "店名が似ています", merchant_alias_match: "登録済みの店名表記と一致しています",
  ambiguous_candidates: "候補が複数あります", candidate_requires_review: "確認が必要な候補があります",
  no_candidate: "記録が見つかりません", refund_not_supported: "返金の記録です。現在は自動処理できません。",
};
export function reasonLabel(code: string): string | null { return reasonLabels[code] ?? null; }
