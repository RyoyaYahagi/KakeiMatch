import './style.css';
import './admin.css';

type Overview = {
  accounts: { registered: number; activeToday: number; activeLast30Days: number; usedAiToday: number; usedAiLast30Days: number };
  ai: { requestsToday: number; requestsLast30Days: number; monthUsdMicros: number; unknownRequests: number; last30DaysErrors: number; last30DaysRateLimits: number };
  feedback: { open: number };
  recentErrors: Array<{ code: string; requests: number; lastSeen: number }>;
};
type ProviderCosts = { requests: number; inputTokens: number; outputTokens: number; costUsdMicros: number; unknownRequests: number };
type Costs = { month: string; currency: 'USD'; totalUsdMicros: number; unknownRequests: number; providers: { gemini: ProviderCosts; jev: ProviderCosts } };
type AdminUser = { id: string; plan: string; createdAt: string | number; lastAiUseAt: string | number | null; aiRequests: number; kind: string; enabled: boolean };
type AdminError = { code: string; requests: number; lastSeen: number };
type Feedback = { id: string; kind: string | null; status: string; message: string; createdAt: string | number; updatedAt?: string | number; aiSummary?: string | null; diagnostics?: unknown; githubIssueNumber?: number | null; githubIssueUrl?: string | null };

const app = document.querySelector<HTMLDivElement>('#admin-app');
if (!app) throw new Error('Admin app root is missing');

const monthNow = () => {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).formatToParts();
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}`;
};
const monthShift = (value: string, delta: number) => {
  const [year, month] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1, 12));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};
const usd = (micros: number) => `US$${(micros / 1_000_000).toFixed(4)}`;
const count = (value: number) => value.toLocaleString('ja-JP');
const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function validProvider(value: unknown): value is ProviderCosts {
  if (!value || typeof value !== 'object') return false;
  const provider = value as Record<string, unknown>;
  return safeCount(provider.requests) && safeCount(provider.inputTokens) && safeCount(provider.outputTokens) && safeCount(provider.costUsdMicros) && safeCount(provider.unknownRequests);
}
const dateLabel = (value: string | number | null | undefined) => {
  if (value == null) return '—';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tokyo' }).format(date);
};
const element = <T extends HTMLElement>(tag: string, className?: string, text?: string) => {
  const node = document.createElement(tag) as T;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text: string, action: () => void, className = 'secondary') => {
  const node = element<HTMLButtonElement>('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
};

app.innerHTML = `
  <main class="admin-main">
    <header class="admin-header">
      <div><p class="admin-eyebrow">KAKEIMATCH / OPERATIONS</p><h1>管理画面</h1><p class="muted">家計データは表示しません。</p></div>
      <a class="text-button admin-exit" href="/">アプリへ戻る</a>
    </header>
    <p id="admin-status" class="status" role="status" aria-live="polite">運用情報を読み込んでいます…</p>
    <nav class="admin-nav" aria-label="管理画面" role="tablist">
      <button type="button" role="tab" aria-selected="true" data-panel="overview">概要</button>
      <button type="button" role="tab" aria-selected="false" data-panel="feedback">お問い合わせ</button>
      <button type="button" role="tab" aria-selected="false" data-panel="ai">AI利用</button>
      <button type="button" role="tab" aria-selected="false" data-panel="errors">エラー</button>
      <button type="button" role="tab" aria-selected="false" data-panel="users">ユーザー</button>
    </nav>
    <section id="admin-panel-overview" class="admin-panel" role="tabpanel" aria-label="概要"><div id="overview-content"></div></section>
    <section id="admin-panel-feedback" class="admin-panel" role="tabpanel" aria-label="お問い合わせ" hidden>
      <div class="admin-section-heading"><div><h2>お問い合わせ Inbox</h2><p class="muted">内容を確認してから、必要なものだけAI分析やIssue作成を行います。</p></div><div class="admin-tools"><label for="feedback-status-filter">状態</label><select id="feedback-status-filter"><option value="">すべて</option><option value="new">新着</option><option value="reviewing">確認中</option><option value="issue_created">Issue作成済み</option><option value="resolved">対応済み</option><option value="dismissed">対応不要</option></select><button id="feedback-refresh" class="secondary" type="button">更新</button></div></div>
      <div class="admin-columns"><div><h3>受信一覧</h3><ul id="feedback-list" class="admin-list"></ul></div><div id="feedback-detail" class="admin-detail"><p class="empty muted">お問い合わせを選択してください。</p></div></div>
    </section>
    <section id="admin-panel-ai" class="admin-panel" role="tabpanel" aria-label="AI利用" hidden>
      <div class="admin-section-heading"><div><h2>AI利用と費用</h2><p class="muted">全ユーザーの集計です。</p></div><div class="admin-month"><button id="cost-prev" class="secondary" type="button" aria-label="前月">‹</button><strong id="cost-month"></strong><button id="cost-next" class="secondary" type="button" aria-label="翌月">›</button></div></div>
      <div id="cost-content"></div>
    </section>
    <section id="admin-panel-errors" class="admin-panel" role="tabpanel" aria-label="エラー" hidden>
      <div class="admin-section-heading"><div><h2>エラー・運用状況</h2><p class="muted">安全なエラーコードと件数だけを表示します。</p></div><button id="errors-refresh" class="secondary" type="button">更新</button></div>
      <ul id="errors-list" class="admin-list"></ul>
    </section>
    <section id="admin-panel-users" class="admin-panel" role="tabpanel" aria-label="ユーザー" hidden>
      <div class="admin-section-heading"><div><h2>アカウント</h2><p class="muted">家計簿やレシートの内容は含みません。</p></div><button id="users-refresh" class="secondary" type="button">更新</button></div>
      <ul id="users-list" class="admin-list"></ul>
    </section>
  </main>`;

const status = app.querySelector<HTMLElement>('#admin-status')!;
const setStatus = (message: string, error = false) => { status.textContent = message; status.classList.toggle('error', error); };
function clearAdminData() {
  for (const id of ['overview-content', 'cost-content', 'errors-list', 'users-list', 'feedback-list', 'feedback-detail']) {
    app!.querySelector<HTMLElement>(`#${id}`)?.replaceChildren();
  }
  for (const panel of ['overview', 'feedback', 'ai', 'errors', 'users']) panelRequests[panel]++;
  detailRequestId++;
}
async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) clearAdminData();
    throw new Error(response.status === 401 ? 'ログインが必要です。管理者アカウントで開き直してください。' : response.status === 403 ? '管理者権限がありません。' : `管理APIを取得できませんでした（${response.status}）。`);
  }
  return response.json() as Promise<T>;
}
async function postJson<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) clearAdminData();
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    if (response.status === 409 && payload?.error === 'issue_submission_unknown') throw new Error('Issueの作成結果を確認できません。GitHubで受付IDを確認してください。重複を防ぐため再作成は停止しています。');
    throw new Error(response.status === 401 ? 'ログインが必要です。' : response.status === 403 ? '管理者権限がありません。' : `操作を完了できませんでした（${response.status}）。`);
  }
  return response.json() as Promise<T>;
}
function metric(label: string, value: string, hint?: string) {
  const row = element<HTMLElement>('div', 'admin-metric');
  row.append(element('span', 'admin-metric-label', label), element('strong', 'admin-metric-value', value));
  if (hint) row.append(element('small', 'muted', hint));
  return row;
}
function errorView(error: unknown) { setStatus(error instanceof Error ? error.message : '管理情報を取得できませんでした。', true); }

async function loadOverview() {
  const requestId = ++panelRequests.overview;
  try {
    const data = await getJson<Overview>('/api/admin/overview');
    if (requestId !== panelRequests.overview || activePanel !== 'overview') return;
    const host = app!.querySelector<HTMLElement>('#overview-content')!;
    host.replaceChildren();
    const groups: Array<[string, HTMLElement[]]> = [
      ['利用状況', [metric('登録アカウント', count(data.accounts.registered)), metric('今日の利用者', count(data.accounts.activeToday)), metric('直近30日の利用者', count(data.accounts.activeLast30Days))]],
      ['AI・お問い合わせ', [metric('AI要求・今日', count(data.ai.requestsToday)), metric('AI要求・30日', count(data.ai.requestsLast30Days)), metric('今月の費用', usd(data.ai.monthUsdMicros), `料金未確定 ${count(data.ai.unknownRequests)}件`), metric('未対応のお問い合わせ', count(data.feedback.open)), metric('エラー・30日', count(data.ai.last30DaysErrors)), metric('制限・30日', count(data.ai.last30DaysRateLimits))]],
    ];
    for (const [title, metrics] of groups) {
      const section = element<HTMLElement>('section', 'admin-summary-group');
      section.append(element('h2', undefined, title));
      const grid = element<HTMLDivElement>('div', 'admin-metrics');
      grid.append(...metrics); section.append(grid); host.append(section);
    }
    const recent = element<HTMLElement>('section', 'admin-summary-group');
    recent.append(element('h2', undefined, '最近のエラー'));
    const list = element<HTMLUListElement>('ul', 'admin-list');
    if (!data.recentErrors.length) list.append(element('li', 'empty muted', '直近30日にエラーはありません。'));
    for (const item of data.recentErrors.slice(0, 5)) list.append(errorRow(item));
    recent.append(list); host.append(recent);
    setStatus('運用情報を更新しました。');
  } catch (error) { if (requestId === panelRequests.overview && activePanel === 'overview') errorView(error); }
}
function errorRow(item: AdminError) {
  const row = element<HTMLLIElement>('li', 'admin-list-row');
  const title = element('strong', undefined, item.code);
  row.append(title, element('span', 'muted', `${count(item.requests)}件 · 最終 ${dateLabel(item.lastSeen)}`));
  return row;
}

let selectedMonth = monthNow();
let activePanel = 'overview';
const panelRequests: Record<string, number> = { overview: 0, feedback: 0, ai: 0, errors: 0, users: 0 };
async function loadCosts() {
  const requestId = ++panelRequests.ai;
  const month = app!.querySelector<HTMLElement>('#cost-month')!;
  const host = app!.querySelector<HTMLElement>('#cost-content')!;
  month.textContent = `${selectedMonth.slice(0, 4)}年${Number(selectedMonth.slice(5))}月`;
  host.replaceChildren(element('p', 'muted', '利用状況を読み込んでいます…'));
  try {
    const data = await getJson<Costs>(`/api/admin/ai/costs?month=${encodeURIComponent(selectedMonth)}`);
    if (requestId !== panelRequests.ai || activePanel !== 'ai') return;
    if (data.month !== selectedMonth || data.currency !== 'USD' || !safeCount(data.totalUsdMicros) || !safeCount(data.unknownRequests) || !validProvider(data.providers?.gemini) || !validProvider(data.providers?.jev)) throw new Error('費用データの形式を確認できません。');
    host.replaceChildren();
    host.append(metric('月間合計', usd(data.totalUsdMicros), `料金未確定 ${count(data.unknownRequests)}件`));
    const list = element<HTMLUListElement>('ul', 'admin-list');
    for (const [key, name] of [['gemini', 'Gemini'], ['jev', 'Jev']] as const) {
      const provider = data.providers[key];
      const row = element<HTMLLIElement>('li', 'admin-list-row');
      row.append(element('strong', undefined, name), element('span', 'muted', `${count(provider.requests)}件 · 入力 ${count(provider.inputTokens)} / 出力 ${count(provider.outputTokens)} token · ${usd(provider.costUsdMicros)} · 未確定 ${count(provider.unknownRequests)}件`));
      list.append(row);
    }
    host.append(list);
    setStatus('AI利用状況を更新しました。');
  } catch (error) { if (requestId === panelRequests.ai && activePanel === 'ai') { host.replaceChildren(); errorView(error); } }
}

async function loadErrors() {
  const requestId = ++panelRequests.errors;
  try {
    const data = await getJson<{ errors: AdminError[] }>('/api/admin/errors?limit=100');
    if (requestId !== panelRequests.errors || activePanel !== 'errors') return;
    const list = app!.querySelector<HTMLUListElement>('#errors-list')!; list.replaceChildren();
    if (!data.errors.length) list.append(element('li', 'empty muted', 'エラーはありません。'));
    for (const item of data.errors) list.append(errorRow(item));
    setStatus('エラー情報を更新しました。');
  } catch (error) { if (requestId === panelRequests.errors && activePanel === 'errors') errorView(error); }
}
async function loadUsers() {
  const requestId = ++panelRequests.users;
  try {
    const data = await getJson<{ users: AdminUser[] }>('/api/admin/users?limit=100');
    if (requestId !== panelRequests.users || activePanel !== 'users') return;
    const list = app!.querySelector<HTMLUListElement>('#users-list')!; list.replaceChildren();
    if (!data.users.length) list.append(element('li', 'empty muted', 'アカウントはありません。'));
    for (const user of data.users) {
      const row = element<HTMLLIElement>('li', 'admin-list-row admin-user-row');
      row.append(element('strong', undefined, user.id), element('span', 'muted', `${user.plan} · ${user.kind} · ${user.enabled ? '有効' : '無効'} · AI ${count(user.aiRequests)}回`), element('small', 'muted', `作成 ${dateLabel(user.createdAt)} · 最終AI利用 ${dateLabel(user.lastAiUseAt)}`));
      list.append(row);
    }
    setStatus('アカウント情報を更新しました。');
  } catch (error) { if (requestId === panelRequests.users && activePanel === 'users') errorView(error); }
}

let feedbackRows: Feedback[] = [];
async function loadFeedback() {
  const requestId = ++panelRequests.feedback;
  const list = app!.querySelector<HTMLUListElement>('#feedback-list')!;
  list.replaceChildren(element('li', 'empty muted', '読み込んでいます…'));
  try {
    const selectedStatus = app!.querySelector<HTMLSelectElement>('#feedback-status-filter')!.value;
    const params = new URLSearchParams({ limit: '100' });
    if (selectedStatus) params.set('status', selectedStatus);
    const data = await getJson<{ items: Feedback[] }>(`/api/admin/feedback?${params}`);
    if (requestId !== panelRequests.feedback || activePanel !== 'feedback') return;
    feedbackRows = data.items; list.replaceChildren();
    if (!feedbackRows.length) list.append(element('li', 'empty muted', 'お問い合わせはありません。'));
    for (const item of feedbackRows) {
      const row = element<HTMLLIElement>('li', 'admin-feedback-row');
      const select = button('', () => { void showFeedback(item.id); }, 'admin-feedback-select');
      select.append(element('strong', undefined, item.kind ?? '未分類'), element('span', 'admin-feedback-status', item.status), element('small', 'muted', dateLabel(item.createdAt)), element('span', 'admin-feedback-preview', item.message));
      row.append(select); list.append(row);
    }
    setStatus('お問い合わせ Inbox を更新しました。');
  } catch (error) { if (requestId === panelRequests.feedback && activePanel === 'feedback') { list.replaceChildren(); errorView(error); } }
}
let detailRequestId = 0;
async function showFeedback(id: string) {
  const requestId = ++detailRequestId;
  const host = app!.querySelector<HTMLElement>('#feedback-detail')!;
  host.replaceChildren(element('p', 'muted', '内容を読み込んでいます…'));
  try {
    const data = await getJson<{ item: Feedback }>(`/api/admin/feedback/${encodeURIComponent(id)}`);
    if (requestId !== detailRequestId || activePanel !== 'feedback') return;
    const item = data.item;
    host.replaceChildren();
    host.append(element('p', 'admin-eyebrow', `受付 ${dateLabel(item.createdAt)} · ${item.kind ?? '未分類'} · ${item.status}`));
    host.append(element('h3', undefined, 'お問い合わせ内容'));
    const message = element('p', 'admin-feedback-message', item.message); host.append(message);
    const originalHost = element<HTMLElement>('section', 'admin-original');
    const originalButton = button('原文を表示', async () => {
      originalButton.disabled = true;
      try {
        const original = await postJson<{ message: string }>(`/api/admin/feedback/${encodeURIComponent(id)}/original`);
        originalHost.replaceChildren(element('h3', undefined, '問い合わせ原文'));
        originalHost.append(element('p', 'admin-feedback-message', original.message));
        setStatus('原文を表示しました。');
      } catch (error) { errorView(error); originalButton.disabled = false; }
    });
    originalHost.append(originalButton); host.append(originalHost);
    if (item.aiSummary) { host.append(element('h3', undefined, 'AI要約')); host.append(element('p', 'admin-feedback-message', item.aiSummary)); }
    if (item.diagnostics !== undefined && item.diagnostics !== null) {
      host.append(element('h3', undefined, '診断情報（匿名化済み）'));
      const pre = element('pre', 'admin-diagnostics'); pre.textContent = JSON.stringify(item.diagnostics, null, 2); host.append(pre);
    }
    if (item.githubIssueUrl) {
      try {
        const url = new URL(item.githubIssueUrl);
        if (url.protocol === 'https:' && url.hostname === 'github.com') {
          const link = element<HTMLAnchorElement>('a', 'text-button', `GitHub Issue #${item.githubIssueNumber ?? ''}`); link.href = url.toString(); link.target = '_blank'; link.rel = 'noreferrer'; host.append(link);
        }
      } catch { /* Invalid stored URLs are not exposed as links. */ }
    }
    const actions = element<HTMLDivElement>('div', 'admin-actions');
    const run = async (path: string, body?: unknown, method?: string) => {
      const buttons = Array.from(actions.querySelectorAll('button')); buttons.forEach(node => { node.disabled = true; });
      try {
        await postJson(path, body, method);
        if (activePanel !== 'feedback') return;
        await loadFeedback();
        if (method === 'DELETE') host.replaceChildren(element('p', 'empty muted', 'お問い合わせを削除しました。'));
        else await showFeedback(id);
        setStatus('操作を保存しました。');
      }
      catch (error) {
        errorView(error);
        buttons.forEach(node => { node.disabled = false; });
        if (error instanceof Error && error.message.includes('Issueの作成結果を確認できません')) {
          const submit = host.querySelector<HTMLButtonElement>('.admin-issue-draft button[type="submit"]');
          if (submit) submit.disabled = true;
        }
      }
    };
    if (item.status === 'new') actions.append(button('確認中にする', () => { void run(`/api/admin/feedback/${encodeURIComponent(id)}/status`, { status: 'reviewing' }, 'PATCH'); }));
    if (!item.aiSummary) actions.append(button('AIで分析', () => { if (window.confirm('この問い合わせと匿名化済み診断情報をAIで分析しますか？')) void run(`/api/admin/feedback/${encodeURIComponent(id)}/analyze`); }));
    if (item.status !== 'resolved') actions.append(button('対応済みにする', () => { void run(`/api/admin/feedback/${encodeURIComponent(id)}/status`, { status: 'resolved' }, 'PATCH'); }));
    if (item.status !== 'dismissed') actions.append(button('対応不要にする', () => { void run(`/api/admin/feedback/${encodeURIComponent(id)}/status`, { status: 'dismissed' }, 'PATCH'); }));
    actions.append(button('削除', () => { if (window.confirm('この問い合わせを削除しますか？削除すると元に戻せません。')) void run(`/api/admin/feedback/${encodeURIComponent(id)}`, undefined, 'DELETE'); }, 'destructive'));
    host.append(actions);
    if (!item.githubIssueNumber) {
      const seed = (item.aiSummary ?? item.message).trim();
      const firstSentence = seed.split(/[。\n]/, 1)[0]?.trim() || '問い合わせ内容を確認してください';
      const draft = element<HTMLFormElement>('form', 'admin-issue-draft');
      const draftTitleLabel = element<HTMLLabelElement>('label', undefined, 'Issueのタイトル（公開されます）');
      const draftTitle = element<HTMLInputElement>('input'); draftTitle.maxLength = 120; draftTitle.required = true; draftTitle.value = `${item.kind === 'bug' ? '不具合' : item.kind === 'improvement' ? '改善' : '問い合わせ'}: ${firstSentence}`.slice(0, 120);
      draftTitleLabel.append(draftTitle);
      const draftBodyLabel = element<HTMLLabelElement>('label', undefined, 'Issueの本文（公開されます。必要な情報を確認・編集してください）');
      const draftBody = element<HTMLTextAreaElement>('textarea'); draftBody.maxLength = 8000; draftBody.required = true; draftBody.rows = 14;
      draftBody.value = `## 概要\n${seed}\n\n## ユーザーがやりたかったこと\n（確認できた内容を記入）\n\n## 実際に起きたこと\n（確認できた内容を記入）\n\n## 再現手順\n（分かる範囲で記入）\n\n## 期待する動作\n（確認できた内容を記入）`;
      draftBodyLabel.append(draftBody);
      const draftSubmit = element<HTMLButtonElement>('button', '', '内容を確認してIssueを作成'); draftSubmit.type = 'submit';
      draft.append(draftTitleLabel, draftBodyLabel, draftSubmit);
      draft.addEventListener('submit', event => {
        event.preventDefault();
        if (!draft.reportValidity()) return;
        if (window.confirm(`次の内容でGitHub Issueを作成しますか？\n\n${draftTitle.value}`)) void run(`/api/admin/feedback/${encodeURIComponent(id)}/issue`, { title: draftTitle.value, body: draftBody.value });
      });
      host.append(draft);
    }
    setStatus('お問い合わせを表示しています。');
  } catch (error) { if (requestId === detailRequestId && activePanel === 'feedback') { host.replaceChildren(); errorView(error); } }
}

const panels = Array.from(app.querySelectorAll<HTMLElement>('.admin-panel'));
const tabs = Array.from(app.querySelectorAll<HTMLButtonElement>('[data-panel]'));
const pathForPanel: Record<string, string> = { overview: '/admin', feedback: '/admin/feedback', ai: '/admin/ai', errors: '/admin/errors', users: '/admin/users' };
function activate(name: string, updatePath = true) {
  if (!pathForPanel[name]) name = 'overview';
  activePanel = name;
  tabs.forEach(tab => { const active = tab.dataset.panel === name; tab.setAttribute('aria-selected', String(active)); });
  panels.forEach(panel => { panel.hidden = panel.id !== `admin-panel-${name}`; });
  if (updatePath && location.pathname !== pathForPanel[name]) history.pushState({}, '', pathForPanel[name]);
  if (name === 'overview') void loadOverview();
  if (name === 'feedback') void loadFeedback();
  if (name === 'ai') void loadCosts();
  if (name === 'errors') void loadErrors();
  if (name === 'users') void loadUsers();
}
tabs.forEach(tab => tab.addEventListener('click', () => activate(tab.dataset.panel!)));
window.addEventListener('popstate', () => activate(location.pathname.split('/')[2] === 'feedback' ? 'feedback' : location.pathname.split('/')[2] === 'ai' ? 'ai' : location.pathname.split('/')[2] === 'errors' ? 'errors' : location.pathname.split('/')[2] === 'users' ? 'users' : 'overview', false));
app.querySelector<HTMLButtonElement>('#feedback-refresh')!.addEventListener('click', () => { void loadFeedback(); });
app.querySelector<HTMLSelectElement>('#feedback-status-filter')!.addEventListener('change', () => { void loadFeedback(); });
app.querySelector<HTMLButtonElement>('#errors-refresh')!.addEventListener('click', () => { void loadErrors(); });
app.querySelector<HTMLButtonElement>('#users-refresh')!.addEventListener('click', () => { void loadUsers(); });
app.querySelector<HTMLButtonElement>('#cost-prev')!.addEventListener('click', () => { selectedMonth = monthShift(selectedMonth, -1); void loadCosts(); });
app.querySelector<HTMLButtonElement>('#cost-next')!.addEventListener('click', () => { selectedMonth = monthShift(selectedMonth, 1); void loadCosts(); });
const initialPanel = location.pathname.split('/')[2];
activate(initialPanel === 'feedback' || initialPanel === 'ai' || initialPanel === 'errors' || initialPanel === 'users' ? initialPanel : 'overview', false);
