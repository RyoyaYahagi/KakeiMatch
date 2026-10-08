import type { LocalDataRepository } from '../../../src/lib/local-data';
import type { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { backLink, pageTitle, groupTitle, detailList, pageActions } from './settings-ui';
import { parseMoneyForwardBlob, moneyForwardDescription, categoryKey, resolveMoneyForwardCategory, type MoneyForwardParseResult } from './moneyforward-parser';
import { MoneyForwardImportService, type CategoryChoice, type AccountChoice, type ImportPlan, type RecordChoice } from './moneyforward-import';
import { icon } from './ui-icons';
import { suggestMoneyForwardCategory } from './moneyforward-category-suggestion';

type Ledger = ReturnType<typeof createActualBrowserLedger>;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className = '') {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text; el.className = className; return el;
}
const yen = (value: number) => `¥${value.toLocaleString('ja-JP')}`;

export function initializeMoneyForwardUi(repository: LocalDataRepository, ledger: Ledger, getBudgetId: () => string | null) {
  const settings = document.getElementById('settings-content')!;
  const page = node('section', undefined, 'master-settings moneyforward-page'); page.hidden = true; settings.after(page);
  const service = new MoneyForwardImportService(repository, ledger, { getBudgetId });
  const entry = node('button', 'マネーフォワードから移行', 'master-entry'); entry.type = 'button'; entry.setAttribute('aria-label', 'マネーフォワードから移行');
  document.getElementById('data-settings')!.append(entry);
  const status = node('p', '', 'master-status'); status.setAttribute('role', 'status');
  const body = node('div');
  const title = pageTitle('マネーフォワードから移行'); title.tabIndex = -1;
  let parsed: MoneyForwardParseResult | null = null;
  let categories: Awaited<ReturnType<Ledger['listCategories']>> = [];
  let accounts: Awaited<ReturnType<Ledger['listAccounts']>> = [];
  let mappings: { categories: Record<string, CategoryChoice>; accounts: Record<string, AccountChoice> } = { categories: {}, accounts: {} };
  let recordChoices: Record<string, RecordChoice> = {};
  let pending = false;
  let revision = 0;
  const close = () => { page.hidden = true; settings.hidden = false; revision++; };
  page.append(backLink('戻る', 'バックアップと復元へ戻る', close), title,
    node('p', 'CSVはこの端末だけで読み込みます。将来日付・振替・計算対象外は除外します。登録前にカテゴリと支払元を確認してください。', 'muted'), body, status);
  async function run(action: () => Promise<void>) {
    if (pending) return;
    pending = true; page.setAttribute('aria-busy', 'true');
    page.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(el => el.disabled = true);
    try { await action(); } catch (error) { status.textContent = error instanceof Error ? error.message : '移行できませんでした。もう一度お試しください。'; }
    finally { pending = false; page.removeAttribute('aria-busy'); page.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(el => el.disabled = false); }
  }
  function action(label: string, handler: () => Promise<void>, primary = false) {
    const button = node('button', label, primary ? 'primary' : 'secondary'); button.type = 'button';
    if (!primary) button.prepend(icon(label.includes('取り消す') || label.includes('再試行') ? 'repeat' : label.includes('AI') ? 'bulb' : label.includes('CSV') ? 'upload' : 'pencil'));
    button.addEventListener('click', () => { void run(handler); }); return button;
  }
  async function history() {
    const section = node('details', undefined, 'settings-inner-disclosure'); section.append(node('summary', '移行履歴・取り消し'));
    for (const batch of (await service.getHistory()).filter(batch => batch.status !== 'planned')) {
      const row = node('div', undefined, 'moneyforward-history-row');
      row.append(node('p', `${batch.createdAt.slice(0, 10)} · 登録 ${batch.rows.filter(row => row.status === 'created').length}件${batch.status === 'undone' ? ' · 取り消し済み' : ''}`));
      if (batch.status === 'undone') { section.append(row); continue; }
      if (['partial', 'processing'].includes(batch.status)) row.append(action('残りの登録を再試行する', async () => { const result = await service.confirm(batch.id); status.textContent = `登録 ${result.rows.filter(row => row.status === 'created').length}件 · エラー ${result.rows.filter(row => row.error).length}件`; await selectFile(); }));
      row.append(action('この移行を取り消す', async () => {
        if (!window.confirm('この移行で登録した取引を削除します。移行後の編集も削除されます。追加したカテゴリと支払元は残ります。続けますか？')) return;
        const result = await service.undo(batch.id); status.textContent = result.status === 'undone' ? '移行した取引を取り消しました。カテゴリと支払元は残っています。' : '一部の取引を取り消せませんでした。履歴からもう一度お試しください。'; await selectFile();
      }));
      section.append(row);
    }
    return section;
  }
  async function selectFile() {
    parsed = null; recordChoices = {}; body.replaceChildren();
    const input = node('input'); input.type = 'file'; input.accept = '.csv,text/csv'; input.id = 'moneyforward-file';
    const label = node('label', 'MoneyForward CSVを選択'); label.htmlFor = input.id;
    body.append(label, input, node('p', 'UTF-8・Shift_JIS形式に対応。ファイルは5MB、取引は20,000行までです。', 'muted'), await history());
    input.addEventListener('change', () => { const file = input.files?.[0]; if (!file) return; void run(async () => {
      const current = ++revision; status.textContent = 'CSVを読み込んでいます…';
      const result = await parseMoneyForwardBlob(file); input.value = '';
      if (revision !== current || page.hidden) return;
      parsed = result;
      if (result.fatalErrors.length) {
        const diagnostic = result as MoneyForwardParseResult & { foundHeaders?: string[]; missingHeaders?: string[]; unknownHeaders?: string[] };
        status.textContent = '現在のMoneyForward CSV形式に対応していない可能性があります。列を確認してください。';
        const reasons = { invalid_file: 'ファイルを読み取れません', empty_file: 'ファイルが空です', header_only: '取引行がありません', header_mismatch: '必須の列が不足または重複しています', malformed_csv: 'CSVの区切りや引用符を確認できません', limit_exceeded: 'ファイルサイズ・行数・項目の長さが上限を超えています' };
        body.append(node('p', result.fatalErrors.map(error => reasons[error.code]).join('、')));
        body.append(node('p', `見つかった列: ${diagnostic.foundHeaders?.join('、') || result.headerSignature || 'なし'}`));
        body.append(node('p', `不足している必須列: ${diagnostic.missingHeaders?.join('、') || '日付・内容・金額（円）・大項目を確認してください'}`));
        if (result.duplicateHeaders?.length) body.append(node('p', `重複している列: ${result.duplicateHeaders.join('、')}`));
        if (diagnostic.unknownHeaders?.length) body.append(node('p', `認識できない列: ${diagnostic.unknownHeaders.join('、')}`));
        return;
      }
      [categories, accounts] = await Promise.all([ledger.listCategories(), ledger.listAccounts()]);
      const rules = await service.getRules(); mappings = { categories: Object.create(null), accounts: Object.create(null) };
      for (const row of result.transactions) {
        const key = categoryKey(row);
        if (!mappings.categories[key]) {
          const resolved = resolveMoneyForwardCategory(row, categories);
          const savedChoice = rules.categories[key];
          mappings.categories[key] = savedChoice && (savedChoice.kind !== 'existing' || categories.some(c => c.id === savedChoice.categoryId && !c.hidden && c.isIncome === (row.kind === 'income'))) ? savedChoice : row.majorCategory === '未分類' ? { kind: 'unclassified' } : resolved.categoryId ? { kind: 'existing', categoryId: resolved.categoryId }
            : resolved.suggestedName && !resolved.reason && !row.categoryNeedsReviewReason ? { kind: 'new', name: resolved.suggestedName } : { kind: 'unresolved' };
        }
        const source = row.accountName ?? '';
        if (!Object.hasOwn(mappings.accounts, source)) {
          const match = accounts.find(account => !account.closed && account.name === source);
          mappings.accounts[source] = match ? { kind: 'existing', accountId: match.id } : (Object.hasOwn(rules.accounts, source) ? rules.accounts[source] : undefined) ?? (source ? { kind: 'new', name: source } : { kind: 'unset' });
        }
      }
      status.textContent = ''; renderMappings();
    }); });
  }
  function renderMappings() {
    if (!parsed) return;
    body.replaceChildren(groupTitle('カテゴリをまとめて変換'));
    const grouped = new Map<string, { row: typeof parsed.transactions[number]; count: number }>();
    for (const row of parsed.transactions) { const key = categoryKey(row); const group = grouped.get(key); if (group) group.count++; else grouped.set(key, { row, count: 1 }); }
    for (const [key, { row, count }] of grouped) {
      const labelText = `${row.majorCategory || 'カテゴリなし'}${row.minorCategory ? ` / ${row.minorCategory}` : ''}（${row.kind === 'income' ? '収入' : '支出'}） ${count}件`;
      const container = node('div', undefined, 'moneyforward-mapping-row'); const label = node('label', labelText);
      const select = node('select'); select.setAttribute('aria-label', `${labelText}の変換先`);
      select.append(new Option('選択してください', 'unresolved'));
      for (const category of categories.filter(c => !c.hidden && c.isIncome === (row.kind === 'income'))) select.append(new Option(category.name, category.id));
      select.append(new Option('新規カテゴリとして作成', 'new'), new Option('未分類で取り込む', 'unclassified'), new Option('取り込まない', 'exclude'));
      const name = node('input'); name.type = 'text'; name.maxLength = 100; name.setAttribute('aria-label', `${labelText}の新規カテゴリ名`);
      const choice = mappings.categories[key]; select.value = choice.kind === 'existing' ? choice.categoryId : choice.kind; name.value = choice.kind === 'new' ? choice.name : row.minorCategory || row.majorCategory; name.hidden = choice.kind !== 'new';
      const apply = () => { name.hidden = select.value !== 'new'; mappings.categories[key] = select.value === 'new' ? { kind: 'new', name: name.value.trim() } : ['unresolved', 'unclassified', 'exclude'].includes(select.value) ? { kind: select.value as 'unresolved' | 'unclassified' | 'exclude' } : { kind: 'existing', categoryId: select.value }; };
      select.addEventListener('change', apply); name.addEventListener('input', apply); label.append(select); container.append(label, name);
      if (row.categoryNeedsReviewReason) container.append(node('p', row.categoryNeedsReviewReason, 'muted'));
      if (choice.kind === 'unresolved') container.append(action('AIで候補を確認', async () => {
        if (mappings.categories[key].kind !== 'unresolved') { status.textContent = '未対応のカテゴリだけ候補を確認できます。'; return; }
        const available = categories.filter(c => !c.hidden && c.isIncome === (row.kind === 'income'));
        status.textContent = 'カテゴリ名と選択肢だけを送って候補を確認します…';
        const suggestion = await suggestMoneyForwardCategory(`${row.majorCategory} / ${row.minorCategory}`, available);
        const proposed = available.find(c => c.id === suggestion.categoryId);
        if (!proposed) { status.textContent = '候補を決められませんでした。手で選んでください。'; return; }
        status.textContent = `候補: ${proposed.name}。確認して変換先を選んでください。`;
      }));
      body.append(container);
    }
    body.append(groupTitle('支払元・口座の対応'));
    for (const source of Object.keys(mappings.accounts)) {
      const container = node('div', undefined, 'moneyforward-mapping-row'); const label = node('label', source || '移行元に口座名なし');
      const select = node('select'); select.setAttribute('aria-label', `${source || '口座名なし'}の移行先`);
      for (const account of accounts.filter(a => !a.closed)) select.append(new Option(account.name, account.id));
      select.append(new Option('新しい支払元として作成', 'new'), new Option('未設定で取り込む', 'unset'));
      const name = node('input'); name.type = 'text'; name.maxLength = 100; name.setAttribute('aria-label', `${source || '口座名なし'}の新しい支払元名`);
      const choice = mappings.accounts[source]; select.value = choice.kind === 'existing' ? choice.accountId : choice.kind; name.value = choice.kind === 'new' ? choice.name : source; name.hidden = choice.kind !== 'new';
      const apply = () => { name.hidden = select.value !== 'new'; mappings.accounts[source] = select.value === 'new' ? { kind: 'new', name: name.value.trim() } : select.value === 'unset' ? { kind: 'unset' } : { kind: 'existing', accountId: select.value }; };
      select.addEventListener('change', apply); name.addEventListener('input', apply); label.append(select); container.append(label, name); body.append(container);
    }
    body.append(node('p', '未設定の支払元は「移行元未設定」へまとめます。CSVにない品目は作成しません。', 'muted'));
    body.append(pageActions(action('取り込み内容を確認する', preview, true), action('別のCSVを選ぶ', selectFile)));
  }
  async function preview() {
    if (!parsed) return;
    const plan = await service.plan(parsed.transactions, mappings, recordChoices);
    renderPreview(plan);
  }
  function renderPreview(plan: ImportPlan) {
    if (!parsed) return;
    const ready = plan.previewRows.filter(item => item.status === 'ready');
    const dates = ready.map(item => item.row.date).sort();
    const incomes = ready.filter(item => item.row.kind === 'income'), expenses = ready.filter(item => item.row.kind === 'expense');
    const unique = (values: string[]) => new Set(values).size;
    body.replaceChildren(groupTitle('取り込み前の確認'), detailList([
      ['対象期間', dates.length ? `${dates[0]} 〜 ${dates.at(-1)}` : '対象なし'],
      ['取引件数', `${ready.length}件`], ['収入', `${incomes.length}件 / ${yen(incomes.reduce((sum, item) => sum + item.row.amountYen, 0))}`],
      ['支出', `${expenses.length}件 / ${yen(expenses.reduce((sum, item) => sum - item.row.amountYen, 0))}`],
      ['将来日付（除外）', `${parsed.excludedRows.filter(row => row.reason === 'future_date').length}件`],
      ['似ている記録（要確認）', `${plan.summary.review}件`],
      ['振替（除外）', `${parsed.excludedRows.filter(row => row.reason === 'transfer').length}件`],
      ['除外予定', `${parsed.excludedRows.length + plan.summary.excluded}件`], ['重複（スキップ）', `${plan.summary.duplicates}件`],
      ['エラー', `${parsed.rowErrors.length}件`], ['未解決カテゴリ', `${unique(plan.previewRows.filter(item => item.status === 'unresolved').map(item => categoryKey(item.row)))}件`],
      ['新規カテゴリ', `${unique(ready.flatMap(item => { const choice = mappings.categories[categoryKey(item.row)]; return choice.kind === 'new' && !categories.some(c => c.name === choice.name && c.isIncome === (item.row.kind === 'income')) ? [`${item.row.kind}:${choice.name}`] : []; }))}件`],
      ['新規支払元', `${unique(ready.flatMap(item => { const choice = mappings.accounts[item.row.accountName ?? '']; const name = choice.kind === 'new' ? choice.name : choice.kind === 'unset' ? '移行元未設定' : null; return name && !accounts.some(a => !a.closed && a.name === name) ? [name] : []; }))}件`],
    ]));
    const similar = plan.previewRows.filter(item => item.candidates.length);
    if (similar.length) {
      body.append(groupTitle('似ている既存記録を確認'), node('p', '金額・カテゴリが同じで日付が3日以内の記録です。同じ取引なら既存記録に統一し、CSVの行を取り込みません。既存の品目や画像は保持します。別の取引なら両方を残します。', 'muted'));
      for (const item of similar) {
        const container = node('div', undefined, 'moneyforward-mapping-row');
        container.append(node('p', `CSV ${item.row.rowNumber}行: ${item.row.date} · ${moneyForwardDescription(item.row)} · ${yen(item.row.amountYen)} · ${item.categoryName} · ${item.accountName}`, 'moneyforward-preview-row'));
        const select = node('select'); select.setAttribute('aria-label', `CSV ${item.row.rowNumber}行の既存記録との扱い`);
        select.append(new Option('統一するか選んでください', ''), new Option('別の記録として取り込む（両方残す）', 'separate'));
        for (const candidate of item.candidates) {
          const account = accounts.find(account => account.id === candidate.accountId)?.name ?? '支払元未設定';
          container.append(node('p', `既存: ${candidate.date} · ${candidate.payeeName ?? '内容なし'} · ${yen(candidate.amountYen)} · ${candidate.categoryName ?? '未分類'} · ${account}`, 'moneyforward-preview-row'));
          select.append(new Option(`既存記録に統一: ${candidate.date} · ${candidate.payeeName ?? '内容なし'} · ${yen(candidate.amountYen)} · ${candidate.categoryName ?? '未分類'} · ${account}`, candidate.id));
        }
        select.value = item.recordChoice?.kind === 'keep' ? item.recordChoice.transactionId : item.recordChoice?.kind === 'separate' ? 'separate' : '';
        select.addEventListener('change', () => { void run(async () => {
          if (!select.value) delete recordChoices[item.importedId];
          else recordChoices[item.importedId] = select.value === 'separate' ? { kind: 'separate' } : { kind: 'keep', transactionId: select.value };
          await preview();
        }); });
        const label = node('label', 'この行の取り込み方法'); label.append(select); container.append(label); body.append(container);
      }
    }
    for (const item of ready.slice(0, 5)) body.append(node('p', `${item.row.date} · ${moneyForwardDescription(item.row)} · ${item.row.amountYen < 0 ? '−' : '+'}${yen(Math.abs(item.row.amountYen))} · ${item.categoryName} · ${item.accountName}`, 'moneyforward-preview-row'));
    const issues = node('details', undefined, 'settings-inner-disclosure'); issues.append(node('summary', '除外・エラー行の理由'));
    for (const row of parsed.excludedRows) issues.append(node('p', `${row.rowNumber}行: ${row.reason === 'future_date' ? '将来日付のため除外' : row.reason === 'transfer' ? '振替のため除外' : '計算対象外のため除外'}`));
    for (const row of parsed.rowErrors) issues.append(node('p', `${row.rowNumber}行: ${row.reason}`));
    body.append(issues);
    const rememberLabel = node('label', undefined, 'category-rule-toggle'); const remember = node('input'); remember.type = 'checkbox'; rememberLabel.append(remember, node('span', 'この対応を今後も使用する')); body.append(rememberLabel);
    if (plan.summary.unresolved) body.append(node('p', '未解決のカテゴリがあります。変換先を選ぶか、未分類・除外を選んでください。'));
    else if (plan.summary.review) body.append(node('p', '似ている記録について、統一するか別の記録として取り込むかを選んでください。'));
    else if (ready.length || similar.length) body.append(pageActions(action(ready.length ? `${ready.length}件を取り込む` : '既存記録への統一を確定する', async () => {
      status.textContent = '取引をこの端末に登録しています…';
      const result = await service.confirm(plan.batchId);
      body.replaceChildren(groupTitle('取り込み結果'));
      // The result journal remains available in history, including partial failures.
      status.textContent = '取り込み処理が終わりました。結果と履歴を確認してください。';
      const count = (state: string) => result.rows.filter(row => row.status === state).length;
      body.append(detailList([['成功', `${count('created')}件`], ['重複', `${count('duplicate')}件`], ['スキップ', `${count('excluded') + (parsed?.excludedRows.length ?? 0)}件`], ['エラー', `${count('failed') + count('importing') + (parsed?.rowErrors.length ?? 0)}件`]]));
      for (const row of result.rows.filter(row => row.error)) body.append(node('p', `${row.row.rowNumber}行: ${row.error}`));
      if (remember.checked) await service.saveRules(result.mappings);
      parsed = null; body.append(await history(), action('別のCSVを選ぶ', selectFile));
    }, true)));
    body.append(action('対応を変更する', async () => { recordChoices = {}; renderMappings(); }));
  }
  entry.addEventListener('click', () => { settings.hidden = true; page.hidden = false; title.focus(); status.textContent = ''; void run(selectFile); });
  document.getElementById('settings-tab')!.addEventListener('click', close);
  return close;
}
