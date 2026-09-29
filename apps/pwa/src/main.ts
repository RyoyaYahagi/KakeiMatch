import * as actual from '@actual-app/api';
import './style.css';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('App root is missing');
root.innerHTML = `
  <main>
    <header><h1>KakeiMatch</h1><span class="status" id="network"></span></header>
    <p class="muted">この端末の家計簿を表示します。</p>
    <p class="status" id="message" role="status"></p>
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
      <h2>最近の取引</h2>
      <ul id="transactions"></ul>
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
