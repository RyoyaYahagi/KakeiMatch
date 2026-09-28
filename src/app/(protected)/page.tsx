import Link from "next/link";
import { actualGateway } from "@/lib/actual-gateway";
import { currentYearMonth, expensesOnly, formatYen } from "@/lib/ledger-format";
import { formatDate, getLedgerErrorMessage } from "../components/ledger-display";

export default async function HomePage() {
  let spending: number | null = null;
  let recent: Awaited<ReturnType<typeof actualGateway.getRecentTransactions>> = [];
  let errorMessage: string | null = null;

  try {
    const month = currentYearMonth();
    [spending, recent] = await Promise.all([
      actualGateway.getMonthlySpending({ yearMonth: month }),
      actualGateway.getRecentTransactions({ limit: 50 }),
    ]);
    recent = expensesOnly(recent).slice(0, 5);
  } catch (error) {
    errorMessage = getLedgerErrorMessage(error);
  }

  return (
    <div className="page-content">
      <section className="page-intro">
        <p className="eyebrow">ホーム</p>
        <h1>今月の支出</h1>
        <p className="muted">{formatMonth(currentYearMonth())}</p>
      </section>

      <section className="receipt-prompt" aria-label="レシート登録">
        <span>レシート登録</span>
        <span className="status-label">準備中</span>
      </section>

      {errorMessage ? (
        <section className="notice notice-error" role="alert">
          <h2>支出を読み込めませんでした</h2>
          <p>{errorMessage}</p>
          <Link className="button button-secondary" href="/">再読み込み</Link>
        </section>
      ) : (
        <>
          <section className="summary-line" aria-label="今月の支出合計">
            <span>今月の支出合計</span>
            <strong>{spending === null ? "—" : formatYen(spending)}</strong>
          </section>
          <section className="ledger-section" aria-labelledby="recent-heading">
            <div className="section-heading">
              <h2 id="recent-heading">最近の支出</h2>
              <Link className="text-link" href="/transactions">すべて見る</Link>
            </div>
            {recent.length === 0 ? (
              <p className="empty-state">まだ支出がありません。</p>
            ) : (
              <TransactionList transactions={recent} />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function TransactionList({ transactions }: { transactions: Awaited<ReturnType<typeof actualGateway.getRecentTransactions>> }) {
  return (
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
  );
}

function formatMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split("-");
  return `${year}年${Number(month)}月`;
}
