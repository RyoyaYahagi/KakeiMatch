declare const __CHATGPT_PLAN_ENABLED__: boolean;
const SELECTION_KEY = 'kakeimatch.chatgpt-plan.enabled.v1';
const available = () => typeof __CHATGPT_PLAN_ENABLED__ !== 'undefined' && __CHATGPT_PLAN_ENABLED__ && location.hostname === '127.0.0.1';
export function chatGptPlanSelected(): boolean { return available() && localStorage.getItem(SELECTION_KEY) === 'true'; }
export const chatGptRequestHeaders = { 'content-type': 'application/json', 'x-kakeimatch-self-hosted': '1' };
export function initializeChatGptPlanUi(parent: HTMLElement): void {
  if (!available()) return;
  const section = document.createElement('section'); section.id = 'chatgpt-plan-settings'; section.className = 'settings-inner-disclosure';
  section.innerHTML = '<h4>Experimental: ChatGPT プラン</h4><p>自分用・セルフホスト環境向けの実験機能です。接続とモデル選択後、レシート画像を送って読み取ります。カテゴリ提案は通常の経路を使います。</p><p id="chatgpt-plan-status" role="status"></p><button id="chatgpt-plan-login" type="button">Continue with ChatGPT</button><label for="chatgpt-plan-model">モデル</label><select id="chatgpt-plan-model"></select><button id="chatgpt-plan-enable" type="button">レシートの読み取りに使う</button><button id="chatgpt-plan-disable" class="secondary" type="button">通常の読み取りに戻す</button><button id="chatgpt-plan-logout" class="text-button" type="button">接続を解除</button>';
  parent.append(section);
  const status = section.querySelector<HTMLParagraphElement>('#chatgpt-plan-status')!;
  const select = section.querySelector<HTMLSelectElement>('#chatgpt-plan-model')!;
  const login = section.querySelector<HTMLButtonElement>('#chatgpt-plan-login')!;
  const enable = section.querySelector<HTMLButtonElement>('#chatgpt-plan-enable')!;
  const logout = section.querySelector<HTMLButtonElement>('#chatgpt-plan-logout')!;
  const developer = document.querySelector<HTMLInputElement>('#developer-options');
  const updateVisibility = () => { section.hidden = !developer?.checked; };
  developer?.addEventListener('change', updateVisibility); queueMicrotask(updateVisibility);
  async function request(path: string, body?: unknown) {
    const response = await fetch(`/api/self-hosted/chatgpt/${path}`, { credentials: 'same-origin', cache: 'no-store',
      ...(path === 'status' ? {} : { method: 'POST', headers: chatGptRequestHeaders, body: JSON.stringify(body ?? {}) }) });
    if (!response.ok) throw new Error('connection'); return response.json();
  }
  async function refresh() {
    const state = await request('status') as { connected: boolean; allowed: boolean; enabled: boolean; model: string | null };
    localStorage.setItem(SELECTION_KEY, state.enabled && state.allowed ? 'true' : 'false');
    status.textContent = state.connected ? state.allowed ? state.enabled ? '接続済み。この端末の読み取りで使用します。' : '接続済み。モデルを選んで有効にしてください。' : 'プラン利用の許可がありません。再接続してください。' : '未接続';
    login.hidden = state.connected && state.allowed; logout.hidden = !state.connected; select.hidden = enable.hidden = !state.allowed;
    if (state.allowed) {
      const catalog = await request('models') as { models: Array<{ id: string; name: string }> }; select.replaceChildren();
      for (const model of catalog.models) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.name; select.append(option); }
      if (state.model) select.value = state.model;
      enable.disabled = !select.value;
    }
  }
  async function run(action: () => Promise<void>) {
    section.inert = true;
    try { await action(); } catch { status.textContent = '接続を確認できません。再接続するか、通常の読み取りに戻してください。'; }
    finally { section.inert = false; }
  }
  login.addEventListener('click', () => { void run(async () => { const result = await request('sign-in') as { url: string }; const url = new URL(result.url); if (url.origin !== 'https://auth.openai.com') throw new Error('invalid'); location.assign(url.href); }); });
  enable.addEventListener('click', () => { void run(async () => { await request('settings', { model: select.value, enabled: true }); await refresh(); }); });
  section.querySelector('#chatgpt-plan-disable')!.addEventListener('click', () => { localStorage.removeItem(SELECTION_KEY); void run(async () => { await request('settings', { model: select.value || null, enabled: false }); await refresh(); }); });
  logout.addEventListener('click', () => { localStorage.removeItem(SELECTION_KEY); void run(async () => { const result = await request('sign-out') as { revoked: boolean }; await refresh(); if (!result.revoked) status.textContent = 'この端末の接続を解除しました。遠隔の解除は確認できませんでした。ChatGPTの設定から接続を確認してください。'; }); });
  void run(refresh);
}
