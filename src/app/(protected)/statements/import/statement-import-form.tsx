"use client";

import { useRef, useState, type FormEvent } from "react";

const providers = [
  { value: "smbc_card", label: "三井住友カード" },
  { value: "rakuten_card", label: "楽天カード" },
  { value: "aeon_card", label: "イオンカード" },
  { value: "paypay", label: "PayPay" },
] as const;

type ImportIssue = { rowNumber: number | null; code: string };
type ImportSummary = {
  importedRows: number;
  duplicateRows: number;
  excludedRows: number;
  totalRows: number;
  issues: ImportIssue[];
};

export default function StatementImportForm() {
  const [provider, setProvider] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorIssues, setErrorIssues] = useState<ImportIssue[]>([]);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const inFlight = useRef(false);

  function updateFile(nextFile: File | null) {
    setFile(nextFile);
    setSummary(null);
    setErrorMessage(null);
    setErrorIssues([]);
    if (nextFile && !nextFile.name.toLowerCase().endsWith(".csv")) {
      setFile(null);
      setErrorMessage("CSVファイルを選んでください。");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!provider || !file || inFlight.current) return;

    inFlight.current = true;
    setIsUploading(true);
    setErrorMessage(null);
    setErrorIssues([]);
    setSummary(null);

    const formData = new FormData();
    formData.append("provider", provider);
    formData.append("file", file);
    try {
      const response = await fetch("/api/statements/import", { method: "POST", body: formData });
      const payload: unknown = await response.json();
      if (!response.ok) {
        setErrorMessage(readError(payload) ?? "明細を取り込めませんでした。ファイルを確認して、もう一度お試しください。");
        setErrorIssues(readIssues(payload));
        return;
      }
      const result = readSummary(payload);
      if (!result) {
        setErrorMessage("取り込み結果を確認できませんでした。もう一度お試しください。");
        return;
      }
      setSummary(result);
    } catch {
      setErrorMessage("通信に失敗しました。接続を確認して、もう一度お試しください。");
    } finally {
      inFlight.current = false;
      setIsUploading(false);
    }
  }

  return (
    <form className="statement-import-form" onSubmit={submit}>
      <label htmlFor="statement-provider">決済サービス</label>
      <select id="statement-provider" value={provider} onChange={(event) => { setProvider(event.currentTarget.value); setSummary(null); setErrorMessage(null); }} required disabled={isUploading}>
        <option value="">選択してください</option>
        {providers.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>

      <label htmlFor="statement-file">CSVファイル</label>
      <input id="statement-file" type="file" accept=".csv,text/csv" onChange={(event) => updateFile(event.currentTarget.files?.[0] ?? null)} required disabled={isUploading} />
      <p className="statement-import-hint">選択したサービスの明細CSVを指定してください。</p>

      <button className="button button-primary statement-import-submit" type="submit" disabled={!provider || !file || isUploading}>
        {isUploading ? "読み込み中…" : "明細を取り込む"}
      </button>
      {isUploading ? <p className="muted statement-import-progress" role="status" aria-live="polite">CSVを確認して取り込んでいます。画面を閉じずにお待ちください。</p> : null}

      {errorMessage ? <div className="statement-import-error" role="alert"><p>{errorMessage}</p><IssueList issues={errorIssues} /></div> : null}
      {summary ? (
        <section className="statement-import-result" aria-live="polite" aria-labelledby="statement-result-heading">
          <h2 id="statement-result-heading">取り込みが完了しました</h2>
          <p className="statement-import-count">{summary.importedRows}件を取り込みました</p>
          <dl className="statement-import-stats">
            <div><dt>重複</dt><dd>{summary.duplicateRows}件</dd></div>
            <div><dt>対象外</dt><dd>{summary.excludedRows}件</dd></div>
            <div><dt>ファイル内の明細</dt><dd>{summary.totalRows}件</dd></div>
          </dl>
          {summary.issues.length ? <><h3>取り込めなかった行</h3><IssueList issues={summary.issues} /></> : null}
        </section>
      ) : null}

    </form>
  );
}

function IssueList({ issues }: { issues: ImportIssue[] }) {
  if (issues.length === 0) return null;
  return <ul className="statement-import-issues">{issues.map((issue, index) => <li key={`${issue.rowNumber}-${issue.code}-${index}`}>{issue.rowNumber === null ? "ファイル: " : `行 ${issue.rowNumber}: `}{issueReason(issue.code)}</li>)}</ul>;
}

function issueReason(code: string): string {
  const known: Record<string, string> = {
    malformed_amount: "金額を読み取れませんでした",
    malformed_date: "日付を読み取れませんでした",
    unsupported_row: "内容を判定できないため取り込めませんでした",
    missing_merchant: "利用先を確認できませんでした",
    invalid_row: "明細の内容を確認できませんでした",
    unsupported_provider: "この決済サービスのCSV形式は確認中です。現在取り込めません",
    header_mismatch: "選択したサービスのCSV列名と一致しません",
    malformed_csv: "CSVの区切りや引用符を読み取れませんでした",
    invalid_file: "CSVとして読み取れませんでした",
    empty_file: "CSVファイルが空です",
    header_only: "CSVに明細行がありません",
    limit_exceeded: "ファイル、行、または項目の上限を超えています",
    duplicate_external_id_conflict: "同じ取引番号に異なる内容があります",
  };
  return known[code] ?? "明細の内容を確認できませんでした";
}

function readError(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("error" in value) || typeof value.error !== "string") return null;
  if (/[\u3040-\u30ff\u3400-\u9fff]/u.test(value.error)) return value.error;
  const known: Record<string, string> = {
    unsupported_provider: "この決済サービスの明細形式は現在取り込めません。",
    header_mismatch: "選択したサービスのCSV形式と一致しません。サービスとファイルを確認してください。",
    invalid_file: "CSVファイルを読み取れませんでした。ファイルの内容を確認してください。",
    file_too_large: "ファイルのサイズ上限を超えています。",
    unauthenticated: "ログイン状態を確認して、もう一度お試しください。",
  };
  return known[value.error] ?? null;
}

function readIssues(value: unknown): ImportIssue[] {
  if (!value || typeof value !== "object" || !("issues" in value) || !Array.isArray(value.issues)) return [];
  return value.issues.flatMap((item): ImportIssue[] => {
    if (!item || typeof item !== "object" || !("rowNumber" in item) || !("code" in item)) return [];
    if (item.rowNumber !== null && (typeof item.rowNumber !== "number" || !Number.isInteger(item.rowNumber))) return [];
    if (typeof item.code !== "string") return [];
    return [{ rowNumber: item.rowNumber, code: item.code }];
  });
}

function readSummary(value: unknown): ImportSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const keys = ["importedRows", "duplicateRows", "excludedRows", "totalRows"] as const;
  if (!keys.every((key) => typeof record[key] === "number" && Number.isInteger(record[key]) && record[key] >= 0)) return null;
  return {
    importedRows: record.importedRows as number,
    duplicateRows: record.duplicateRows as number,
    excludedRows: record.excludedRows as number,
    totalRows: record.totalRows as number,
    issues: readIssues(record),
  };
}
