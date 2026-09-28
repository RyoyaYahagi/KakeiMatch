import { requireUser } from "@/lib/current-user";
import Link from "next/link";
import LogoutButton from "./components/logout-button";

export default async function HomePage() {
  const user = await requireUser();

  return (
    <main className="page-shell">
      <header className="page-header">
        <Link className="wordmark" href="/">KakeiMatch</Link>
        <LogoutButton />
      </header>
      <section className="welcome">
        <p className="eyebrow">あなたの家計</p>
        <h1>こんにちは、{user.name || user.email}さん</h1>
        <p>家計の記録と明細確認を支援します。</p>
      </section>
      <section className="home-section" aria-labelledby="next-step">
        <h2 id="next-step">家計の記録を始めましょう</h2>
        <p>ログインできました。支出の登録や明細の確認は、準備ができ次第ここから利用できます。</p>
      </section>
    </main>
  );
}
