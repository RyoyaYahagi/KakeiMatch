import Link from "next/link";
import { notFound } from "next/navigation";
import { ActualBudgetNotLinkedError, ActualUnavailableError, actualGateway } from "@/lib/actual-gateway";
import { formatYen } from "@/lib/ledger-format";
import { formatFullDate, getLedgerErrorMessage } from "../../../components/ledger-display";

export default async function TransactionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const transaction = await actualGateway.getTransactionById(id);
    if (!transaction || transaction.kind !== "expense") notFound();

    return (
      <div className="page-content">
        <Link className="back-link" href="/transactions">支出一覧へ戻る</Link>
        <section className="page-intro detail-intro">
          <p className="eyebrow">支出の詳細</p>
          <h1>{transaction.payeeName || "支払先未登録"}</h1>
          <p className="detail-amount">{formatYen(Math.abs(transaction.amountYen))}</p>
        </section>
        <dl className="detail-list">
          <div><dt>日付</dt><dd><time dateTime={transaction.date}>{formatFullDate(transaction.date)}</time></dd></div>
          <div><dt>カテゴリ</dt><dd>{transaction.categoryName || "未分類"}</dd></div>
        </dl>
      </div>
    );
  } catch (error) {
    if (error instanceof ActualBudgetNotLinkedError || error instanceof ActualUnavailableError) {
      return (
        <div className="page-content">
          <section className="notice notice-error" role="alert">
            <h1>支出を表示できませんでした</h1>
            <p>{getLedgerErrorMessage(error)}</p>
            <Link className="button button-secondary" href="/transactions">支出一覧へ戻る</Link>
          </section>
        </div>
      );
    }
    throw error;
  }
}
