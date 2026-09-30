import * as actual from '@actual-app/api';
import { createAuthClient } from 'better-auth/client';
import { passkeyClient } from '@better-auth/passkey/client';
import { clearAiAccessToken, getAiAccessToken } from './ai-auth';
import './style.css';

const authClient = createAuthClient({ baseURL: location.origin, plugins: [passkeyClient()] });

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('App root is missing');
root.innerHTML = `
  <main>
    <header><h1>KakeiMatch</h1><span class="status" id="network"></span></header>
    <p class="muted">この端末の家計簿を表示します。</p>
    <nav class="app-nav" aria-label="アプリ">
      <button id="home-tab" class="nav-button active" type="button" aria-pressed="true">家計簿</button>
      <button id="settings-tab" class="nav-button" type="button" aria-pressed="false">設定</button>
    </nav>
    <p class="status" id="message" role="status"></p>
    <section id="household-view">
    <section id="import-section" hidden>
      <p>この端末に家計簿はありません。家計簿のZIPファイルがあれば読み込めます。</p>
      <button id="import-button" type="button">家計簿を読み込む</button>
      <input id="import-file" type="file" accept=".zip,application/zip" hidden />
    </section>
    <section id="budget-section" hidden>
      <label for="budget">家計簿</label>
      <select id="budget"></select>
    </section>
    <section>
      <button id="ai-entry" type="button">AI利用を確認</button>
    </section>
    <section>
      <h2>最近の取引</h2>
      <ul id="transactions"></ul>
    </section>
    </section>
    <section id="settings-view" hidden>
      <h2>AI利用</h2>
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
        <h3>Passkey</h3>
        <ul id="passkey-list"></ul>
        <button id="add-passkey" class="secondary" type="button">Passkeyを追加</button>
        <button id="logout" class="secondary" type="button">ログアウト</button>
      </div>
      <p class="status" id="account-message" role="status"></p>
    </section>
  </main>`;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const message = element<HTMLParagraphElement>('message');
const selector = element<HTMLSelectElement>('budget');
const list = element<HTMLUListElement>('transactions');
const budgetSection = element<HTMLElement>('budget-section');
const importSection = element<HTMLElement>('import-section');
const importButton = element<HTMLButtonElement>('import-button');
const importFile = element<HTMLInputElement>('import-file');
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
const aiEntryButton = element<HTMLButtonElement>('ai-entry');

function showTab(tab: 'home' | 'settings') {
  const isSettings = tab === 'settings';
  householdView.hidden = isSettings;
  settingsView.hidden = !isSettings;
  homeTab.classList.toggle('active', !isSettings);
  homeTab.setAttribute('aria-pressed', String(!isSettings));
  settingsTab.classList.toggle('active', isSettings);
  settingsTab.setAttribute('aria-pressed', String(isSettings));
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
    accountStatus.textContent = 'Cloud accountへ接続できません。家計簿のデータはこの端末で引き続き利用できます。';
    signedOutActions.hidden = true;
    signedInActions.hidden = true;
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
    accountStatus.textContent = '未ログインです。';
    accountMessage.textContent = 'ログアウトしました。端末の家計簿データは保持されています。';
  }).catch(() => { accountMessage.textContent = 'ログアウトできませんでした。'; });
});

useAiButton.addEventListener('click', () => { void issueAiToken(); });
aiEntryButton.addEventListener('click', () => {
  showTab('settings');
  if (!signedInActions.hidden) void issueAiToken();
});

function showNetwork() {
  network.textContent = navigator.onLine ? 'オンライン' : 'オフライン';
}
window.addEventListener('online', showNetwork);
window.addEventListener('offline', showNetwork);
showNetwork();

function dayInTokyo(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function formatYen(amount: number): string {
  return `${amount < 0 ? '−' : '+'}¥${Math.abs(amount).toLocaleString('ja-JP')}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'QuotaExceededError') return '端末の保存容量が不足しています。空き容量を確認してください。';
  return '家計簿を読み書きできませんでした。端末の保存状態を確認し、再度お試しください。';
}

async function showTransactions() {
  message.textContent = '取引を読み込んでいます…';
  list.replaceChildren();
  const accounts = await actual.getAccounts();
  const payees = new Map((await actual.getPayees()).map(payee => [payee.id, payee.name]));
  const today = dayInTokyo(new Date());
  const start = dayInTokyo(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
  const rows = (await Promise.all(accounts.map(async account => {
    const transactions = await actual.getTransactions(account.id, start, today);
    return transactions.filter(item => !item.is_parent).map(item => ({ account: account.name, item }));
  }))).flat().sort((a, b) => b.item.date.localeCompare(a.item.date)).slice(0, 50);
  for (const { account, item } of rows) {
    const row = document.createElement('li');
    const heading = document.createElement('div');
    heading.className = 'row';
    const name = document.createElement('strong');
    name.textContent = payees.get(item.payee || '') || '取引';
    const amount = document.createElement('span');
    amount.textContent = formatYen(item.amount);
    heading.append(name, amount);
    const detail = document.createElement('div');
    detail.className = 'muted';
    detail.textContent = `${item.date} · ${account}${item.notes ? ` · ${item.notes}` : ''}`;
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'note-edit';
    edit.textContent = 'メモを編集';
    edit.addEventListener('click', () => {
      const notes = window.prompt('取引のメモ', item.notes || '');
      if (notes === null) return;
      edit.disabled = true;
      void actual.updateTransaction(item.id, { notes }).then(async () => {
        await showTransactions();
        message.textContent = 'メモを保存しました。';
      }).catch(error => { message.textContent = errorMessage(error); }).finally(() => { edit.disabled = false; });
    });
    row.append(heading, detail, edit);
    list.append(row);
  }
  message.textContent = rows.length ? '' : '最近の取引はありません。';
}

async function loadSelectedBudget() {
  const id = selector.value;
  if (!id) return;
  message.textContent = '家計簿を開いています…';
  try {
    await actual.loadBudget(id);
    await showTransactions();
  } catch (error) {
    message.textContent = errorMessage(error);
  }
}

importButton.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', () => {
  const file = importFile.files?.[0];
  if (!file) return;
  importButton.disabled = true;
  message.textContent = '家計簿を読み込んでいます…';
  void file.arrayBuffer().then(buffer => actual.importBudget(buffer, { filename: file.name })).then(async budget => {
    selector.add(new Option(file.name.replace(/\.zip$/i, ''), budget.id));
    selector.value = budget.id;
    importSection.hidden = true;
    budgetSection.hidden = false;
    await loadSelectedBudget();
  }).catch(error => { message.textContent = errorMessage(error); }).finally(() => { importButton.disabled = false; importFile.value = ''; });
});

async function start() {
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    message.textContent = '家計簿を開くために必要なブラウザ設定がありません。ページを再読込してください。';
    return;
  }
  try {
    await actual.init({});
    const budgets = await actual.getBudgets();
    if (budgets.length === 0) {
      importSection.hidden = false;
      message.textContent = '';
      return;
    }
    selector.replaceChildren(...budgets.map(budget => new Option(budget.name, budget.id)));
    budgetSection.hidden = false;
    selector.addEventListener('change', () => { void loadSelectedBudget(); });
    await loadSelectedBudget();
  } catch (error) {
    message.textContent = errorMessage(error);
  }
}

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {
    message.textContent = 'オフライン用の画面を準備できませんでした。オンラインで再読込してください。';
  });
}
void start();
