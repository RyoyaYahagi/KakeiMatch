export default function Loading() {
  return (
    <div className="page-content" aria-busy="true" aria-label="読み込み中">
      <div className="skeleton skeleton-heading" />
      <div className="skeleton skeleton-summary" />
      <div className="skeleton skeleton-row" />
      <div className="skeleton skeleton-row" />
      <div className="skeleton skeleton-row" />
    </div>
  );
}
