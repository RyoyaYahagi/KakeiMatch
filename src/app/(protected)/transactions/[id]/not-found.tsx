import Link from "next/link";

export default function TransactionNotFound() {
  return (
    <div className="page-content">
      <section className="notice">
        <h1>支出を表示できません</h1>
        <p>支出が見つかりませんでした。</p>
        <Link className="button button-secondary" href="/transactions">支出一覧へ戻る</Link>
      </section>
    </div>
  );
}
