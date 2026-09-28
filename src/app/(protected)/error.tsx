"use client";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page-content">
      <section className="notice notice-error" role="alert">
        <h1>画面を表示できませんでした</h1>
        <p>時間をおいて、もう一度お試しください。</p>
        <button className="button button-secondary" type="button" onClick={reset}>再読み込み</button>
      </section>
    </div>
  );
}
