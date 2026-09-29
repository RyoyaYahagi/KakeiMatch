import { requireUser } from "@/lib/current-user";
import Link from "next/link";
import LogoutButton from "../../components/logout-button";

export default async function SettingsPage() {
  const user = await requireUser();

  return (
    <div className="page-content">
      <section className="page-intro">
        <p className="eyebrow">アカウント</p>
        <h1>設定</h1>
      </section>
      <section className="settings-section" aria-labelledby="account-heading">
        <h2 id="account-heading">アカウント情報</h2>
        <dl className="detail-list">
          <div><dt>名前</dt><dd>{user.name || "未設定"}</dd></div>
          <div><dt>メールアドレス</dt><dd>{user.email}</dd></div>
        </dl>
      </section>
      <section className="settings-section" aria-labelledby="session-heading">
        <h2 id="session-heading">ログイン</h2>
        <p className="muted">この端末からログアウトします。</p>
        <LogoutButton />
      </section>
      <section className="settings-section" aria-labelledby="statement-heading">
        <h2 id="statement-heading">明細</h2>
        <p className="muted">カード・決済サービスのCSV明細を取り込みます。</p>
        <Link className="text-link" href="/statements/import">明細を取り込む</Link>
      </section>
    </div>
  );
}
