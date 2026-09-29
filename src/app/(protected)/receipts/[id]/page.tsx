import Link from "next/link";
import ReceiptAnalysis from "./receipt-analysis";

export default async function ReceiptDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="page-content receipt-page">
      <Link className="back-link" href="/">ホームへ戻る</Link>
      <section className="page-intro detail-intro">
        <p className="eyebrow">レシート</p>
        <h1>読み取り結果</h1>
      </section>
      <ReceiptAnalysis receiptId={id} />
    </div>
  );
}
