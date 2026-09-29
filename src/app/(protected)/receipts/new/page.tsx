import ReceiptUploadForm from "./receipt-upload-form";

export default function NewReceiptPage() {
  return (
    <div className="page-content receipt-page">
      <section className="page-intro">
        <p className="eyebrow">レシート登録</p>
        <h1>レシートを保存</h1>
        <p className="muted">撮影するか、端末内の画像を選んでください。保存後、読み取りのため画像をGoogleの外部サービスへ送信します。</p>
      </section>
      <ReceiptUploadForm />
    </div>
  );
}
