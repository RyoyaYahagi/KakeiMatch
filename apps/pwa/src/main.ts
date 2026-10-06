import { LocalDataStorageError } from '../../../src/lib/local-data';
import { initializeLocalUi } from './local-ui';
import { initializeDeveloperCostsUi } from './developer-costs-ui';
import { createAuthClient } from 'better-auth/client';
import { passkeyClient } from '@better-auth/passkey/client';
import { clearAiAccessToken, getAiAccessToken } from './ai-auth';
import { setNavActive } from './app-nav';
import { initializeContactUi } from './contact-ui';
import { recordDiagnosticAction, recordDiagnosticFailure, recordDiagnosticNetwork, recordDiagnosticScreen } from './contact-diagnostics';
import { iconMarkup } from './ui-icons';
import { renderOssLicenses } from './oss-licenses';
import { observeAppUpdates } from './app-updates';
import { initializeDiagnosticsUi } from './local-diagnostics-ui';
import { initializeLocalScreenLock } from './local-screen-lock';
import { recordLocalDiagnostic } from './local-diagnostics';
import { captureFamilyInvite, clearFamilyInvite, fetchSignupConfig, pendingFamilyInvite, renderBotCheck } from './account-signup';
import { downloadLocalDataRescue } from './local-data-rescue';
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
      <button id="migration-rescue-export" class="secondary" type="button">救出データを書き出す</button>
      <p id="migration-rescue-status" role="status" aria-live="polite"></p>
    </section>
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
      <div id="settings-content">
      <div class="page-header"><h2>設定</h2></div>
      <h3 class="settings-group-title">家計簿</h3>
      <section id="local-settings" class="surface-section settings-list" aria-label="家計簿の設定"></section>
      <h3 class="settings-group-title">データ</h3>
      <div id="data-settings" class="settings-stack">
        <section class="surface-section storage-location" aria-labelledby="storage-location-title">
          <h4 id="storage-location-title">保存先</h4>
          <p class="storage-location-device">${iconMarkup('phone')}<strong>この端末</strong></p>
          <p>家計簿・レシート・明細・照合結果は、この端末に保存されています。</p>
          <p class="muted">家計データはCloudflareに保存しません。AIアカウントの認証や利用枠の情報はCloudflareで管理します。AIを利用する場合だけ、処理に必要な情報をAIサービスへ送信します。</p>
          <p class="storage-location-risk">端末の紛失やブラウザーのデータ消去で、家計データが失われることがあります。バックアップを別の場所に保存してください。</p>
          <a class="storage-location-link" href="#backup-settings">バックアップと端末データ${iconMarkup('chevronRight')}</a>
        </section>
      </div>
      <h3 class="settings-group-title">写真の読み取り</h3>
      <section id="ai-settings" class="surface-section settings-panel" aria-label="AI利用">
      <div class="ai-status">
        <span class="record-icon record-icon-large tone-daily">${iconMarkup('scan')}</span>
        <div><h4>AIアカウント</h4><p id="account-status" class="muted"></p></div>
      </div>
      <div class="ai-usage">
        <p id="usage-summary" aria-live="polite">利用状況を読み込んでいます…</p>
        <div id="usage-meter" class="usage-meter" hidden><span></span></div>
        <p class="muted">レシートの読み取りとカテゴリ提案で1回です。音声の文字起こしとお問い合わせの送信は、それぞれ1回ずつ利用します。お問い合わせの深掘りを使う場合は、AIへの質問1回ごとに利用枠を1回使います。レシートを読み取り直すと新たに1回使います。毎月1日の午前0時（日本時間）に利用枠が更新されます。</p>
      </div>
      <div id="family-invite" class="family-invite" hidden>
        <p><strong>家族プランの招待</strong></p>
        <p id="family-invite-text"></p>
        <button id="family-invite-accept" type="button" hidden>家族プランを受け取る</button>
        <button id="family-invite-dismiss" class="text-button" type="button">この招待を使わない</button>
      </div>
      <div id="signed-out-actions" hidden>
        <p>AI機能を利用するにはアカウントが必要です。家計簿の閲覧や編集はこの端末で引き続き利用できます。</p>
        <button id="passkey-login" type="button">Passkeyで続ける</button>
        <button id="signup-start" class="secondary" type="button">新規登録</button>
        <button id="invite-register" class="secondary" type="button" hidden>招待コードで登録</button>
        <button id="manual-entry" class="secondary" type="button">家計簿に戻る</button>
        <form id="signup-form" class="signup-form" hidden novalidate>
          <h5>新規登録</h5>
          <p class="muted">登録すると無料プランで始まります。毎月の読み取り回数に上限があります。登録にはこの端末のPasskey（顔認証・指紋認証など）を使います。</p>
          <label for="signup-name">表示名</label>
          <input id="signup-name" name="name" autocomplete="nickname" maxlength="120" required />
          <label for="signup-email">メールアドレス</label>
          <input id="signup-email" name="email" type="email" autocomplete="email" maxlength="254" required />
          <p class="muted">アカウントの識別に使います。確認メールやお知らせは送信しません。</p>
          <div id="signup-bot-check" class="signup-bot-check"></div>
          <button id="signup-submit" type="submit" disabled>Passkeyを作成して登録</button>
          <button id="signup-cancel" class="text-button" type="button">キャンセル</button>
        </form>
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
        <button id="add-passkey" class="secondary" type="button">Passkeyを追加</button>
        <button id="logout" class="text-button" type="button">ログアウト</button>
        <p class="muted">ログアウトしても、この端末の家計簿はそのまま使えます。</p>
        <div class="account-delete-zone">
          <p class="muted">Cloud accountを削除しても、家計簿・レシート・明細・照合記録はこの端末に残り、閲覧やバックアップを続けられます。端末内データの全削除は別の操作です。</p>
          <button id="delete-account" class="text-button destructive-text" type="button">アカウントを削除</button>
        </div>
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
      <section id="oss-licenses" class="oss-licenses" aria-labelledby="oss-licenses-title">
        <h3 id="oss-licenses-title">オープンソースライセンス</h3>
      </section>
      <h3 class="settings-group-title">サポート</h3>
      <section class="surface-section settings-list" aria-label="サポート">
        <button id="settings-contact" class="master-entry" type="button" aria-label="お問い合わせ">お問い合わせ</button>
      </section>
      </div>
      <section id="contact-view" hidden></section>
    </section>
  </main>`;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
renderOssLicenses(element<HTMLElement>('oss-licenses'));
initializeDiagnosticsUi(element<HTMLElement>('app-info'));
initializeLocalScreenLock(element<HTMLElement>('app-shell'), element<HTMLElement>('settings-content'));
const message = element<HTMLParagraphElement>('message');
const network = element<HTMLElement>('network');
const householdView = element<HTMLElement>('household-view');
const settingsView = element<HTMLElement>('settings-view');
const settingsContent = element<HTMLElement>('settings-content');
const contactView = element<HTMLElement>('contact-view');
const homeTab = element<HTMLButtonElement>('home-tab');
const settingsTab = element<HTMLButtonElement>('settings-tab');
const contactUi = initializeContactUi(contactView, {
  onBackToSettings: (focusLogin = false) => {
    settingsContent.hidden = false;
    contactView.hidden = true;
    if (focusLogin) {
      void refreshAccount();
      element<HTMLElement>('ai-settings').scrollIntoView({ block: 'start' });
      window.setTimeout(() => (signedOutActions.hidden ? useAiButton : loginButton).focus(), 0);
    }
  },
});
const usageSummary = element<HTMLParagraphElement>('usage-summary');
const accountStatus = element<HTMLParagraphElement>('account-status');
const signedOutActions = element<HTMLElement>('signed-out-actions');
const signedInActions = element<HTMLElement>('signed-in-actions');
const accountMessage = element<HTMLParagraphElement>('account-message');
const passkeyList = element<HTMLUListElement>('passkey-list');
const loginButton = element<HTMLButtonElement>('passkey-login');
const inviteButton = element<HTMLButtonElement>('invite-register');
const signupStartButton = element<HTMLButtonElement>('signup-start');
const signupForm = element<HTMLFormElement>('signup-form');
const signupName = element<HTMLInputElement>('signup-name');
const signupEmail = element<HTMLInputElement>('signup-email');
const signupSubmit = element<HTMLButtonElement>('signup-submit');
const signupBotCheck = element<HTMLElement>('signup-bot-check');
const familyInvitePanel = element<HTMLElement>('family-invite');
const familyInviteText = element<HTMLParagraphElement>('family-invite-text');
const familyInviteAccept = element<HTMLButtonElement>('family-invite-accept');
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
    renderFamilyInvite(signedIn);
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
    ? `今月の読み取り ${usage.used}回 · ${planName} · 上限なし`
    : `今月の読み取り ${usage.used} / ${usage.limit}回 · ${planName}`;
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

function renderFamilyInvite(signedIn: boolean) {
  const pending = pendingFamilyInvite() !== null;
  familyInvitePanel.hidden = !pending;
  familyInviteAccept.hidden = !signedIn;
  familyInviteText.textContent = signedIn
    ? '受け取ると、このアカウントは毎月の読み取り回数の上限がない家族プランになります。'
    : '招待を受け取るには、Passkeyでログインするか、新規登録してください。';
}

let botCheck: Awaited<ReturnType<typeof renderBotCheck>> | null = null;

// The open form owns the screen's single primary action, so the other entry buttons step aside.
function setSignupFormOpen(open: boolean) {
  signupForm.hidden = !open;
  for (const button of [signupStartButton, loginButton, manualButton]) button.hidden = open;
}

function closeSignupForm() {
  setSignupFormOpen(false);
  botCheck?.remove();
  botCheck = null;
}

signupStartButton.addEventListener('click', () => {
  signupStartButton.disabled = true;
  accountMessage.textContent = '';
  void fetchSignupConfig().then(async config => {
    if (!config.signupAvailable || !config.turnstileSiteKey) throw new Error('signup_unavailable');
    setSignupFormOpen(true);
    botCheck = await renderBotCheck(signupBotCheck, config.turnstileSiteKey, ready => { signupSubmit.disabled = !ready; });
    signupName.focus();
  }).catch(() => {
    closeSignupForm();
    accountMessage.textContent = '現在は新規登録を利用できません。時間をおいて、もう一度お試しください。';
  }).finally(() => { signupStartButton.disabled = false; });
});

element<HTMLButtonElement>('signup-cancel').addEventListener('click', () => {
  closeSignupForm();
  signupStartButton.focus();
});

signupForm.addEventListener('submit', event => {
  event.preventDefault();
  const name = signupName.value.trim();
  const email = signupEmail.value.trim();
  if (!name || !signupEmail.checkValidity() || !email) {
    accountMessage.textContent = '表示名とメールアドレスを入力してください。';
    (name ? signupEmail : signupName).focus();
    return;
  }
  const turnstileToken = botCheck?.token();
  if (!turnstileToken) {
    accountMessage.textContent = '確認が完了するまでお待ちください。';
    return;
  }
  signupSubmit.disabled = true;
  accountMessage.textContent = 'アカウントを準備しています…';
  void fetch('/api/account/signup', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, turnstileToken }),
  }).then(async response => {
    if (!response.ok) {
      const result = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(result?.error ?? 'signup_failed');
    }
    const { context } = await response.json() as { context: string };
    accountMessage.textContent = 'Passkeyを登録しています…';
    const result = await authClient.passkey.addPasskey({ name: 'この端末', context, createSession: true });
    if (result.error) throw new Error('passkey_failed');
    closeSignupForm();
    signupForm.reset();
    await refreshAccount();
    await issueAiToken();
  }).catch(error => {
    const code = error instanceof Error ? error.message : '';
    accountMessage.textContent = code === 'email_unavailable'
      ? 'このメールアドレスは登録できません。登録済みの場合は「Passkeyで続ける」からログインしてください。'
      : code === 'rate_limited'
        ? '登録の試行が多すぎます。1分ほど待ってから、もう一度お試しください。'
        : code === 'passkey_failed'
          ? 'Passkeyを登録できませんでした。もう一度お試しください。'
          : '登録できませんでした。入力内容とオンライン状態を確認して、もう一度お試しください。';
    botCheck?.reset();
  });
});

familyInviteAccept.addEventListener('click', () => {
  const token = pendingFamilyInvite();
  if (!token) return;
  familyInviteAccept.disabled = true;
  accountMessage.textContent = '家族プランを確認しています…';
  void fetch('/api/account/family-invites/accept', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }).then(async response => {
    const result = await response.json().catch(() => null) as { error?: string } | null;
    if (response.status === 401) throw new Error('session_expired');
    if (!response.ok) throw new Error(result?.error ?? 'family_invite_failed');
    clearFamilyInvite();
    await refreshAccount();
    accountMessage.textContent = '家族プランになりました。';
  }).catch(error => {
    const code = error instanceof Error ? error.message : '';
    if (code === 'invalid_family_invite' || code === 'family_limit_reached') clearFamilyInvite();
    renderFamilyInvite(code !== 'session_expired');
    accountMessage.textContent = code === 'invalid_family_invite'
      ? 'この招待は使えません。有効期限が切れたか、使用済みか、別のアカウント向けです。招待した人に新しい招待を依頼してください。'
      : code === 'family_limit_reached'
        ? '家族プランの人数が上限に達しているため、受け取れませんでした。招待した人に確認してください。'
        : code === 'session_expired'
          ? 'ログイン状態を確認できません。Passkeyで再度ログインしてから受け取ってください。'
          : '家族プランを受け取れませんでした。オンライン状態を確認して、もう一度お試しください。';
  }).finally(() => { familyInviteAccept.disabled = false; });
});

element<HTMLButtonElement>('family-invite-dismiss').addEventListener('click', () => {
  clearFamilyInvite();
  familyInvitePanel.hidden = true;
  accountMessage.textContent = '招待を破棄しました。';
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
// Operator recovery links use ?invite=. Family invites arrive in the fragment and are removed from the URL at once.
inviteButton.hidden = !new URLSearchParams(location.search).has('invite');
const familyInviteOpened = captureFamilyInvite();

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
}).finally(() => {
  if (!familyInviteOpened) return;
  showTab('settings');
  familyInvitePanel.scrollIntoView({ block: 'start' });
});
