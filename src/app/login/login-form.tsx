"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export default function LoginForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const formData = new FormData(event.currentTarget);

    try {
      const result = await authClient.signIn.email({
        email: String(formData.get("email") ?? "").trim(),
        password: String(formData.get("password") ?? ""),
        callbackURL: "/",
      });
      if (result.error) {
        setError("メールアドレスまたはパスワードを確認してください。");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("ログインできませんでした。通信状況を確認して、もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <label htmlFor="email">メールアドレス</label>
      <input id="email" name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} />
      <label htmlFor="password">パスワード</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-primary" type="submit" disabled={busy}>
        {busy ? "ログイン中…" : "ログイン"}
      </button>
    </form>
  );
}
