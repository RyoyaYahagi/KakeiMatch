"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxFileSize = 10 * 1024 * 1024;

type UploadState = "ready" | "uploading" | "saved";

export default function ReceiptUploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [state, setState] = useState<UploadState>("ready");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const uploadInProgress = useRef(false);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }

    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function chooseFile(nextFile: File | null) {
    setErrorMessage(null);
    setSavedId(null);
    setState("ready");
    if (!nextFile) return;

    if (!allowedTypes.has(nextFile.type)) {
      setFile(null);
      setErrorMessage("JPEG・PNG・WebP形式の画像を選んでください。HEIC形式には対応していません。");
      return;
    }
    if (nextFile.size > maxFileSize) {
      setFile(null);
      setErrorMessage("画像のサイズは10 MiB以下にしてください。");
      return;
    }
    setFile(nextFile);
  }

  async function upload() {
    if (!file || uploadInProgress.current) return;
    uploadInProgress.current = true;
    setState("uploading");
    setErrorMessage(null);

    const formData = new FormData();
    formData.append("image", file);
    try {
      const response = await fetch("/api/receipts", { method: "POST", body: formData });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = getApiError(result);
        throw new Error(message ?? "レシートを保存できませんでした。もう一度お試しください。");
      }
      const id = getReceiptId(result);
      if (!id) throw new Error("保存結果を確認できませんでした。もう一度お試しください。");
      setSavedId(id);
      setState("saved");
    } catch (error) {
      setState("ready");
      setErrorMessage(error instanceof Error && error.message ? error.message : "通信に失敗しました。接続を確認して、もう一度お試しください。");
    } finally {
      uploadInProgress.current = false;
    }
  }

  return (
    <section className="receipt-upload" aria-label="レシート画像">
      {state === "saved" && savedId ? (
        <div className="receipt-saved" role="status" aria-live="polite">
          <p className="receipt-success-message">レシートを保存しました</p>
          <img className="receipt-preview receipt-saved-preview" src={`/api/receipts/${encodeURIComponent(savedId)}/image`} alt="保存したレシート" />
          <Link className="text-link" href="/">ホームへ戻る</Link>
        </div>
      ) : (
        <>
          <div className="receipt-file-actions">
            <label className={`button ${file ? "button-secondary" : "button-primary"} receipt-file-button`} htmlFor="receipt-camera">写真を撮る</label>
            <input
              className="visually-hidden"
              id="receipt-camera"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              onChange={(event) => chooseFile(event.currentTarget.files?.[0] ?? null)}
            />
            <label className="button button-secondary receipt-file-button" htmlFor="receipt-picker">写真を選ぶ</label>
            <input
              className="visually-hidden"
              id="receipt-picker"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => chooseFile(event.currentTarget.files?.[0] ?? null)}
            />
          </div>
          <p className="receipt-file-hint">JPEG・PNG・WebP、10 MiBまで</p>

          {previewUrl ? (
            <div className="receipt-preview-wrap">
              <img className="receipt-preview" src={previewUrl} alt="選択したレシートのプレビュー" />
            </div>
          ) : null}

          {errorMessage ? <p className="form-error receipt-error" role="alert">{errorMessage}</p> : null}

          {file ? (
            <button className="button button-primary receipt-save-button" type="button" disabled={state === "uploading"} onClick={upload}>
              {state === "uploading" ? "保存中…" : "レシートを保存"}
            </button>
          ) : null}
          {state === "uploading" ? <p className="muted receipt-uploading" role="status" aria-live="polite">画像を保存しています。画面を閉じずにお待ちください。</p> : null}
        </>
      )}
    </section>
  );
}

function getApiError(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("error" in value) || typeof value.error !== "string") return null;
  const error = value.error.toLowerCase();
  if (error.includes("unsupported") || error.includes("format") || error.includes("type")) return "この画像形式には対応していません。JPEG・PNG・WebP形式を選んでください。";
  if (error.includes("size") || error.includes("large")) return "画像のサイズは10 MiB以下にしてください。";
  if (error.includes("unauthorized") || error.includes("auth")) return "ログイン状態を確認して、もう一度お試しください。";
  if (/[\u3040-\u30ff\u3400-\u9fff]/u.test(value.error)) return value.error;
  return "レシートを保存できませんでした。通信を確認して、もう一度お試しください。";
}

function getReceiptId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || value.id.length === 0) return null;
  return value.id;
}
