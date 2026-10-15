// Serve this directory on a different origin from KakeiMatch. No dependency or MCP is required.
const form = document.querySelector('#connect');
const read = document.querySelector('#read');
const status = document.querySelector('#status');
const result = document.querySelector('#result');
let popup = null;
let appOrigin = '';
let cursor = null;
const items = new Map();
const pending = new Map();
window.addEventListener('message', event => {
  if (event.source !== popup || event.origin !== appOrigin) return;
  if (event.data?.type === 'kakeimatch.food.ready') {
    read.disabled = false;
    // First request identifies the approved app. No food data is returned until the user starts sharing.
    void request().catch(error => { status.textContent = error.message; });
  }
  if (event.data?.type !== 'kakeimatch.food.response') return;
  const waiting = pending.get(event.data.id);
  if (!waiting) return;
  pending.delete(event.data.id); clearTimeout(waiting.timer);
  if (event.data.status === 200) waiting.resolve(event.data.body);
  else waiting.reject(new Error(`${event.data.status}: ${event.data.body.error}`));
});
function request() {
  return new Promise((resolve, reject) => {
    if (!popup || popup.closed) { reject(new Error('接続画面を開いてください。')); return; }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('接続画面から応答がありません。')); }, 15000);
    pending.set(id, { resolve, reject, timer });
    popup.postMessage({ type: 'kakeimatch.food.request', id, token: document.querySelector('#token').value,
      method: 'GET', path: '/api/v1/food-purchases' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '') }, appOrigin);
  });
}
form.addEventListener('submit', event => {
  event.preventDefault(); popup?.close(); cursor = null; items.clear(); result.textContent = ''; read.disabled = true;
  appOrigin = new URL(document.querySelector('#app-origin').value).origin;
  popup = window.open(`${appOrigin}/food-api.html?origin=${encodeURIComponent(location.origin)}`, '_blank', 'popup,width=540,height=750');
  status.textContent = popup ? '接続画面で許可してください。' : 'ポップアップを許可してください。';
});
read.addEventListener('click', async () => {
  read.disabled = true;
  try {
    let body;
    do {
      body = await request();
      for (const row of body.items) { if (row.deleted) items.delete(row.id); else items.set(row.id, row); }
      cursor = body.nextCursor;
      if (body.hasMore) await new Promise(resolve => setTimeout(resolve, 150));
    } while (body.hasMore);
    result.textContent = JSON.stringify([...items.values()], null, 2);
    status.textContent = `${items.size}件の食品情報を取得しました。`;
  } catch (error) {
    status.textContent = error.message;
    if (error.message.startsWith('409:')) { cursor = null; items.clear(); result.textContent = ''; }
  } finally { read.disabled = false; }
});
document.querySelector('#disconnect').addEventListener('click', () => {
  popup?.close(); popup = null; cursor = null; items.clear(); result.textContent = ''; document.querySelector('#token').value = ''; read.disabled = true;
  status.textContent = '接続を閉じました。';
});
