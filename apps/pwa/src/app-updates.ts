export function observeAppUpdates(registration: ServiceWorkerRegistration, notice: HTMLElement) {
  // Synthetic browser tests intentionally stub registration instead of installing a worker.
  if (!registration?.addEventListener) return () => {};
  let disposed = false;
  function showWaiting() {
    if (!disposed && registration.waiting && navigator.serviceWorker.controller) {
      notice.hidden = false;
      notice.textContent = '新しい版があります。入力を終え、開いているアプリの画面をすべて閉じてから、開き直してください。保存済みの家計データは残ります。';
    }
  }
  function observeInstalling() {
    const worker = registration.installing;
    worker?.addEventListener('statechange', showWaiting);
    showWaiting();
  }
  registration.addEventListener('updatefound', observeInstalling);
  observeInstalling();
  // Registration itself checks online; returning from background checks for later deployments.
  const check = () => {
    if (!disposed && document.visibilityState === 'visible' && navigator.onLine) void registration.update().catch(() => { /* Failed updates preserve the active, complete shell. */ });
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('online', check);
  return () => { disposed = true; registration.removeEventListener('updatefound', observeInstalling); document.removeEventListener('visibilitychange', check); window.removeEventListener('online', check); };
}
