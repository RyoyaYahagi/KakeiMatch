import ReceiptUploadForm from "./receipt-upload-form";

export default function NewReceiptPage() {
  return (
    <div className="page-content receipt-page">
      <section className="page-intro">
        <p className="eyebrow">レシート登録</p>
        <h1>レシートを保存</h1>
        <p className="muted">撮影するか、端末内の画像を選んでください。</p>
      </section>
      <ReceiptUploadForm />
    </div>
  );
}
