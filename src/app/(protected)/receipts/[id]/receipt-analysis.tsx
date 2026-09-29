"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type Warning = { field: string | null; code: string; message: string };
type ReceiptItem = { name: string; amountYen: number | null };
type Extraction = {
  documentKind: "receipt" | "not_receipt" | "unknown";
  merchant: string | null;
  purchasedDate: string | null;
  purchasedTime: string | null;
  totalAmountYen: number | null;
  taxAmountYen: number | null;
  items: ReceiptItem[];
  warnings: Warning[];
};
type Analysis = {
  status: "not_started" | "processing" | "succeeded" | "failed";
  model: string | null;
  promptVersion: string | null;
  result: Extraction | null;
  needsReview: boolean | null;
  lastErrorCode: string | null;
  attemptedAt: string | null;
  succeededAt: string | null;
};

const failureMessage = "レシートを読み取れませんでした。画像は保存されています。もう一度お試しください。";

export default function ReceiptAnalysis({ receiptId }: { receiptId: string }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeRequest = useRef(false);
  const autoStarted = useRef(false);
  const encodedId = encodeURIComponent(receiptId);

  const runAnalysis = useCallback(async () => {
    if (activeRequest.current) return;
    activeRequest.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/receipts/${encodedId}/analyze`, { method: "POST" });
      const body: unknown = await response.json();
      const next = parseAnalysis(body);
      if (next) {
        setAnalysis(next);
        if (next.status === "failed") setError(failureMessage);
      } else {
        setError(failureMessage);
      }
    } catch {
      setError(failureMessage);
    } finally {
      setLoading(false);
      activeRequest.current = false;
    }
  }, [encodedId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      let autoAnalyze = false;
      try {
        const response = await fetch(`/api/receipts/${encodedId}/analysis`, { cache: "no-store" });
        if (response.status === 404) {
          if (!cancelled) setError("レシートを表示できませんでした。");
          return;
        }
        if (!response.ok) throw new Error("analysis_unavailable");
        const body: unknown = await response.json();
        const current = parseAnalysis(body);
        if (!current) throw new Error("invalid_analysis");
        if (cancelled) return;
        setAnalysis(current);
        if (current.status === "not_started") {
          if (!autoStarted.current) {
            autoStarted.current = true;
            autoAnalyze = true;
            void runAnalysis();
          }
        } else if (current.status === "failed") {
          setError(failureMessage);
        }
      } catch {
        if (!cancelled) setError("レシートの読み取り状態を確認できませんでした。時間をおいて再読み込みしてください。");
      } finally {
        if (!cancelled && !autoAnalyze) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [encodedId, runAnalysis]);

  const result = analysis?.result;
  const notReceipt = result?.documentKind === "not_receipt";

  return (
    <section className="receipt-review" aria-label="レシート読み取り結果">
      <img className="receipt-preview receipt-detail-image" src={`/api/receipts/${encodedId}/image`} alt="保存したレシート" />

      {loading ? (
        <p className="receipt-review-status" role="status" aria-live="polite">レシートを読み取っています…</p>
      ) : null}
      {!loading && analysis?.status === "processing" ? <p className="receipt-review-status" role="status">レシートを読み取っています…</p> : null}
      {error ? (
        <div className="notice notice-error receipt-review-notice" role="alert">
          <p>{error}</p>
          {error !== "レシートを表示できませんでした。" ? (
            <button className="button button-primary receipt-retry" type="button" disabled={loading} onClick={() => void runAnalysis()}>
              もう一度読み取る
            </button>
          ) : null}
        </div>
      ) : null}

      {notReceipt ? (
        <div className="notice notice-error receipt-review-notice">
          <p>レシートとして読み取れませんでした。別の画像を選ぶか、撮り直してください。</p>
          <Link className="text-link" href="/receipts/new">別の画像を選ぶ</Link>
        </div>
      ) : null}
      {analysis?.status === "succeeded" && result && !notReceipt ? (
        <>
          {analysis.needsReview || result.documentKind === "unknown" ? <p className="notice receipt-review-notice">一部を確認してください。</p> : null}
          <dl className="detail-list receipt-result-list">
            <div><dt>店名</dt><dd>{result.merchant ?? "読み取れませんでした"}</dd></div>
            <div><dt>日付・時刻</dt><dd>{[result.purchasedDate, result.purchasedTime].filter(Boolean).join(" ") || "読み取れませんでした"}</dd></div>
            <div><dt>合計金額</dt><dd>{result.totalAmountYen === null ? "読み取れませんでした" : formatYen(result.totalAmountYen)}</dd></div>
            {result.taxAmountYen !== null ? <div><dt>税</dt><dd>{formatYen(result.taxAmountYen)}</dd></div> : null}
          </dl>
          {result.warnings.length > 0 ? (
            <section className="receipt-warnings" aria-labelledby="receipt-warnings-title">
              <h2 id="receipt-warnings-title">要確認事項</h2>
              <ul>{result.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul>
            </section>
          ) : null}
          {result.items.length > 0 ? (
            <details className="receipt-items">
              <summary>商品明細を表示</summary>
              <ul>{result.items.map((item, index) => <li key={`${item.name}-${index}`}><span>{item.name}</span><span>{item.amountYen === null ? "金額不明" : formatYen(item.amountYen)}</span></li>)}</ul>
            </details>
          ) : null}
          <button className="button button-secondary receipt-retry" type="button" disabled={loading} onClick={() => void runAnalysis()}>
            {loading ? "読み取り中…" : "もう一度読み取る"}
          </button>
        </>
      ) : null}
      {analysis?.status === "succeeded" && result && notReceipt ? (
        <button className="button button-primary receipt-retry" type="button" disabled={loading} onClick={() => void runAnalysis()}>
          {loading ? "読み取り中…" : "もう一度読み取る"}
        </button>
      ) : null}
      {analysis?.status === "failed" && result && !notReceipt ? (
        <>
          <p className="muted">前回読み取れた内容を表示しています。</p>
          <dl className="detail-list receipt-result-list">
            <div><dt>店名</dt><dd>{result.merchant ?? "読み取れませんでした"}</dd></div>
            <div><dt>日付・時刻</dt><dd>{[result.purchasedDate, result.purchasedTime].filter(Boolean).join(" ") || "読み取れませんでした"}</dd></div>
            <div><dt>合計金額</dt><dd>{result.totalAmountYen === null ? "読み取れませんでした" : formatYen(result.totalAmountYen)}</dd></div>
            {result.taxAmountYen !== null ? <div><dt>税</dt><dd>{formatYen(result.taxAmountYen)}</dd></div> : null}
          </dl>
          {result.warnings.length > 0 ? <section className="receipt-warnings"><h2>要確認事項</h2><ul>{result.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul></section> : null}
        </>
      ) : null}
    </section>
  );
}

function parseAnalysis(value: unknown): Analysis | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Partial<Analysis>;
  if (!(body.status === "not_started" || body.status === "processing" || body.status === "succeeded" || body.status === "failed")) return null;
  if (body.result !== null && body.result !== undefined && !isExtraction(body.result)) return null;
  return body as Analysis;
}

function isExtraction(value: unknown): value is Extraction {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<Extraction>;
  return (result.documentKind === "receipt" || result.documentKind === "not_receipt" || result.documentKind === "unknown")
    && (result.merchant === null || typeof result.merchant === "string")
    && (result.purchasedDate === null || typeof result.purchasedDate === "string")
    && (result.purchasedTime === null || typeof result.purchasedTime === "string")
    && (result.totalAmountYen === null || Number.isInteger(result.totalAmountYen))
    && (result.taxAmountYen === null || Number.isInteger(result.taxAmountYen))
    && Array.isArray(result.items)
    && Array.isArray(result.warnings)
    && result.warnings.every((warning) => !!warning && typeof warning === "object"
      && typeof warning.code === "string" && typeof warning.message === "string"
      && (warning.field === null || typeof warning.field === "string"));
}

function formatYen(amount: number): string {
  return new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(amount);
}
