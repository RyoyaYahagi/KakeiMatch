import { requireUser } from "@/lib/current-user";
import StatementImportForm from "./statement-import-form";

export default async function StatementImportPage() {
  await requireUser();

  return (
    <div className="page-content statement-import-page">
      <section className="page-intro">
        <p className="eyebrow">明細</p>
        <h1>明細を取り込む</h1>
        <p className="muted">利用したサービスを選び、CSVファイルを読み込みます。</p>
      </section>
      <StatementImportForm />
    </div>
  );
}
