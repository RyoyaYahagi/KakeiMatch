import { LocalDataStorageError } from '../../../src/lib/local-data';
import { initializeLocalUi } from './local-ui';
import { initializeDeveloperCostsUi } from './developer-costs-ui';
import { createAuthClient } from 'better-auth/client';
import { passkeyClient } from '@better-auth/passkey/client';
import { clearAiAccessToken, getAiAccessToken } from './ai-auth';
import { setNavActive } from './app-nav';
import { iconMarkup } from './ui-icons';
import './style.css';

const authClient = createAuthClient({ baseURL: location.origin, plugins: [passkeyClient()] });

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('App root is missing');
root.innerHTML = `
  <main>
    <h1 class="visually-hidden">KakeiMatch</h1>
    <p class="network-status" id="network" role="status" hidden></p>
    <nav class="app-nav" aria-label="アプリ">
      <button id="home-tab" class="nav-button active" type="button" aria-pressed="true" aria-current="page">${iconMarkup('home')}<span>ホーム</span></button>
      <button id="receipt-tab" class="nav-button" type="button" aria-pressed="false">${iconMarkup('records')}<span>記録</span></button>
      <button id="add-record" class="nav-add" type="button" aria-label="記録を追加"><span class="nav-add-circle">${iconMarkup('add')}</span><span>追加</span></button>
      <button id="reconciliation-tab" class="nav-button" type="button" aria-pressed="false">${iconMarkup('reconciliation')}<span>照合</span><span id="reconciliation-badge" class="nav-badge" aria-hidden="true" hidden></span></button>
      <button id="settings-tab" class="nav-button" type="button" aria-pressed="false">${iconMarkup('settings')}<span>設定</span></button>
    </nav>
    <p class="status" id="message" role="status"></p>
    <section id="household-view">
    <section id="import-section" hidden>
      <p>既存の家計簿があれば、記録を始める前にZIPファイルを読み込めます。</p>
      <button id="import-button" class="secondary" type="button">家計簿を読み込む</button>
      <input id="import-file" type="file" accept=".zip,application/zip" hidden />
    </section>
    <section id="budget-section" hidden>
      <label for="budget">家計簿</label>
      <select id="budget"></select>
    </section>
    <div id="home-summary" aria-busy="true"></div>
    <div id="home-attention"></div>
    <div id="home-categories"></div>
    <section class="surface-section" aria-labelledby="recent-records-title">
      <div class="section-header"><h2 id="recent-records-title">最近の記録</h2><button id="home-all-records" class="text-button" type="button" aria-label="記録をすべて見る">すべて${iconMarkup('chevronRight')}</button></div>
      <ul id="transactions" class="record-rows"></ul>
    </section>
    </section>
    <section id="local-view" hidden></section>
    <section id="settings-view" hidden>
      <div class="page-header"><h2>設定</h2></div>
      <h3 class="settings-group-title">家計簿</h3>
      <section id="local-settings" class="surface-section settings-list" aria-label="家計簿の設定"></section>
      <h3 class="settings-group-title">データ</h3>
      <div id="data-settings" class="settings-stack"></div>
      <h3 class="settings-group-title">写真の読み取り</h3>
      <section id="ai-settings" class="surface-section settings-panel" aria-label="AI利用">
      <h4>AI利用</h4>
      <p class="muted">レシートの読み取りからカテゴリ提案までで1回です。読み取り直すと新たに1回使います。毎月1日の午前0時（日本時間）に利用枠が更新されます。</p>
      <p id="usage-summary" aria-live="polite">利用状況を読み込んでいます…</p>
      <p id="account-status" class="muted"></p>
      <div id="signed-out-actions" hidden>
        <p>AI機能を利用するにはアカウントが必要です。家計簿の閲覧や編集はこの端末で引き続き利用できます。</p>
        <button id="passkey-login" type="button">Passkeyで続ける</button>
        <button id="invite-register" class="secondary" type="button">招待コードで登録</button>
        <button id="manual-entry" class="secondary" type="button">家計簿に戻る</button>
      </div>
      <div id="signed-in-actions" hidden>
        <button id="use-ai" type="button">AI利用を確認</button>
        <section id="developer-costs" hidden aria-labelledby="developer-costs-heading">
          <h5 id="developer-costs-heading">APIコスト（推定）</h5>
          <div class="month-selector">
            <button id="costs-previous-month" class="secondary" type="button" aria-label="前月のAI利用料金">‹</button>
            <strong id="costs-month" aria-live="polite"></strong>
            <button id="costs-next-month" class="secondary" type="button" aria-label="翌月のAI利用料金">›</button>
          </div>
          <p id="costs-total" aria-live="polite">利用料金を読み込んでいます…</p>
          <p id="costs-unknown" class="muted" hidden></p>
          <ul id="costs-providers"></ul>
        </section>
        <h5>Passkey</h5>
        <ul id="passkey-list"></ul>
        <button id="add-passkey" class="secondary" type="button">Passkeyを追加</button>
        <button id="logout" class="secondary" type="button">ログアウト</button>
      </div>
      <p class="status" id="account-message" role="status"></p>
      </section>
      <h3 class="settings-group-title">アプリ</h3>
      <section id="app-info" class="surface-section settings-panel">
        <h4>アプリ情報</h4>
        <label class="developer-option" for="developer-options">
          <input id="developer-options" type="checkbox" />
          開発者向け機能を表示
        </label>
        <p class="muted">この設定はこの端末のブラウザーだけに保存され、バックアップには含まれません。</p>
        <p id="developer-options-status" class="status" role="status"></p>
      </section>
      <p class="muted settings-footnote">家計簿と画像はこの端末に保存されます。端末の紛失やブラウザーのデータ消去で失われることがあります。</p>
    </section>
  </main>`;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const message = element<HTMLParagraphElement>('message');
const network = element<HTMLElement>('network');
const householdView = element<HTMLElement>('household-view');
const settingsView = element<HTMLElement>('settings-view');
const homeTab = element<HTMLButtonElement>('home-tab');
const settingsTab = element<HTMLButtonElement>('settings-tab');
const usageSummary = element<HTMLParagraphElement>('usage-summary');
const accountStatus = element<HTMLParagraphElement>('account-status');
const signedOutActions = element<HTMLElement>('signed-out-actions');
const signedInActions = element<HTMLElement>('signed-in-actions');
const accountMessage = element<HTMLParagraphElement>('account-message');
const passkeyList = element<HTMLUListElement>('passkey-list');
const loginButton = element<HTMLButtonElement>('passkey-login');
const inviteButton = element<HTMLButtonElement>('invite-register');
const manualButton = element<HTMLButtonElement>('manual-entry');
const addPasskeyButton = element<HTMLButtonElement>('add-passkey');
const logoutButton = element<HTMLButtonElement>('logout');
const useAiButton = element<HTMLButtonElement>('use-ai');
const developerOptions = element<HTMLInputElement>('developer-options');
const developerCosts = element<HTMLElement>('developer-costs');
const developerCostsUi = initializeDeveloperCostsUi({
  toggle: developerOptions,
  section: developerCosts,
  status: element<HTMLParagraphElement>('developer-options-status'),
  month: element<HTMLElement>('costs-month'),
  total: element<HTMLElement>('costs-total'),
  unknown: element<HTMLElement>('costs-unknown'),
  providers: element<HTMLUListElement>('costs-providers'),
  previous: element<HTMLButtonElement>('costs-previous-month'),
  next: element<HTMLButtonElement>('costs-next-month'),
});


function showTab(tab: 'home' | 'settings') {
  document.getElementById('local-view')!.hidden = true;
  for (const id of ['receipt-tab', 'reconciliation-tab']) {
    const button = element<HTMLButtonElement>(id);
    setNavActive(button, false);
  }
  const isSettings = tab === 'settings';
  householdView.hidden = isSettings;
  settingsView.hidden = !isSettings;
  setNavActive(homeTab, !isSettings);
  setNavActive(settingsTab, isSettings);
  if (isSettings) void refreshAccount();
}

homeTab.addEventListener('click', () => showTab('home'));
settingsTab.addEventListener('click', () => showTab('settings'));

type SessionResponse = { user: { name?: string; email?: string }; session: { expiresAt: string } } | null;
type UsageResponse = { plan: 'free' | 'pro' | 'family'; used: number; limit: number | null; remaining: number | null };
type PasskeyRow = { id: string; name?: string | null; createdAt?: string | Date };

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  if (!response.ok) throw new Error(`API request failed (${response.status})`);
  return response.json() as Promise<T>;
}

async function refreshAccount() {
  usageSummary.textContent = '利用状況を読み込んでいます…';
  accountMessage.textContent = '';
  try {
    const sessionResult = await authClient.getSession();
    if (sessionResult.error) throw new Error(sessionResult.error.message);
    const session = sessionResult.data as SessionResponse;
    const signedIn = Boolean(session?.user);
    signedOutActions.hidden = signedIn;
    signedInActions.hidden = !signedIn;
    developerCostsUi.setSignedIn(signedIn);
    if (!signedIn) {
      usageSummary.textContent = 'ログインすると今月のAI利用回数を確認できます。';
      accountStatus.textContent = '未ログインです。';
      return;
    }
    accountStatus.textContent = `ログイン中${session?.user.name ? `：${session.user.name}` : ''}`;
    const [usageResult, passkeyResult] = await Promise.allSettled([
      apiJson<UsageResponse>('/api/ai/usage').then(renderUsage),
      renderPasskeys(),
    ]);
    if (usageResult.status === 'rejected') usageSummary.textContent = '利用状況を取得できません。オンラインで再度お試しください。';
    if (passkeyResult.status === 'rejected') accountMessage.textContent = 'Passkey一覧を取得できません。';
  } catch {
    usageSummary.textContent = '利用状況を取得できません。オンラインで再度お試しください。';
    accountStatus.textContent = 'AIアカウントへ接続できません。家計簿のデータはこの端末で引き続き利用できます。';
    signedOutActions.hidden = true;
    signedInActions.hidden = true;
    developerCostsUi.setSignedIn(false);
  }
}

function renderUsage(usage: UsageResponse) {
  const planName = usage.plan === 'family' ? 'Family' : usage.plan === 'pro' ? 'Pro' : 'Free';
  usageSummary.textContent = usage.limit === null
    ? `AI利用 · ${usage.used}回 · ${planName} · 上限なし`
    : `AI利用 · ${usage.used} / ${usage.limit}回 · ${planName}`;
}

async function renderPasskeys() {
  const result = await authClient.passkey.listUserPasskeys();
  if (result.error) throw new Error(result.error.message);
  const rows = (result.data ?? []) as PasskeyRow[];
  passkeyList.replaceChildren();
  for (const passkey of rows) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = passkey.name || 'Passkey';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = '削除';
    remove.addEventListener('click', () => {
      if (!window.confirm(`${passkey.name || 'このPasskey'}を削除しますか？`)) return;
      void authClient.passkey.deletePasskey({ id: passkey.id })
        .then(result => { if (result.error) throw new Error(result.error.message); return renderPasskeys(); })
        .catch(() => { accountMessage.textContent = 'Passkeyを削除できませんでした。'; });
    });
    row.append(label, remove);
    passkeyList.append(row);
  }
  if (rows.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = '登録済みのPasskeyはありません。';
    passkeyList.append(empty);
  }
}

async function issueAiToken() {
  accountMessage.textContent = 'AI機能を準備しています…';
  try {
    await getAiAccessToken();
  } catch (error) {
    if (error instanceof Error && error.message === 'account_session_required') {
      signedInActions.hidden = true;
      signedOutActions.hidden = false;
      accountMessage.textContent = 'セッションが切れました。Passkeyで再度ログインしてください。';
      return;
    }
    accountMessage.textContent = 'AI機能を準備できませんでした。家計簿の利用は続けられます。';
    return;
  }
  accountMessage.textContent = 'AI利用の認証を確認しました。';
}

loginButton.addEventListener('click', () => {
  loginButton.disabled = true;
  accountMessage.textContent = 'Passkeyを確認しています…';
  void authClient.signIn.passkey().then(async result => {
    if (result.error) throw new Error(result.error.message);
    await refreshAccount();
    await issueAiToken();
  }).catch(() => { accountMessage.textContent = 'ログインできませんでした。登録済みのPasskeyを確認してください。'; })
    .finally(() => { loginButton.disabled = false; });
});

inviteButton.addEventListener('click', () => {
  const token = new URLSearchParams(location.search).get('invite') || window.prompt('招待コードを入力してください。');
  if (!token) return;
  inviteButton.disabled = true;
  accountMessage.textContent = 'Passkeyを登録しています…';
  void authClient.passkey.addPasskey({ name: 'この端末', context: token, createSession: true }).then(async result => {
    if (result.error) throw new Error(result.error.message);
    await refreshAccount();
    await issueAiToken();
    history.replaceState(null, '', location.pathname);
  }).catch(() => { accountMessage.textContent = '登録できませんでした。招待コードの有効期限を確認してください。'; })
    .finally(() => { inviteButton.disabled = false; });
});

manualButton.addEventListener('click', () => {
  accountMessage.textContent = '家計簿に戻ります。';
  showTab('home');
});

addPasskeyButton.addEventListener('click', () => {
  addPasskeyButton.disabled = true;
  void authClient.passkey.addPasskey({ name: '追加のPasskey' }).then(result => {
    if (result.error) throw new Error(result.error.message);
    accountMessage.textContent = 'Passkeyを追加しました。';
    return renderPasskeys();
  }).catch(() => { accountMessage.textContent = 'Passkeyを追加できませんでした。'; })
    .finally(() => { addPasskeyButton.disabled = false; });
});

logoutButton.addEventListener('click', () => {
  void authClient.signOut().then(result => {
    if (result.error) throw new Error(result.error.message);
    clearAiAccessToken();
    signedInActions.hidden = true;
    signedOutActions.hidden = false;
    developerCostsUi.setSignedIn(false);
    accountStatus.textContent = '未ログインです。';
    accountMessage.textContent = 'ログアウトしました。端末の家計簿データは保持されています。';
  }).catch(() => { accountMessage.textContent = 'ログアウトできませんでした。'; });
});

useAiButton.addEventListener('click', () => { void issueAiToken(); });

function showNetwork() {
  network.hidden = navigator.onLine;
  network.textContent = navigator.onLine ? '' : 'オフライン';
}
window.addEventListener('online', showNetwork);
window.addEventListener('offline', showNetwork);
showNetwork();

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {
    message.textContent = 'オフライン用の画面を準備できませんでした。オンラインで再読込してください。';
  });
}
message.textContent = '家計簿を準備しています…';
void initializeLocalUi({ openAccount: () => showTab('settings') }).catch((error: unknown) => {
  message.textContent = error instanceof LocalDataStorageError ? error.message : '端末の家計簿を開けませんでした。保存状態を確認し、再読込してください。';
});
