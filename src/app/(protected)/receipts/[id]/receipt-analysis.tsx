"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CATEGORY_IDS, CATEGORY_LABELS, isCategoryId, type CategoryId } from "@/lib/category";
import RegistrationForm from "./registration-form";

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
type CategoryState = {
  suggestedCategory: CategoryId | null;
  source: "merchant_rule" | "jev" | "user" | "unclassified";
  needsReview: boolean;
  confirmedCategory: CategoryId | null;
  attemptedAt: string | null;
};

const failureMessage = "レシートを読み取れませんでした。画像は保存されています。もう一度お試しください。";

export default function ReceiptAnalysis({ receiptId }: { receiptId: string }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<CategoryState | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<CategoryId | "">("");
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [registrationDone, setRegistrationDone] = useState(false);
  const activeRequest = useRef(false);
  const autoStarted = useRef(false);
  const encodedId = encodeURIComponent(receiptId);
  const markRegistrationDone = useCallback(() => setRegistrationDone(true), []);

  const loadCategory = useCallback(async (classifyIfNeeded: boolean, forceClassification = false) => {
    try {
      const response = await fetch(`/api/receipts/${encodedId}/category`, { cache: "no-store" });
      if (!response.ok) throw new Error("category_unavailable");
      let next = parseCategoryState(await response.json());
      if (!next) throw new Error("invalid_category");
      if (classifyIfNeeded && !next.confirmedCategory && (forceClassification || !next.attemptedAt)) {
        const classified = await fetch(`/api/receipts/${encodedId}/classify-category`, { method: "POST" });
        if (!classified.ok) throw new Error("classification_unavailable");
        const parsed = parseCategoryState(await classified.json());
        if (!parsed) throw new Error("invalid_category");
        next = parsed;
      }
      setCategory(next);
      setSelectedCategory(next.confirmedCategory ?? next.suggestedCategory ?? "");
      setCategoryError(null);
    } catch {
      setCategoryError("カテゴリを読み込めませんでした。時間をおいて再読み込みしてください。");
    }
  }, [encodedId]);

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
        if (next.status === "succeeded" && next.result?.documentKind === "receipt") {
          await loadCategory(true, true);
        }
      } else {
        setError(failureMessage);
      }
    } catch {
      setError(failureMessage);
    } finally {
      setLoading(false);
      activeRequest.current = false;
    }
  }, [encodedId, loadCategory]);

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
        if (current.status === "succeeded" && current.result?.documentKind === "receipt") {
          void loadCategory(true);
        }
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
  }, [encodedId, loadCategory, runAnalysis]);

  async function saveCategory() {
    if (!selectedCategory || categoryBusy) return;
    setCategoryBusy(true);
    setCategoryError(null);
    try {
      const response = await fetch(`/api/receipts/${encodedId}/category`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ categoryId: selectedCategory }),
      });
      if (!response.ok) throw new Error("category_save_failed");
      const saved = parseCategoryState(await response.json());
      if (!saved) throw new Error("invalid_category");
      setCategory(saved);
      setSelectedCategory(saved.confirmedCategory ?? selectedCategory);
    } catch {
      setCategoryError("カテゴリを保存できませんでした。もう一度お試しください。");
    } finally {
      setCategoryBusy(false);
    }
  }

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
          {result.documentKind === "receipt" ? (
            <CategoryPicker
              category={category}
              selected={selectedCategory}
              busy={categoryBusy}
              disabled={registrationDone}
              error={categoryError}
              onSelect={setSelectedCategory}
              onSave={() => void saveCategory()}
            />
          ) : null}
          {result.documentKind === "receipt" ? (
            <RegistrationForm
              receiptId={receiptId}
              extraction={result}
              categoryConfirmed={category?.confirmedCategory !== null && category?.confirmedCategory !== undefined}
              onRegistered={markRegistrationDone}
            />
          ) : null}
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
          <p className="receipt-category-hint">前回読み取れた内容です。カテゴリを確認するには、もう一度読み取ってください。</p>
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

function parseCategoryState(value: unknown): CategoryState | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Partial<CategoryState>;
  const validCategory = (candidate: unknown): candidate is CategoryId | null => candidate === null || isCategoryId(candidate);
  if (!validCategory(body.suggestedCategory) || !validCategory(body.confirmedCategory)
    || !(body.source === "merchant_rule" || body.source === "jev" || body.source === "user" || body.source === "unclassified")
    || typeof body.needsReview !== "boolean"
    || !(body.attemptedAt === null || typeof body.attemptedAt === "string")) return null;
  return body as CategoryState;
}

function CategoryPicker({ category, selected, busy, disabled, error, onSelect, onSave }: {
  category: CategoryState | null;
  selected: CategoryId | "";
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onSelect: (value: CategoryId | "") => void;
  onSave: () => void;
}) {
  if (!category) return error ? <p className="notice notice-error" role="alert">{error}</p> : <p className="receipt-review-status" role="status">カテゴリを確認しています…</p>;
  const confirmed = category.confirmedCategory !== null;
  const suggestionLabel = category.source === "merchant_rule" ? "いつもの店の設定から提案" : category.source === "jev" ? "自動提案" : null;
  return (
    <section className="receipt-category" aria-labelledby="receipt-category-title">
      <h2 id="receipt-category-title">カテゴリ</h2>
      {suggestionLabel ? <p className="receipt-category-hint">{suggestionLabel}</p> : null}
      {category.needsReview && !confirmed ? <p className="receipt-category-hint" role="status">確認してください</p> : null}
      <label className="visually-hidden" htmlFor="receipt-category-select">カテゴリを選択</label>
      <select id="receipt-category-select" value={selected} disabled={busy || disabled} onChange={(event) => onSelect(event.target.value as CategoryId | "")}>
        <option value="">未分類</option>
        {CATEGORY_IDS.map((id) => <option key={id} value={id}>{CATEGORY_LABELS[id]}</option>)}
      </select>
      {confirmed && selected === category.confirmedCategory ? <p className="receipt-category-hint" role="status">カテゴリを保存しました</p> : null}
      {!disabled ? <button className="button button-primary receipt-category-save" type="button" disabled={!selected || busy || selected === category.confirmedCategory} onClick={onSave}>
        {busy ? "保存中…" : confirmed ? "変更を保存" : "カテゴリを保存"}
      </button> : null}
      {error ? <p className="receipt-category-error" role="alert">{error}</p> : null}
    </section>
  );
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
