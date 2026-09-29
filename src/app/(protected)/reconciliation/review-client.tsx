"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { formatYen } from "@/lib/ledger-format";
import { isApplyError, orderReviewItems, reasonLabel, type ReconciliationReview as ReviewData, type ReviewItem } from "./reconciliation-view-model";

export default function ReconciliationReview() {
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch("/api/reconciliation/review", { cache: "no-store" });
      if (!response.ok) throw new Error("load_failed");
      const value: unknown = await response.json();
      if (value === null) { setData(null); return; }
      if (!isReviewData(value)) throw new Error("invalid_response");
      setData(value);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function post(path: string, payload: Record<string, unknown>, key: string) {
    if (busyKey) return;
    setBusyKey(key);
    setActionError(null);
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const code = getErrorCode(body);
        if (code === "stale_run") throw new Error("stale");
        if (code === "actual_apply_failed" || code === "resolution_failed") {
          setActionError("家計簿への反映に失敗しました。判断内容は保存されています。もう一度お試しください。");
          await reload();
          return;
        }
        throw new Error("action_failed");
      }
      await reload();
    } catch (error) {
      setActionError(error instanceof Error && error.message === "stale"
        ? "照合結果が更新されています。画面を更新してください。"
        : "処理を完了できませんでした。時間をおいてもう一度お試しください。");
      if (error instanceof Error && error.message === "stale") await reload();
    } finally {
      setBusyKey(null);
    }
  }

  const orderedItems = useMemo(() => data ? orderReviewItems(data.items) : [], [data]);
  if (loading && !data) return <div className="page-content"><p role="status">照合結果を読み込んでいます…</p></div>;
  if (loadError && !data) return <div className="page-content"><section className="notice notice-error" role="alert"><h1>照合結果を読み込めませんでした</h1><button className="button button-secondary" onClick={() => void reload()}>再読み込み</button></section></div>;

  return (
    <div className="page-content reconciliation-page">
      <section className="page-intro"><p className="eyebrow">照合</p><h1>明細の確認</h1>
        {data ? <p className="muted">{formatCompletedDate(data.completedAt)}</p> : null}
      </section>
      {actionError ? <p className="reconciliation-error" role="alert">{actionError}</p> : null}
      {data ? <>
        <section className="reconciliation-summary" aria-label="照合結果の件数">
          <SummaryLine label="要確認" count={data.summary.needsReview} />
          <SummaryLine label="記録なし" count={data.summary.unmatchedStatement} />
          <SummaryLine label="自動確認済み" count={data.summary.automatic} />
          {data.summary.unmatchedReceipt > 0 ? <p className="muted reconciliation-waiting">明細待ち {data.summary.unmatchedReceipt}件</p> : null}
        </section>
        <button className="button button-secondary" disabled={!!busyKey} onClick={() => void post("/api/reconciliation/run", {}, "run")}>{busyKey === "run" ? "照合中…" : "照合を更新"}</button>
        {data.items.length === 0 ? <p className="empty-state">確認が必要な明細はありません。</p> : null}
        <section aria-label="確認が必要な明細" className="reconciliation-queue">
          {orderedItems.map((item) => <ReviewRow key={item.statementTransactionId} item={item} data={data}
            expanded={expanded === item.statementTransactionId} onExpand={() => setExpanded(expanded === item.statementTransactionId ? null : item.statementTransactionId)}
            busy={busyKey?.startsWith(item.statementTransactionId) ?? false}
            onPost={post} />)}
        </section>
      </> : <section className="empty-state"><p>照合結果がまだありません。</p><button className="button button-primary" disabled={!!busyKey} onClick={() => void post("/api/reconciliation/run", {}, "run")}>{busyKey ? "照合中…" : "明細を照合する"}</button></section>}
      {loading && data ? <p role="status" className="muted">更新しています…</p> : null}
    </div>
  );
}

function SummaryLine({ label, count }: { label: string; count: number }) {
  return <div className="reconciliation-summary-line"><span>{label}</span><strong>{count}件</strong></div>;
}

function ReviewRow({ item, data, expanded, onExpand, busy, onPost }: {
  item: ReviewItem; data: ReviewData; expanded: boolean; onExpand: () => void; busy: boolean;
  onPost: (path: string, payload: Record<string, unknown>, key: string) => Promise<void>;
}) {
  const failed = isApplyError(item);
  const title = failed ? "反映エラー" : item.resolution ? "反映待ち" : item.status === "needs_review" ? "要確認" : "記録なし";
  const canResolveAsExpense = item.statement.kind === "purchase";
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const currentCandidate = item.candidates[0];

  function noReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!categoryId || !accountId) { setFormError("カテゴリと支払元を選んでください。"); return; }
    setFormError(null);
    void onPost("/api/reconciliation/resolve/no-receipt", {
      runId: data.runId, statementTransactionId: item.statementTransactionId, categoryId, actualAccountId: accountId,
    }, `${item.statementTransactionId}:no-receipt`);
  }

  return <article className="reconciliation-item">
    <button type="button" className="reconciliation-item-toggle" aria-expanded={expanded} onClick={onExpand}>
      <span className="reconciliation-item-main"><span className="reconciliation-item-status">{title}</span><strong>{item.statement.merchant || "店名なし"}</strong>
        <span>{formatDate(item.statement.usedDate)}・{formatYen(item.statement.amountYen)}</span></span>
      <span aria-hidden="true">{expanded ? "閉じる" : "詳細"}</span>
    </button>
    {expanded ? <div className="reconciliation-detail">
      {failed ? <p className="reconciliation-error" role="alert">家計簿への反映に失敗しました。判断内容は保存されています。もう一度お試しください。</p> : null}
      {item.resolution && !failed ? <p className="muted">判断内容は保存されています。家計簿への反映を確認してください。</p> : null}
      <section className="reconciliation-side"><h2>カード明細</h2><dl className="detail-list">
        <div><dt>日付</dt><dd>{formatDate(item.statement.usedDate)}</dd></div><div><dt>店名</dt><dd>{item.statement.merchant || "店名なし"}</dd></div>
        <div><dt>金額</dt><dd>{formatYen(item.statement.amountYen)}</dd></div><div><dt>サービス</dt><dd>{providerLabel(item.statement.provider)}</dd></div>
      </dl>{item.candidates.length || item.statement.kind === "refund" ? visibleReasons(item.reasonCodes).map((reason) => <p className="muted" key={reason}>{reason}</p>) : null}</section>
      {currentCandidate ? <section className="reconciliation-side"><h2>レシート候補</h2><dl className="detail-list">
        <div><dt>日付</dt><dd>{formatDate(currentCandidate.purchasedDate)}</dd></div><div><dt>店名</dt><dd>{currentCandidate.merchant}</dd></div>
        <div><dt>金額</dt><dd>{formatYen(currentCandidate.amountYen)}</dd></div>
      </dl><p className="reconciliation-difference">{currentCandidate.dateDistanceDays === 0 ? "同じ日付です" : `日付差 ${currentCandidate.dateDistanceDays}日`}</p>
        <p className="reconciliation-difference">{currentCandidate.amountDeltaYen === 0 ? "金額差なし" : `金額差 ${formatYen(currentCandidate.amountDeltaYen)}`}</p>
        {visibleReasons(currentCandidate.reasons).map((reason) => <p className="muted" key={reason}>{reason}</p>)}
        {!item.resolution ? <div className="reconciliation-actions">
          <button className="button button-primary" disabled={busy || !canResolveAsExpense} onClick={() => void onPost("/api/reconciliation/resolve/same-expense", {
            runId: data.runId, statementTransactionId: item.statementTransactionId, receiptId: currentCandidate.receiptId,
          }, `${item.statementTransactionId}:same`)}>{busy ? "処理中…" : "同じ支出"}</button>
          <button className="button button-secondary" disabled={busy} onClick={() => void onPost("/api/reconciliation/reject-candidate", {
            runId: data.runId, statementTransactionId: item.statementTransactionId, receiptId: currentCandidate.receiptId,
          }, `${item.statementTransactionId}:reject`)}>別の支出</button>
        </div> : null}
      </section> : <p className="empty-state">記録が見つかりません。</p>}
      {!currentCandidate && canResolveAsExpense && !item.resolution ? <form className="reconciliation-no-receipt" onSubmit={noReceipt}>
        <h2>自分の利用・レシートなし</h2>
        {data.accountError ? <p className="form-error" role="alert">支払元を取得できませんでした。時間をおいて照合画面を開き直してください。</p> : null}
        <label htmlFor={`category-${item.statementTransactionId}`}>カテゴリ</label>
        <select id={`category-${item.statementTransactionId}`} required value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">選択してください</option>{data.categories.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select>
        <label htmlFor={`account-${item.statementTransactionId}`}>支払元</label>
        <select id={`account-${item.statementTransactionId}`} required value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">選択してください</option>{data.accounts.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select>
        {formError ? <p className="form-error" role="alert">{formError}</p> : null}
        <button className="button button-primary" disabled={busy || data.categories.length === 0 || data.accounts.length === 0}>{busy ? "登録中…" : "家計簿に登録"}</button>
      </form> : null}
      {item.resolution ? <button className="button button-secondary reconciliation-retry" disabled={busy} onClick={() => void onPost(`/api/reconciliation/resolutions/${encodeURIComponent(item.resolution!.id)}/retry`, { runId: data.runId }, `${item.statementTransactionId}:retry`)}>もう一度試す</button> : null}
    </div> : null}
  </article>;
}

function visibleReasons(codes: string[]): string[] { return codes.map(reasonLabel).filter((label): label is string => label !== null); }
function providerLabel(provider: string): string { return ({ paypay: "PayPay", smbc_card: "三井住友カード", rakuten_card: "楽天カード", aeon: "イオンカード", aeon_card: "イオンカード" } as Record<string, string>)[provider] ?? "カード明細"; }
function formatDate(value: string): string { const [, month, day] = value.split("-"); return `${Number(month)}/${Number(day)}`; }
function formatCompletedDate(value: string): string { return `照合日 ${new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(new Date(value))}`; }
function getErrorCode(value: unknown): string | null { return !!value && typeof value === "object" && typeof (value as { code?: unknown }).code === "string" ? (value as { code: string }).code : null; }
function isReviewData(value: unknown): value is ReviewData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReviewData>;
  return typeof candidate.runId === "string" && !!candidate.summary && Array.isArray(candidate.items)
    && Array.isArray(candidate.categories) && Array.isArray(candidate.accounts);
}
