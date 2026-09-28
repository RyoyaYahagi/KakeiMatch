"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export default function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function logout() {
    setError("");
    setBusy(true);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setError("ログアウトできませんでした。もう一度お試しください。");
        return;
      }
      router.replace("/login");
      router.refresh();
    } catch {
      setError("ログアウトできませんでした。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="logout-control">
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-secondary" type="button" onClick={logout} disabled={busy}>
        {busy ? "ログアウト中…" : "ログアウト"}
      </button>
    </div>
  );
}
