import { initializeMasterUi } from './local-master-ui';
import { initializeBackupUi } from './local-backup-ui';
import { restoreStandaloneBudget, type LocalBudgetSettings } from './local-backup';
import { ActualBudgetSelectionRequiredError, createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { LocalDataRepository } from '../../../src/lib/local-data';
import { LocalReceiptService, type LocalReceipt } from './local-receipts';
import { LocalStatementService } from './local-statements';
import { LocalReconciliationService } from './local-reconciliation';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const yen = (n: number) => `¥${Math.abs(n).toLocaleString('ja-JP')}`;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function text(tag: string, value: string, className = '') { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; }
function button(label: string, action: () => Promise<unknown> | void, secondary = true) {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.className = secondary ? 'secondary' : '';
  node.addEventListener('click', () => { void busy(node, action); }); return node;
}
async function busy(node: HTMLButtonElement, action: () => Promise<unknown> | void) {
  node.disabled = true;
  try { await action(); } catch (error) { report(error); } finally { node.disabled = false; }
}
function report(error: unknown) {
  const message = error instanceof Error && /[ぁ-んァ-ヶ一-龠]/.test(error.message) ? error.message : '操作を完了できませんでした。保存済みのデータを確認して再試行してください。';
  el('message').textContent = message;
}

export async function initializeLocalUi(options: { openAccount: () => void }) {
  const repository = await LocalDataRepository.open();
  const saved = await repository.get<LocalBudgetSettings>('settings:budget');
  let budgetId = saved?.value.budgetId ?? null;
  const dataDir = saved?.value.dataDir ?? '/documents';
  const ledger = createActualBrowserLedger({ getBudgetId: () => budgetId, getDataDir: () => dataDir, saveBudgetId: async id => {
    budgetId = id; await repository.put({ id: 'settings:budget', kind: 'app-settings', value: { budgetId: id, dataDir }, updatedAt: new Date().toISOString() });
  } });
  const receipts = new LocalReceiptService(repository, ledger);
  const statements = new LocalStatementService(repository);
  const reconciliation = new LocalReconciliationService(repository, ledger);
  const view = el('local-view');
  let imageUrl: string | null = null;
  let resetMasterUi = () => {};
  function open(tab: 'home' | 'receipt' | 'statement' | 'reconciliation') { resetMasterUi(); if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
    el('household-view').hidden = tab !== 'home'; el('settings-view').hidden = true; view.hidden = tab === 'home';
    for (const id of ['home', 'receipt', 'statement', 'reconciliation', 'settings']) {
      const item = el(`${id}-tab`); const active = id === tab; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active));
    }
    el('message').textContent = ''; view.replaceChildren();
  }
  async function home() {
    open('home');
    const rows = (await ledger.getRecentTransactions({ limit: 50 })).filter(row => row.kind === 'expense');
    const list = el('transactions'); list.replaceChildren();
    for (const row of rows) {
      const item = document.createElement('li'); item.className = 'row'; item.append(text('span', `${row.date} · ${row.payeeName || '支出'}`), text('strong', yen(row.amountYen))); list.append(item);
    }
    if (!rows.length) list.append(text('li', 'まだ支出の記録がありません。'));
    const monthly = await ledger.getMonthlySpending({ yearMonth: today().slice(0, 7) });
    el('home-summary').textContent = `今月の支出 ${yen(monthly)}`;
    const resolutions = await reconciliation.resolutions();
    const latest = await reconciliation.latest();
    const attention = resolutions.filter(r => r.status !== 'applied').length + (latest?.statementResults.filter(r => r.status !== 'matched' && !resolutions.some(d => d.statementId === r.statementTransactionId)).length ?? 0);
    el('home-summary').append(button(latest ? `確認が必要な明細 ${attention}件` : '明細を取り込んで照合してください', reviewPage));
  }
  async function receiptPage() {
    open('receipt'); view.append(text('h2', 'レシートを記録する'), text('p', '画像と入力内容はこの端末に保存します。AIを選んだときだけ画像を送信します。', 'muted'));
    const capture = document.createElement('input'); capture.type = 'file'; capture.accept = 'image/jpeg,image/png,image/webp'; capture.setAttribute('capture', 'environment'); capture.hidden = true;
    const library = document.createElement('input'); library.type = 'file'; library.accept = capture.accept; library.hidden = true;
    const saveFile = (input: HTMLInputElement) => { input.addEventListener('change', () => { const file = input.files?.[0]; if (file) void receipts.saveImage(file).then(receiptEditor).catch(report); }); };
    saveFile(capture); saveFile(library);
    view.append(button('撮影する', () => capture.click(), false), button('写真・ファイルを選ぶ', () => library.click()), button('手入力する', async () => receiptEditor(await receipts.createManual())), capture, library);
    const list = document.createElement('ul');
    for (const receipt of await receipts.list()) {
      const row = document.createElement('li'); const value = receipt.confirmedValue ?? receipt.extraction;
      row.append(button(`${value?.merchant || '未入力のレシート'} · ${receipt.registration.status === 'applied' ? '登録済み' : '確認する'}`, () => receiptEditor(receipt))); list.append(row);
    }
    view.append(list);
  }
  async function receiptEditor(receipt: LocalReceipt) {
    open('receipt'); view.append(text('h2', '内容を確認する'));
    const blob = await repository.getBlob(receipt.image?.blobId ?? "missing");
    if (!blob && receipt.image) view.append(text('p', 'レシート画像の原本はありません。原本の確認・再解析はできません。確認値と家計簿の記録は利用できます。'));
    if (blob) { imageUrl = URL.createObjectURL(blob.blob); const img = document.createElement('img'); img.src = imageUrl; img.alt = '保存したレシート'; img.className = 'receipt-preview'; view.append(img); }
    const aiArea = document.createElement('div');
    aiArea.append(text('p', 'AIで読み取るにはアカウントとインターネット接続が必要です。手入力でも登録できます。', 'muted'));
    const form = document.createElement('form'); form.innerHTML = `
      <label for="receipt-merchant">店名</label><input id="receipt-merchant" required maxlength="200">
      <label for="receipt-date">購入日</label><input id="receipt-date" type="date" required>
      <label for="receipt-time">時刻（任意）</label><input id="receipt-time" type="time">
      <label for="receipt-amount">金額（円）</label><input id="receipt-amount" type="number" inputmode="numeric" min="1" step="1" required>
      <label for="receipt-category">カテゴリ</label><select id="receipt-category" required></select>
      <label for="receipt-account">支払元</label><select id="receipt-account" required></select>
      <p id="receipt-save-state" role="status"></p>`;
    const [accounts, categories] = await Promise.all([ledger.listOpenAccounts(), ledger.listExpenseCategories()]);
    const account = form.querySelector<HTMLSelectElement>('#receipt-account')!, category = form.querySelector<HTMLSelectElement>('#receipt-category')!;
    account.replaceChildren(new Option('選択してください', ''), ...accounts.map(a => new Option(a.name, a.id)));
    category.replaceChildren(new Option('選択してください', ''), ...categories.map(c => new Option(c.name, c.id)));
    const draftId = `receipt-draft:${receipt.id}`;
    const draft = await repository.get<{ merchant: string; purchasedDate: string; purchasedTime: string | null; totalAmountYen: number; categoryId: string; accountId: string }>(draftId);
    view.append(aiArea, form);
    // Saving before an AI request also persists untouched fields (including amount 0).
    // Such a draft must not hide a successful extraction, even after reopening it.
    const hasDraftContent = draft && (draft.value.merchant.trim() !== '' || draft.value.totalAmountYen > 0 || draft.value.purchasedTime !== null);
    const value = (hasDraftContent ? draft.value : null) ?? receipt.confirmedValue ?? (receipt.extraction?.documentKind === 'receipt' ? receipt.extraction : null) ?? draft?.value;
    if (receipt.extraction?.warnings.length) view.append(text('p', '読み取り結果に不明な項目があります。画像と照らし合わせて確認してください。'));
    el<HTMLInputElement>('receipt-merchant').value = value?.merchant ?? '';
    el<HTMLInputElement>('receipt-date').value = value?.purchasedDate ?? today();
    el<HTMLInputElement>('receipt-time').value = value?.purchasedTime ?? '';
    el<HTMLInputElement>('receipt-amount').value = value?.totalAmountYen?.toString() ?? '';
    account.value = draft?.value.accountId ?? receipt.confirmedValue?.accountId ?? (accounts.length === 1 ? accounts[0].id : '');
    category.value = draft?.value.categoryId ?? receipt.confirmedValue?.categoryId ?? '';
    if ((draft?.value.accountId || receipt.confirmedValue?.accountId) && !account.value) view.append(text('p', '以前の支払元は利用できません。支払元を選び直してください。'));
    if ((draft?.value.categoryId || receipt.confirmedValue?.categoryId) && !category.value) view.append(text('p', '以前のカテゴリは利用できません。カテゴリを選び直してください。'));
    const read = () => ({ merchant: el<HTMLInputElement>('receipt-merchant').value, purchasedDate: el<HTMLInputElement>('receipt-date').value, purchasedTime: el<HTMLInputElement>('receipt-time').value || null, totalAmountYen: Number(el<HTMLInputElement>('receipt-amount').value), categoryId: category.value, accountId: account.value });
    let saveTail: Promise<unknown> = Promise.resolve();
    const save = () => { const value = read(); saveTail = saveTail.catch(() => undefined).then(async () => { await receipts.confirm(receipt.id, value); el('receipt-save-state').textContent = '確認内容を保存しました。'; }); return saveTail; };
    const saveDraft = async () => { if (receipt.registration.status === 'applied') return; await repository.put({ id: draftId, kind: 'category-state', value: read(), updatedAt: new Date().toISOString() }); el('receipt-save-state').textContent = '入力内容を端末に保存しました。'; };
    form.addEventListener('change', () => { void saveDraft().catch(report); });
    const ai = button('AIで読み取る', async () => {
      await saveDraft();
      try { await receipts.analyze(receipt.id);
        await receiptEditor((await receipts.get(receipt.id))!); }
      catch (error) { report(error); if (error instanceof Error && /アカウント|ログイン|認証/.test(error.message)) aiArea.append(button('アカウントを確認する', options.openAccount)); }
    });
    if (blob) aiArea.append(ai);
    aiArea.append(button('カテゴリを提案する', async () => { const id = await receipts.suggestCategory(receipt.id); if (id) { const { CATEGORY_LABELS, isCategoryId } = await import("../../../src/lib/category"); category.value = isCategoryId(id) ? categories.find(c => c.name === CATEGORY_LABELS[id])?.id ?? "" : id; } else el('message').textContent = 'カテゴリを選択してください。'; await saveDraft(); }));
    if (receipt.registration.status === 'applied') { form.querySelectorAll('input,select').forEach(node => { (node as HTMLInputElement).disabled = true; }); aiArea.hidden = true; view.append(text('p', '家計簿へ登録済みです。')); }
    else {
      if (receipt.registration.status !== 'pending') { form.querySelectorAll('input,select').forEach(node => { (node as HTMLInputElement).disabled = true; }); aiArea.hidden = true; view.append(text('p', '判断内容は保存されています。同じ内容で登録を再試行してください。')); }
      const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = receipt.registration.status === 'failed' ? '家計簿への登録を再試行する' : '確認して家計簿へ登録する';
      form.append(submit); form.addEventListener('submit', event => { event.preventDefault(); void busy(submit, async () => { if (receipt.registration.status === 'pending') await save(); await receipts.register(receipt.id); await repository.delete(draftId); await receiptEditor((await receipts.get(receipt.id))!); }); });
      view.append(button('確認内容を保存する', async () => { await saveDraft(); }));
    }
    view.append(button('レシート一覧へ戻る', receiptPage));
    if (!accounts.length || !categories.length) view.append(text('p', '設定から支払元とカテゴリを用意してください。'), button('家計簿の設定へ', options.openAccount));
  }
  async function statementPage() {
    open('statement'); view.append(text('h2', '明細を取り込む'), text('p', 'PayPayのCSVに対応しています。ファイルは端末内で処理し、送信しません。'));
    const label = text('label', 'PayPayのCSVファイル'); label.setAttribute('for', 'statement-file');
    const input = document.createElement('input'); input.id = 'statement-file'; input.type = 'file'; input.accept = '.csv,text/csv';
    const submit = button('明細を取り込む', async () => { const file = input.files?.[0]; if (!file) { el('message').textContent = 'CSVファイルを選択してください。'; return; } const result = await statements.importFile(file, 'paypay'); await statementPage(); el('message').textContent = `${result.added}件を取り込みました。重複 ${result.duplicates}件。`; }, false);
    view.append(label, input, submit, button('照合する', reviewPage));
    const rows = await statements.list(); view.append(text('p', `取り込み済み ${rows.length}件`));
    for (const record of await repository.list('statement-import')) if (!await repository.getBlob(`statement-source:${record.id}`)) view.append(text('p', '取込元CSVの原本はありません。原本の確認はできませんが、明細行と照合結果は利用できます。'));
  }
  async function reviewPage() {
    open('reconciliation'); view.append(text('h2', '明細の確認'));
    view.append(button('照合を更新する', async () => { await reconciliation.run(); await reviewPage(); }, false));
    const run = await reconciliation.latest(); const decisions = await reconciliation.resolutions();
    for (const decision of decisions.filter(d => d.status !== 'applied')) view.append(text('p', '家計簿への反映が完了していません。判断内容は保存されています。'), button('反映を再試行する', async () => { await reconciliation.retry(decision.id); await reviewPage(); }));
    if (!run) { view.append(text('p', '明細を取り込んでから照合してください。')); return; }
    const pending = run.statementResults.filter(row => !decisions.some(d => d.statementId === row.statementTransactionId));
    const automatic = decisions.filter(d => d.source === 'automatic' && d.status === 'applied');
    const auto = automatic.length;
    view.append(text('p', `自動確認済み ${auto}件 · 要確認 ${pending.filter(r => r.status === 'needs_review').length}件 · 記録なし ${pending.filter(r => r.status === 'unmatched_statement').length}件 · 明細待ち ${run.receiptResults.filter(r => r.status === 'unmatched_receipt').length}件`));
    const allStatements = await statements.list(), allReceipts = await receipts.list();
    const list = document.createElement('ul');
    for (const row of pending.filter(r => r.status !== 'matched')) {
      const statement = allStatements.find(s => s.id === row.statementTransactionId); if (!statement) continue;
      const item = document.createElement('li'); const detail = document.createElement('details'); detail.append(text('summary', `${statement.usedDate} · ${statement.merchant} · ${yen(statement.amountYen)}`));
      if (statement.kind === 'refund') detail.append(text('p', '返金の記録です。現在は自動処理できません。'));
      else {
        const candidates = run.candidates.filter(c => c.statementTransactionId === statement.id);
        for (const candidate of candidates) {
          const receipt = allReceipts.find(r => r.id === candidate.receiptId); const value = receipt?.confirmedValue; if (!value) continue;
          detail.append(text('p', `似た支出：${value.purchasedDate} · ${value.merchant} · ${yen(value.totalAmountYen)}${candidate.amountDeltaYen ? `（金額差 ${yen(candidate.amountDeltaYen)}）` : ''}`));
          detail.append(button('同じ支出', async () => { await reconciliation.sameExpense(run.runId, statement.id, candidate.receiptId); await reviewPage(); }, false), button('別の支出', async () => { await reconciliation.rejectPair(run.runId, statement.id, candidate.receiptId); await reconciliation.run(); await reviewPage(); }));
        }
        if (!candidates.length) {
          const accountLabel = text('label', '支払元'), categoryLabel = text('label', 'カテゴリ');
          const account = document.createElement('select'), category = document.createElement('select');
          account.id = `account-${statement.id}`; category.id = `category-${statement.id}`; accountLabel.setAttribute('for', account.id); categoryLabel.setAttribute('for', category.id);
          account.append(new Option('選択してください', ''), ...(await ledger.listOpenAccounts()).map(a => new Option(a.name, a.id)));
          category.append(new Option('選択してください', ''), ...(await ledger.listExpenseCategories()).map(c => new Option(c.name, c.id)));
          detail.append(text('p', '記録が見つかりません。ご自身の利用であれば登録できます。'), accountLabel, account, categoryLabel, category, button('自分の利用・レシートなし', async () => { await reconciliation.noReceipt(run.runId, statement.id, { accountId: account.value, categoryId: category.value }); await reviewPage(); }, false));
        }
      }
      item.append(detail); list.append(item);
    }
    view.append(list);
    if (automatic.length) {
      const history = document.createElement('details');
      history.append(text('summary', `自動確認済みの内容を見る（${auto}件）`));
      const matchedList = document.createElement('ul');
      const statementById = new Map(allStatements.map(statement => [statement.id, statement]));
      const receiptById = new Map(allReceipts.map(receipt => [receipt.id, receipt]));
      automatic.sort((a, b) => (statementById.get(b.statementId)?.usedDate ?? b.createdAt).localeCompare(statementById.get(a.statementId)?.usedDate ?? a.createdAt));
      for (const decision of automatic) {
        const statement = statementById.get(decision.statementId), receipt = receiptById.get(decision.receiptId ?? '');
        const item = document.createElement('li'), detail = document.createElement('details');
        detail.append(text('summary', statement ? `${statement.usedDate} · ${statement.merchant} · ${yen(statement.amountYen)}` : `保存済みの照合 · ${yen(decision.statementAmountYen)}`));
        detail.append(text('p', '同じ支出として自動確認済みです。'));
        detail.append(text('p', statement ? `明細：${statement.usedDate}${statement.usedTime ? ` ${statement.usedTime.slice(0, 5)}` : ''} · ${statement.merchant} · ${yen(statement.amountYen)}${statement.paymentMethod ? ` · ${statement.paymentMethod}` : ''}` : '対応する明細を端末で見つけられませんでした。'));
        const value = receipt?.confirmedValue;
        detail.append(text('p', value ? `レシート：${value.purchasedDate}${value.purchasedTime ? ` ${value.purchasedTime}` : ''} · ${value.merchant} · ${yen(value.totalAmountYen)}` : '対応するレシートを端末で見つけられませんでした。'));
        if (receipt) detail.append(button('レシートを確認する', () => receiptEditor(receipt)));
        item.append(detail); matchedList.append(item);
      }
      history.append(matchedList); view.append(history);
    }
  }
  for (const [tab, render] of [['home', home], ['receipt', receiptPage], ['statement', statementPage], ['reconciliation', reviewPage]] as const) el(`${tab}-tab`).addEventListener('click', () => { void render().catch(report); });
  el('home-capture').addEventListener('click', () => { void receiptPage().catch(report); });
  // A user chooses a budget explicitly when multiple local budgets are available.
  const setup = el('local-settings');
  await initializeBackupUi(repository, ledger);
  setup.append(text('h2', 'この端末の家計簿'), el('import-section'), el('budget-section'));
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') { el('message').textContent = '家計簿を開くためにページを再読込してください。'; return; }
  try { await ledger.listOpenAccounts(); } catch (error) { if (!(error instanceof ActualBudgetSelectionRequiredError)) throw error; }
  const actual = await import('@actual-app/api');
  const budgets = await actual.getBudgets(); const selector = el<HTMLSelectElement>('budget'); selector.replaceChildren(...budgets.map(b => new Option(b.name, b.id))); if (!budgetId) selector.prepend(new Option('家計簿を選択してください', '')); selector.value = budgetId ?? ''; el('budget-section').hidden = false;
  selector.addEventListener('change', () => { void (async () => { if ((await receipts.list()).length || (await statements.list()).length) { selector.value = budgetId ?? ''; throw new Error('記録のある家計簿は切り替えられません。'); } budgetId = selector.value; await repository.put({ id: 'settings:budget', kind: 'app-settings', value: { budgetId, dataDir }, updatedAt: new Date().toISOString() }); location.reload(); })().catch(report); });
  const zip = el<HTMLInputElement>('import-file'); el('import-section').hidden = false;
  el('import-button').addEventListener('click', () => zip.click());
  zip.addEventListener('change', () => { const file = zip.files?.[0]; if (file) void (async () => { if ((await receipts.list()).length || (await statements.list()).length) throw new Error('記録済みの端末では別の家計簿を読み込めません。'); await restoreStandaloneBudget(file, ledger); location.reload(); })().catch(report); });
  resetMasterUi = initializeMasterUi(setup, ledger, { onBack: () => { el('message').textContent = ''; } });
  el('settings-tab').addEventListener('click', resetMasterUi);
  if (budgetId) { if (!el('household-view').hidden) await home(); else el('message').textContent = ''; } else el('message').textContent = '使う家計簿を選択してください。';
}
