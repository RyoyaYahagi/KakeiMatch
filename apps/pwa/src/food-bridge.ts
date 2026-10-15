import { z } from 'zod';
import { LocalDataRepository, LOCAL_PROFILE_KEY } from '../../../src/lib/local-data';
import { authorizeFoodConnection, foodConnections, foodOrigin, FoodApiError, readFoodApi } from './food-purchases-api';
import { initializeLocalScreenLock, readLocalScreenLock } from './local-screen-lock';
import './style.css';

const application = document.querySelector<HTMLElement>('#food-bridge')!;
const status = document.querySelector<HTMLElement>('#food-status')!;
const peer = document.querySelector<HTMLElement>('#food-peer')!;
const start = document.querySelector<HTMLButtonElement>('#food-start')!;
const stop = document.querySelector<HTMLButtonElement>('#food-stop')!;
// Reuse the same PIN, cooldown, biometric and cross-tab relock behavior as the PWA.
initializeLocalScreenLock(application, document.createElement('div'));
const opener = window.opener;
const origin = (() => {
  try { const value = new URL(location.href).searchParams.get('origin'); return value && foodOrigin(value) === value ? value : null; }
  catch { return null; }
})();
const schema = z.object({ type: z.literal('kakeimatch.food.request'), id: z.string().min(1).max(100),
  token: z.string().max(128), method: z.string().max(20), path: z.string().max(2048) }).strict();
let enabled = false;
let stopped = false;
let hiddenAt: number | null = document.hidden ? Date.now() : null;
document.addEventListener('visibilitychange', () => { hiddenAt = document.hidden ? Date.now() : null; });
let pendingToken: string | null = null;
let profileId: string | null = null;
let busy = false;
let lastRequestAt = 0;
const available = () => enabled && !stopped && !application.hidden && !application.inert
  && !(hiddenAt !== null && Date.now() - hiddenAt >= 60_000 && readLocalScreenLock())
  && profileId === localStorage.getItem(LOCAL_PROFILE_KEY);
stop.addEventListener('click', () => { enabled = false; stopped = true; pendingToken = null; start.disabled = true; peer.textContent = '連携を停止しました。'; status.textContent = '再開するには、この画面を開き直してください。'; });
start.addEventListener('click', () => {
  if (stopped || !pendingToken || application.hidden || application.inert) return;
  enabled = true; start.disabled = true; status.textContent = '食品情報の連携中です。設定で解除すると、この画面からも取得できなくなります。';
});
window.addEventListener('pagehide', () => { enabled = false; });
new MutationObserver(() => {
  if (application.hidden || application.inert) { enabled = false; if (pendingToken) start.disabled = false; }
}).observe(application, { attributes: true, attributeFilter: ['hidden', 'inert'] });

if (!opener || !origin) {
  status.textContent = '連携先アプリからこの画面を開いてください。';
} else {
  peer.textContent = `接続先：${origin}`;
  window.addEventListener('message', event => {
    if (event.source !== opener || event.origin !== origin) return;
    const parsed = schema.safeParse(event.data);
    if (!parsed.success) return;
    const request = parsed.data;
    const reply = (code: number, body: unknown) => opener.postMessage({ type: 'kakeimatch.food.response', id: request.id, status: code, body }, origin);
    if (busy || Date.now() - lastRequestAt < 100) { reply(429, { error: 'rate_limited' }); return; }
    busy = true; lastRequestAt = Date.now();
    void (async () => {
      const currentProfile = localStorage.getItem(LOCAL_PROFILE_KEY);
      if (stopped || !currentProfile || application.hidden || application.inert) throw new FoodApiError(423, 'connection_unavailable');
      const connection = await authorizeFoodConnection(request.token, origin, currentProfile);
      if (!pendingToken) {
        pendingToken = request.token; profileId = currentProfile;
        peer.textContent = `${connection.name}（${origin}）に、${connection.categories.map(row => row.name).join('・')}の購入情報を渡します。`;
        start.disabled = false;
      }
      if (!available() || pendingToken !== request.token) throw new FoodApiError(423, 'connection_unavailable');
      if (!navigator.locks) throw new FoodApiError(503, 'web_locks_required');
      const result = await navigator.locks.request(`kakeimatch.food-api:${connection.id}`, async () => {
        const repository = await LocalDataRepository.open(currentProfile);
        try { return await readFoodApi({ request, origin, repository, storage: localStorage, isAvailable: available }); }
        finally { repository.close(); }
      });
      if (!available()) throw new FoodApiError(423, 'connection_unavailable');
      if (!foodConnections().some(row => row.id === connection.id && row.tokenHash === connection.tokenHash)) throw new FoodApiError(401, 'invalid_token');
      reply(result.status, result.body);
    })().catch((error: unknown) => {
      reply(error instanceof FoodApiError ? error.status : 503, { error: error instanceof FoodApiError ? error.code : 'storage_unavailable' });
    }).finally(() => { busy = false; });
  });
  opener.postMessage({ type: 'kakeimatch.food.ready', version: 1 }, origin);
}
