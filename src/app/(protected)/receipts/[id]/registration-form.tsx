"use client";

import { useEffect, useState, type FormEvent } from "react";

type Extraction = {
  merchant: string | null;
  purchasedDate: string | null;
  totalAmountYen: number | null;
};
type Draft = {
  merchant: string;
  purchasedDate: string;
  totalAmountYen: number;
  actualAccountId: string | null;
  status: string;
  editable?: boolean;
};
type Account = { id: string; name: string };
type RegistrationResponse = { draft: Draft | null; accounts: Account[]; preferredAccountId: string | null };

export default function RegistrationForm({ receiptId, extraction, categoryConfirmed, onRegistered }: {
  receiptId: string;
  extraction: Extraction;
  categoryConfirmed: boolean;
  onRegistered: () => void;
}) {
  const [data, setData] = useState<RegistrationResponse | null>(null);
  const [merchant, setMerchant] = useState("");
  const [purchasedDate, setPurchasedDate] = useState("");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const encodedId = encodeURIComponent(receiptId);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/receipts/${encodedId}/registration`, { cache: "no-store" });
        if (!response.ok) throw new Error("load_failed");
        const parsed = parseRegistration(await response.json());
        if (!parsed) throw new Error("invalid_response");
        if (cancelled) return;
        setData(parsed);
        const draft = parsed.draft;
        setMerchant(draft?.merchant ?? extraction.merchant ?? "");
        setPurchasedDate(draft?.purchasedDate ?? extraction.purchasedDate ?? "");
        setAmount(String(draft?.totalAmountYen ?? extraction.totalAmountYen ?? ""));
        setAccountId(draft?.actualAccountId && parsed.accounts.some((a) => a.id === draft.actualAccountId)
          ? draft.actualAccountId
          : parsed.preferredAccountId && parsed.accounts.some((a) => a.id === parsed.preferredAccountId)
            ? parsed.preferredAccountId : "");
        setRegistered(draft?.status === "registered");
        if (draft?.status === "registered") onRegistered();
      } catch {
        if (!cancelled) setError("登録に必要な情報を読み込めませんでした。時間をおいて再読み込みしてください。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [encodedId, extraction.merchant, extraction.purchasedDate, extraction.totalAmountYen, onRegistered]);

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || registered || !categoryConfirmed || !accountId) return;
    const yen = Number(amount);
    if (!Number.isSafeInteger(yen) || yen <= 0) {
      setError("金額は1円以上の整数で入力してください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/receipts/${encodedId}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchant: merchant.trim(), purchasedDate, totalAmountYen: yen, actualAccountId: accountId }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        if (hasErrorCode(body, "category_mapping_required")) {
          setError("カテゴリの連携設定が必要です。管理者に確認してください。");
          return;
        }
        if (hasErrorCode(body, "account_unavailable")) {
          setError("選択した支払元を利用できません。もう一度選択してください。");
          return;
        }
        throw new Error("register_failed");
      }
      if (!isSuccess(body)) throw new Error("register_failed");
      setRegistered(true);
      onRegistered();
    } catch {
      setError("家計簿に登録できませんでした。入力内容は保存されています。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="receipt-review-status" role="status">登録内容を確認しています…</p>;
  if (registered) return <p className="receipt-registration-success" role="status">家計簿に登録しました</p>;
  if (!data) return <p className="receipt-registration-error" role="alert">{error}</p>;
  const editable = data.draft?.editable !== false;

  return (
    <form className="receipt-registration" onSubmit={(event) => void register(event)}>
      <h2>登録内容</h2>
      <label htmlFor="registration-merchant">店名</label>
      <input id="registration-merchant" type="text" autoComplete="organization" maxLength={200} required disabled={!editable} value={merchant} onChange={(event) => setMerchant(event.target.value)} />
      <label htmlFor="registration-date">日付</label>
      <input id="registration-date" type="date" required disabled={!editable} value={purchasedDate} onChange={(event) => setPurchasedDate(event.target.value)} />
      <label htmlFor="registration-amount">金額（円）</label>
      <input id="registration-amount" type="number" inputMode="numeric" min="1" step="1" required disabled={!editable} value={amount} onChange={(event) => setAmount(event.target.value)} />
      <label htmlFor="registration-account">支払元</label>
      <select id="registration-account" required disabled={!editable} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
        <option value="">口座を選択してください</option>
        {data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
      </select>
      {!editable ? <p className="receipt-registration-hint">前回の登録結果を確認します。保存済みの内容で再試行してください。</p> : null}
      {!categoryConfirmed ? <p className="receipt-registration-hint" role="status">先にカテゴリを確認して保存してください。</p> : null}
      {data.accounts.length === 0 ? <p className="receipt-registration-hint" role="status">選択できる支払元がありません。</p> : null}
      {error ? <p className="receipt-registration-error" role="alert">{error}</p> : null}
      <button className="button button-primary receipt-registration-submit" type="submit" disabled={busy || !categoryConfirmed || data.accounts.length === 0}>
        {busy ? "登録中…" : "家計簿に登録"}
      </button>
    </form>
  );
}

function parseRegistration(value: unknown): RegistrationResponse | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Partial<RegistrationResponse>;
  if (!Array.isArray(body.accounts) || !body.accounts.every((a) => !!a && typeof a.id === "string" && typeof a.name === "string")
    || !(body.preferredAccountId === null || typeof body.preferredAccountId === "string")) return null;
  if (body.draft !== null && body.draft !== undefined) {
    const d = body.draft;
    if (!d || typeof d.merchant !== "string" || typeof d.purchasedDate !== "string" || !Number.isSafeInteger(d.totalAmountYen)
      || !(d.actualAccountId === null || typeof d.actualAccountId === "string") || typeof d.status !== "string") return null;
  }
  return body as RegistrationResponse;
}

function isSuccess(value: unknown): value is { status: "registered" } {
  return !!value && typeof value === "object" && (value as { status?: unknown }).status === "registered";
}

function hasErrorCode(value: unknown, code: string): boolean {
  return !!value && typeof value === "object" && (value as { code?: unknown }).code === code;
}
