import Link from "next/link";
import { actualGateway } from "@/lib/actual-gateway";
import { expensesOnly, formatYen } from "@/lib/ledger-format";
import { formatDate, getLedgerErrorMessage } from "../../components/ledger-display";

export default async function TransactionsPage() {
  try {
    const transactions = expensesOnly(await actualGateway.getRecentTransactions({ limit: 50 }));
    return (
      <div className="page-content">
        <section className="page-intro">
          <p className="eyebrow">家計の記録</p>
          <h1>支出</h1>
          <p className="muted">最近の支出を表示しています。</p>
        </section>
        {transactions.length === 0 ? (
          <p className="empty-state">まだ支出がありません。</p>
        ) : (
          <ul className="transaction-list">
            {transactions.map((transaction) => (
              <li key={transaction.id}>
                <Link className="transaction-row" href={`/transactions/${encodeURIComponent(transaction.id)}`}>
                  <time dateTime={transaction.date}>{formatDate(transaction.date)}</time>
                  <span className="transaction-name">{transaction.payeeName || "支払先未登録"}</span>
                  <strong>{formatYen(Math.abs(transaction.amountYen))}</strong>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  } catch (error) {
    const message = getLedgerErrorMessage(error);
    return (
      <div className="page-content">
        <section className="page-intro"><p className="eyebrow">家計の記録</p><h1>支出</h1></section>
        <section className="notice notice-error" role="alert">
          <h2>支出を読み込めませんでした</h2><p>{message}</p>
          <Link className="button button-secondary" href="/transactions">再読み込み</Link>
        </section>
      </div>
    );
  }
}
