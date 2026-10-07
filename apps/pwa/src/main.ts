import { LocalDataStorageError } from '../../../src/lib/local-data';
import { initializeLocalUi } from './local-ui';
import { initializeDeveloperCostsUi } from './developer-costs-ui';
import { createAuthClient } from 'better-auth/client';
import { passkeyClient } from '@better-auth/passkey/client';
import { clearAiAccessToken, getAiAccessToken } from './ai-auth';
import { guestUsage, type GuestUsage } from './guest-ai';
import { setNavActive } from './app-nav';
import { initializeContactUi } from './contact-ui';
import { recordDiagnosticAction, recordDiagnosticFailure, recordDiagnosticNetwork, recordDiagnosticScreen } from './contact-diagnostics';
import { iconMarkup } from './ui-icons';
import { renderOssLicenses } from './oss-licenses';
import { observeAppUpdates } from './app-updates';
import { initializeDiagnosticsUi } from './local-diagnostics-ui';
import { initializeLocalScreenLock } from './local-screen-lock';
import { recordLocalDiagnostic } from './local-diagnostics';
import { downloadLocalDataRescue } from './local-data-rescue';
import { initializeThemeSettings } from './theme-settings';
import './style.css';

const authClient = createAuthClient({ baseURL: location.origin, plugins: [passkeyClient()] });

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('App root is missing');
root.innerHTML = `
  <main id="app-shell">
    <h1 class="visually-hidden">KakeiMatch</h1>
    <p class="network-status" id="network" role="status" hidden></p>
    <p class="network-status" id="app-update-notice" role="status" hidden></p>
    <nav class="app-nav" aria-label="アプリ">
      <p class="nav-brand" aria-hidden="true">KakeiMatch</p>
      <button id="home-tab" class="nav-button active" type="button" aria-pressed="true" aria-current="page">${iconMarkup('home')}<span>ホーム</span></button>
      <button id="receipt-tab" class="nav-button" type="button" aria-pressed="false">${iconMarkup('records')}<span>記録</span></button>
      <button id="add-record" class="nav-add" type="button" aria-label="記録を追加"><span class="nav-add-circle">${iconMarkup('add')}</span><span><span class="nav-add-prefix">記録を</span>追加</span></button>
      <button id="reconciliation-tab" class="nav-button" type="button" aria-pressed="false">${iconMarkup('reconciliation')}<span>照合</span><span id="reconciliation-badge" class="nav-badge" aria-hidden="true" hidden></span></button>
      <button id="settings-tab" class="nav-button" type="button" aria-pressed="false">${iconMarkup('settings')}<span>設定</span></button>
    </nav>
    <p class="status" id="message" role="status"></p>
    <section id="migration-rescue" class="surface-section migration-rescue" aria-labelledby="migration-rescue-title" hidden>
      <h2 id="migration-rescue-title">端末データの救出</h2>
      <p>更新に失敗した場合や、新しい版のデータをこのアプリが開けない場合に、対応済みのKakeiMatch記録を読み取り専用で書き出せます。</p>
      <p>このファイルを読み込んで復元することはできません。救出後はアプリを修正版へ更新し、再読み込みして開き直してください。</p>
      <p class="migration-rescue-warning">これは完全な家計バックアップではありません。Actual Budgetの家計簿と未対応の新しい種類のデータは含まず、このファイルから復元できません。画面ロック設定、クラウドのログイン情報、同期のための暗号鍵も含みません。</p>
      <button id="migration-rescue-export" class="secondary" type="button">${iconMarkup('income')}救出データを書き出す</button>
      <p id="migration-rescue-status" role="status" aria-live="polite"></p>
    </section>
    <section id="household-view">
    <section id="import-section" hidden>
      <p>既存の家計簿があれば、記録を始める前にZIPファイルを読み込めます。</p>
      <button id="import-button" class="secondary" type="button">${iconMarkup('upload')}既存の家計簿を取り込む</button>
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
      <div id="settings-content">
      <div id="settings-root">
      <div class="page-header"><h2>設定</h2></div>
      <h3 class="settings-group-title">家計簿</h3>
      <section id="local-settings" class="surface-section settings-list" aria-label="家計簿の設定"></section>
      <h3 class="settings-group-title">データ</h3>
      <section id="backup-quick" class="surface-section backup-quick" aria-label="バックアップの状況"></section>
      <section id="data-rows" class="surface-section settings-list" aria-label="データの設定">
        <button class="master-entry" type="button" data-settings-page="settings-page-ledger" aria-label="バックアップと復元"><span class="master-entry-name">バックアップと復元</span></button>
        <button class="master-entry" type="button" data-settings-page="settings-page-lock" aria-label="画面ロック"><span class="master-entry-name">画面ロック</span><span id="screen-lock-row-value" class="master-entry-value"></span></button>
        <button class="master-entry destructive-text" type="button" data-settings-page="settings-page-cleanup" aria-label="原本の整理・全削除"><span class="master-entry-name">原本の整理・全削除</span></button>
      </section>
      <h3 class="settings-group-title">写真の読み取り</h3>
      <section class="surface-section settings-list" aria-label="写真の読み取りの設定">
        <button class="master-entry" type="button" data-settings-page="settings-page-ai" aria-label="ログイン・利用状況"><span class="master-entry-name">ログイン・利用状況</span><span id="ai-row-value" class="master-entry-value"></span></button>
      </section>
      <h3 class="settings-group-title">アプリ</h3>
      <section class="surface-section settings-list" aria-label="アプリの設定">
        <button class="master-entry" type="button" data-settings-page="settings-page-theme" aria-label="外観"><span class="master-entry-name">外観</span><span id="theme-row-value" class="master-entry-value"></span></button>
        <button id="settings-contact" class="master-entry" type="button" aria-label="お問い合わせ"><span class="master-entry-name">お問い合わせ</span><span class="master-entry-value">声でも送れます</span></button>
        <button class="master-entry" type="button" data-settings-page="settings-page-app" aria-label="アプリ情報"><span class="master-entry-name">アプリ情報</span><span class="master-entry-value">診断・ライセンス</span></button>
      </section>
      <p class="settings-foot">家計簿と画像はこの端末に保存されます。ログアウトしても消えません。</p>
      </div>
      <section id="settings-page-theme" class="settings-page" hidden aria-labelledby="settings-page-theme-title">
        <button class="text-button back-link" type="button" data-settings-back aria-label="設定へ戻る">${iconMarkup('chevronLeft')}設定</button>
        <h2 id="settings-page-theme-title" class="page-title">外観</h2>
        <label for="theme-preference">表示モード</label>
        <select id="theme-preference" aria-describedby="theme-description">
          <option value="light">ライト</option>
          <option value="dark">ダーク</option>
          <option value="system">システム</option>
        </select>
        <p id="theme-description" class="muted">「システム」は端末の外観設定に合わせて切り替えます。この設定はこの端末のブラウザーに保存されます。</p>
        <p id="theme-status" class="status" role="status"></p>
      </section>
      <section id="settings-page-ledger" class="settings-page" hidden aria-labelledby="settings-page-ledger-title">
        <button class="text-button back-link" type="button" data-settings-back aria-label="設定へ戻る">${iconMarkup('chevronLeft')}設定</button>
        <h2 id="settings-page-ledger-title" class="page-title">バックアップと復元</h2>
      <div id="data-settings" class="settings-stack">
        <section class="surface-section storage-location" aria-labelledby="storage-location-title">
          <h4 id="storage-location-title">保存先</h4>
          <p class="storage-location-device">${iconMarkup('phone')}<strong>この端末</strong></p>
          <p>家計簿・レシート・明細・照合結果は、この端末に保存されています。</p>
          <p class="muted">家計データはCloudflareに保存しません。AIアカウントの認証や利用枠の情報はCloudflareで管理します。AIを利用する場合だけ、処理に必要な情報をAIサービスへ送信します。</p>
          <p class="storage-location-risk">端末の紛失やブラウザーのデータ消去で、家計データが失われることがあります。バックアップを別の場所に保存してください。</p>
        </section>
      </div>
      </section>
      <section id="settings-page-lock" class="settings-page" hidden aria-labelledby="settings-page-lock-title">
        <button class="text-button back-link" type="button" data-settings-back aria-label="設定へ戻る">${iconMarkup('chevronLeft')}設定</button>
        <h2 id="settings-page-lock-title" class="page-title">画面ロック</h2>
      <div id="screen-lock-host"></div>
      </section>
      <section id="settings-page-cleanup" class="settings-page" hidden aria-labelledby="settings-page-cleanup-title">
        <button class="text-button back-link" type="button" data-settings-back aria-label="設定へ戻る">${iconMarkup('chevronLeft')}設定</button>
        <h2 id="settings-page-cleanup-title" class="page-title">原本の整理・全削除</h2>
      <div id="cleanup-host"></div>
      </section>
      <section id="settings-page-ai" class="settings-page" hidden aria-labelledby="settings-page-ai-title">
        <button class="text-button back-link" type="button" data-settings-back aria-label="設定へ戻る">${iconMarkup('chevronLeft')}設定</button>
        <h2 id="settings-page-ai-title" class="page-title">ログイン・利用状況</h2>
      <section id="ai-settings" class="surface-section settings-panel" aria-label="AI利用">
      <div class="ai-status">
        <span class="record-icon record-icon-large tone-daily">${iconMarkup('scan')}</span>
        <div><h4>AIアカウント</h4><p id="account-status" class="muted"></p></div>
      </div>
      <div class="ai-usage">
        <p id="usage-summary" aria-live="polite">利用状況を読み込んでいます…</p>
        <div id="usage-meter" class="usage-meter" hidden><span></span></div>
        <p class="muted">レシートの読み取りとカテゴリ提案で1回です。読み取り直すと新たに1回使います。お問い合わせのAI機能は回数に数えません。ログインしていない時は1日5回までで、毎日午前0時（日本時間）に戻ります。ログイン中はプランの回数で、毎月1日の午前0時に戻ります。</p>
      </div>
      <div id="signed-out-actions" hidden>
        <p>ログインしなくても、AIを1日5回まで使えます。初めて使う時だけ、ロボットでないことを確かめます。サーバーに記録するのはAIの利用回数だけで、家計データは保存しません。家計簿の閲覧や編集はこの端末で引き続き利用できます。</p>
        <button id="passkey-login" class="primary" type="button">Passkeyで続ける</button>
        <button id="invite-register" class="secondary" type="button">${iconMarkup('key')}招待コードで登録</button>
        <button id="manual-entry" class="secondary" type="button">家計簿に戻る</button>
      </div>
      <div id="signed-in-actions" hidden>
        <button id="use-ai" class="secondary" type="button">AI利用を確認</button>
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
        <button id="add-passkey" class="secondary" type="button">${iconMarkup('add')}Passkeyを追加</button>
        <button id="logout" class="text-button" type="button">ログアウト</button>
        <p class="muted">ログアウトしても、この端末の家計簿はそのまま使えます。</p>
        <div class="account-delete-zone">
          <p class="muted">Cloud accountを削除しても、家計簿・レシート・明細・照合記録はこの端末に残り、閲覧やバックアップを続けられます。端末内データの全削除は別の操作です。</p>
          <button id="delete-account" class="text-button destructive-text" type="button">アカウントを削除</button>
        </div>
      </div>
      <p class="status" id="account-message" role="status"></p>
      </section>
      </section>
      <section id="settings-page-app" class="settings-page" hidden aria-labelledby="settings-page-app-title">
        <button class="text-button back-link" type="button" data-settings-back aria-label="設定へ戻る">${iconMarkup('chevronLeft')}設定</button>
        <h2 id="settings-page-app-title" class="page-title">アプリ情報</h2>
      <section id="app-info" class="surface-section settings-panel">
        <label class="developer-option" for="developer-options">
          <input id="developer-options" type="checkbox" />
          開発者向け機能を表示
        </label>
        <p class="muted">この設定はこの端末のブラウザーだけに保存され、バックアップには含まれません。</p>
        <p id="developer-options-status" class="status" role="status"></p>
      </section>
      <section id="oss-licenses" class="oss-licenses" aria-labelledby="oss-licenses-title">
        <h3 id="oss-licenses-title">オープンソースライセンス</h3>
      </section>
      </section>
      </div>
      <section id="contact-view" hidden></section>
    </section>
  </main>`;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
renderOssLicenses(element<HTMLElement>('oss-licenses'));
initializeThemeSettings();
initializeDiagnosticsUi(element<HTMLElement>('app-info'));
initializeLocalScreenLock(element<HTMLElement>('app-shell'), element<HTMLElement>('settings-content'));
const message = element<HTMLParagraphElement>('message');
const network = element<HTMLElement>('network');
const householdView = element<HTMLElement>('household-view');
const settingsView = element<HTMLElement>('settings-view');
const settingsContent = element<HTMLElement>('settings-content');
const settingsRoot = element<HTMLElement>('settings-root');
// docs/UX.md 設定: the settings screen is one-line entries; each opens its own page with a way back.
function showSettingsRoot() {
  settingsRoot.hidden = false;
  settingsContent.querySelectorAll<HTMLElement>('.settings-page').forEach(page => { page.hidden = true; });
}
function openSettingsPage(id: string) {
  settingsRoot.hidden = true;
  settingsContent.querySelectorAll<HTMLElement>('.settings-page').forEach(page => { page.hidden = page.id !== id; });
  window.scrollTo({ top: 0 });
  element<HTMLElement>(`${id}-title`).focus({ preventScroll: true });
}
settingsContent.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target : null;
  const entry = target?.closest<HTMLElement>('[data-settings-page]');
  if (entry) { openSettingsPage(entry.dataset.settingsPage!); return; }
  const back = target?.closest('[data-settings-back]');
  if (back) {
    const page = back.closest('.settings-page')!.id;
    showSettingsRoot();
    settingsContent.querySelector<HTMLElement>(`[data-settings-page="${page}"]`)?.focus();
  }
});
settingsContent.querySelectorAll<HTMLElement>('.settings-page .page-title').forEach(title => { title.tabIndex = -1; });
const contactView = element<HTMLElement>('contact-view');
const homeTab = element<HTMLButtonElement>('home-tab');
const settingsTab = element<HTMLButtonElement>('settings-tab');
const contactUi = initializeContactUi(contactView, {
  onBackToSettings: (focusLogin = false) => {
    settingsContent.hidden = false;
    contactView.hidden = true;
    if (focusLogin) {
      void refreshAccount();
      openSettingsPage('settings-page-ai');
      window.setTimeout(() => (signedOutActions.hidden ? useAiButton : loginButton).focus(), 0);
    }
  },
});
const usageSummary = element<HTMLParagraphElement>('usage-summary');
const aiRowValue = element<HTMLElement>('ai-row-value');
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
const deleteAccountButton = element<HTMLButtonElement>('delete-account');
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
  recordDiagnosticAction(tab === 'home' ? 'navigate_home' : 'navigate_settings', tab);
  recordDiagnosticScreen(tab);
  contactUi.close();
  settingsContent.hidden = false;
  showSettingsRoot();
  contactView.hidden = true;
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

element<HTMLButtonElement>('settings-contact').addEventListener('click', () => {
  recordDiagnosticAction('open_contact', 'settings');
  recordDiagnosticScreen('contact');
  settingsContent.hidden = true;
  contactView.hidden = false;
  contactUi.open();
});

document.querySelector('nav.app-nav')!.addEventListener('click', event => {
  const target = event.target;
  if (target instanceof Element && target.closest('button')?.id !== 'settings-tab' && contactUi.isOpen()) {
    contactUi.close();
    settingsContent.hidden = false;
    contactView.hidden = true;
  }
}, { capture: true });

homeTab.addEventListener('click', () => showTab('home'));
settingsTab.addEventListener('click', () => showTab('settings'));

type SessionResponse = { user: { name?: string; email?: string }; session: { expiresAt: string } } | null;
type UsageResponse = { plan: 'free' | 'pro' | 'family'; used: number; limit: number | null; remaining: number | null } | GuestUsage;
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
      accountStatus.textContent = '未ログインです。';
      const guest = await guestUsage().catch(() => undefined);
      if (guest) renderUsage(guest);
      else {
        element<HTMLElement>('usage-meter').hidden = true;
        usageSummary.textContent = guest === undefined ? '今日の利用回数を取得できません。オンラインで再度お試しください。' : 'ログインしなくても、AIの読み取りを1日5回まで使えます。';
        aiRowValue.textContent = guest === undefined ? '' : '1日5回まで';
      }
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
    aiRowValue.textContent = '';
    usageSummary.textContent = '利用状況を取得できません。オンラインで再度お試しください。';
    accountStatus.textContent = 'AIアカウントへ接続できません。家計簿のデータはこの端末で引き続き利用できます。';
    signedOutActions.hidden = true;
    signedInActions.hidden = true;
    developerCostsUi.setSignedIn(false);
  }
}

function renderUsage(usage: UsageResponse) {
  if (usage.plan === 'guest') {
    usageSummary.textContent = `今日のAI読み取り ${usage.used} / ${usage.limit}回 · 登録なし`;
    aiRowValue.textContent = `今日 ${usage.used}/${usage.limit}回`;
    const meter = element<HTMLElement>('usage-meter');
    meter.hidden = false;
    meter.style.setProperty('--usage', `${Math.min(100, Math.round(usage.used / Math.max(1, usage.limit) * 100))}%`);
    return;
  }
  const planName = usage.plan === 'family' ? 'Plus' : usage.plan === 'pro' ? 'Pro' : 'Free';
  usageSummary.textContent = usage.limit === null
    ? `今月の読み取り ${usage.used}回 · ${planName} · 上限なし`
    : `今月の読み取り ${usage.used} / ${usage.limit}回 · ${planName}`;
  aiRowValue.textContent = usage.limit === null ? `今月 ${usage.used}回` : `今月 ${usage.used}/${usage.limit}回`;
  // The meter only repeats the text above; the text stays the source for assistive technology.
  const meter = element<HTMLElement>('usage-meter');
  meter.hidden = usage.limit === null;
  if (usage.limit !== null) meter.style.setProperty('--usage', `${Math.min(100, Math.round(usage.used / Math.max(1, usage.limit) * 100))}%`);
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
    await getAiAccessToken({ allowGuest: false });
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

deleteAccountButton.addEventListener('click', () => {
  if (!window.confirm('Cloud accountを削除します。Passkey、ログイン状態、AI利用情報も削除され、元に戻せません。\n\nこの端末の家計簿・レシート・明細・照合記録は残ります。')) return;
  if (window.prompt('確認のため「アカウントを削除」と入力してください。') !== 'アカウントを削除') return;

  deleteAccountButton.disabled = true;
  accountMessage.textContent = 'アカウントを削除しています…';
  void fetch('/api/account/delete', {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  }).then(async response => {
    if (!response.ok) {
      if (response.status === 401) throw new Error('session_expired');
      throw new Error('deletion_incomplete');
    }
    const result = await response.json() as { deleted?: unknown };
    if (result.deleted !== true) throw new Error('deletion_incomplete');
    clearAiAccessToken();
    signedInActions.hidden = true;
    signedOutActions.hidden = false;
    developerCostsUi.setSignedIn(false);
    accountStatus.textContent = '未ログインです。';
    usageSummary.textContent = 'アカウントを削除しました。';
    accountMessage.textContent = '家計簿・レシート・明細・照合記録はこの端末に残っています。引き続き利用できます。';
  }).catch(error => {
    accountMessage.textContent = error instanceof Error && error.message === 'session_expired'
      ? 'ログイン状態を確認できません。ページを再読み込みしてください。'
      : '削除を完了できませんでした。オンライン状態を確認して、もう一度お試しください。';
  }).finally(() => { deleteAccountButton.disabled = false; });
});

useAiButton.addEventListener('click', () => { void issueAiToken(); });

function showNetwork() {
  network.hidden = navigator.onLine;
  network.textContent = navigator.onLine ? '' : 'オフライン';
  recordDiagnosticNetwork(navigator.onLine);
}
window.addEventListener('online', showNetwork);
window.addEventListener('offline', showNetwork);
recordDiagnosticScreen('home');
window.addEventListener('error', () => recordDiagnosticFailure(new Error('unhandled_ui_error')));
window.addEventListener('unhandledrejection', () => recordDiagnosticFailure(new Error('unhandled_ui_rejection')));
showNetwork();

const migrationRescue = element<HTMLElement>('migration-rescue');
const migrationRescueButton = element<HTMLButtonElement>('migration-rescue-export');
const migrationRescueStatus = element<HTMLElement>('migration-rescue-status');
migrationRescueButton.addEventListener('click', () => {
  migrationRescueButton.disabled = true;
  migrationRescueStatus.textContent = '既存の端末データを読み取っています…';
  void downloadLocalDataRescue().then(() => {
    migrationRescueStatus.textContent = '救出データを書き出しました。公開せず、安全な場所に保管してください。';
  }).catch((error: unknown) => {
    migrationRescueStatus.textContent = error instanceof Error ? error.message : '救出データを書き出せませんでした。端末内データは変更していません。';
  }).finally(() => { migrationRescueButton.disabled = false; });
});

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').then(registration => {
    observeAppUpdates(registration, element<HTMLElement>('app-update-notice'));
  }).catch(() => {
    recordLocalDiagnostic('startup', { code: 'service_worker_failed' });
    message.textContent = 'オフライン用の画面を準備できませんでした。オンラインで再読込してください。';
  });
}
message.textContent = '家計簿を準備しています…';
void initializeLocalUi({ openAccount: () => showTab('settings') }).then(() => {
  recordLocalDiagnostic('startup');
}).catch((error: unknown) => {
  recordLocalDiagnostic(error instanceof LocalDataStorageError && (error.code === 'migration_failed' || error.code === 'future_schema') ? 'migration' : 'startup', error);
  message.textContent = error instanceof LocalDataStorageError ? error.message : '端末の家計簿を開けませんでした。保存状態を確認し、再読込してください。';
  const canRescue = error instanceof LocalDataStorageError && (error.code === 'migration_failed' || error.code === 'future_schema');
  migrationRescue.hidden = !canRescue;
  if (canRescue) {
    for (const id of ['home-tab', 'receipt-tab', 'add-record', 'reconciliation-tab']) {
      element<HTMLElement>(id).hidden = true;
    }
    householdView.hidden = true;
    element<HTMLElement>('local-view').hidden = true;
  }
});
