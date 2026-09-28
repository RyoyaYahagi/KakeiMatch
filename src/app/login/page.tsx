import LoginForm from "./login-form";
import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="login-shell">
      <Link className="wordmark" href="/">KakeiMatch</Link>
      <section className="login-content" aria-labelledby="login-title">
        <p className="eyebrow">家計を、すっきり確認</p>
        <h1 id="login-title">ログイン</h1>
        <p className="intro">登録したメールアドレスとパスワードを入力してください。</p>
        <LoginForm />
      </section>
      <p className="login-footnote">アカウントの作成は管理者にお問い合わせください。</p>
    </main>
  );
}
