import { categoryChoices } from './category-picker';
import { createMasterShortcut } from './local-master-ui';
import { entryRow, optionalFields, compactAddButton } from './entry-form';
import { z } from 'zod';
import type { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import { getAiAccessToken } from './ai-auth';
import { financialImage, financialImageBytes, maskFinancialImage } from './financial-image';
import { LocalPayrollService } from './local-payroll';
import { confirmedPayrollSchema, deductionLabels, emptyPayroll, payrollMismatch, payrollSchema, type PayrollExtraction, type PayrollRecord } from '../../../workers/ai-gateway/src/payroll-schema';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, value = '', className = '') => {
  const element = document.createElement(tag); element.textContent = value; element.className = className; return element;
};
function button(label: string, action: () => void | Promise<void>, status: HTMLElement) {
  const element = node('button', label, 'secondary'); element.type = 'button';
  element.addEventListener('click', () => { element.disabled = true; void Promise.resolve().then(action)
    .catch(() => { status.textContent = '処理できませんでした。入力を確認して、もう一度お試しください。'; })
    .finally(() => { element.disabled = false; }); }); return element;
}
type Options = { view: HTMLElement; ledger: ReturnType<typeof createActualBrowserLedger>; service: LocalPayrollService;
  onCancel(): Promise<void>; onSaved(): Promise<void>; onExisting(id: string): Promise<void> };
export async function showPayrollEditor(options: Options, pending?: PayrollRecord, initialPhoto?: File) {
  const { view, ledger, service } = options;
  const title = node('h2', '給与明細から入力');
  const status = node('p', '', 'muted'); status.setAttribute('role', 'status');
  let raster: Awaited<ReturnType<typeof financialImage>> | null = null;
  let controller: AbortController | null = null;
  let active = true;
  let imageRevision = 0;
  const destroyImage = () => { imageRevision++; raster?.destroy(); raster = null; capture.value = ''; library.value = ''; privacy.replaceChildren(); };
  const dispose = () => { active = false; controller?.abort(); controller = null; destroyImage(); };
  const observer = new MutationObserver(() => { if (!title.isConnected || view.hidden) { dispose(); observer.disconnect(); } });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  const cancel = button('キャンセル', async () => { dispose(); observer.disconnect(); await options.onCancel(); }, status);
  cancel.className = 'text-button back-link';
  const privacy = node('div');
  const capture = node('input'); capture.type = 'file'; capture.accept = 'image/jpeg,image/png,image/webp'; capture.setAttribute('capture', 'environment'); capture.hidden = true; capture.id = 'payroll-capture';
  const library = node('input'); library.type = 'file'; library.accept = capture.accept; library.hidden = true; library.id = 'payroll-library';
  const photos = node('div', '', 'actions');
  photos.append(button('給与明細を撮る', () => capture.click(), status), button('写真を選ぶ', () => library.click(), status));
  view.replaceChildren(cancel, title, node('p', '写真は保存しません。氏名・社員番号・マイナンバー・住所・生年月日・口座番号・支店番号・QRコードを隠してから読み取ります。', 'muted'), photos, capture, library, privacy, status);
  let model = pending?.extractionModel ?? 'manual';
  let value: PayrollExtraction = pending?.confirmed ?? emptyPayroll();
  const form = node('form'); form.className = 'entry-rows'; form.id = 'payroll-form';
  const detail = optionalFields('内訳', [], false, '支給・控除'); detail.querySelector('summary')!.setAttribute('aria-label', '支給・控除の内訳');
  const fields = new Map<string, HTMLInputElement>();
  function field(parent: HTMLElement, key: string, label: string, initial: string | number | null, type = 'text', required = false) {
    const name = node('label', label); name.htmlFor = `payroll-${key}`;
    const input = node('input'); input.id = name.htmlFor; input.type = type; input.required = required; input.value = initial === null ? '' : String(initial);
    if (type === 'number') { input.min = '0'; input.step = '1'; input.inputMode = 'numeric'; } else input.maxLength = 120;
    fields.set(key, input); parent.append(entryRow(name, input)); return input;
  }
  field(form, 'employerName', '勤務先', value.employerName, 'text', true);
  field(form, 'paymentDate', '支給日', value.paymentDate, 'date', true);
  field(form, 'netPayYen', '手取り（円）', value.netPayYen, 'number', true).min = '1';
  const categoryLabel = node('label', 'カテゴリ'); categoryLabel.htmlFor = 'payroll-category';
  const category = node('select'); category.id = categoryLabel.htmlFor; category.required = true;
  const accountLabel = node('label', '入金先'); accountLabel.htmlFor = 'payroll-account';
  const account = node('select'); account.id = accountLabel.htmlFor; account.required = true;
  const categoryRow = entryRow(categoryLabel, category); const accountRow = entryRow(accountLabel, account); form.append(categoryRow, accountRow);
  const typeLabel = node('label', '種類'); typeLabel.htmlFor = 'payroll-payType';
  const payType = node('select'); payType.id = typeLabel.htmlFor; payType.append(new Option('給与', 'salary'), new Option('賞与', 'bonus'), new Option('その他', 'other')); payType.value = value.payType;
  detail.append(entryRow(typeLabel, payType));
  field(detail, 'payPeriod', '対象期間', value.payPeriod);
  field(detail, 'grossPayYen', '総支給（円）', value.grossPayYen, 'number');
  for (const [key, label] of Object.entries(deductionLabels)) field(detail, key, `${label}（円）`, value.deductions[key as keyof typeof deductionLabels], 'number');
  const allowances = node('div'); detail.append(allowances);
  const renderAllowances = () => {
    allowances.replaceChildren();
    value.allowances.forEach((row, index) => {
      field(allowances, `allowance-name-${index}`, '支給項目', row.name);
      field(allowances, `allowance-amount-${index}`, '金額（円）', row.amountYen, 'number');
    });
  };
  renderAllowances();
  form.append(detail, node('p', '手取りだけを収入に登録します。控除から支出は作りません。写真と照らし合わせて、違うところを直してください。', 'muted'));
  const checked = node('input'); checked.type = 'checkbox'; checked.required = true; checked.id = 'payroll-reviewed';
  const checkLabel = node('label', '勤務先・支給日・手取りと内訳を確認しました'); checkLabel.htmlFor = checked.id;
  const review = node('div', '', 'payroll-consent'); review.append(checked, checkLabel); form.append(review);
  const duplicates = node('div'); duplicates.className = 'payroll-duplicates'; form.append(duplicates);
  const submit = node('button', pending ? '登録結果を確認する' : '登録する', 'primary'); submit.type = 'submit';
  const footer = node('div', '', 'form-actions'); footer.append(submit); form.append(footer); view.append(form);
  const id = pending?.id ?? crypto.randomUUID();
  let retryPending = Boolean(pending);
  let allowDuplicate = false;
  let fingerprint = '';
  const readValue = () => {
    const amount = (key: string) => { const input = fields.get(key)!; return input.value.trim() === '' ? null : Number(input.value); };
    return confirmedPayrollSchema.parse({ ...value, documentKind: 'pay_slip', employerName: fields.get('employerName')!.value,
      paymentDate: fields.get('paymentDate')!.value, netPayYen: amount('netPayYen'), grossPayYen: amount('grossPayYen'),
      payPeriod: fields.get('payPeriod')!.value || null, payType: payType.value,
      deductions: Object.fromEntries(Object.keys(deductionLabels).map(key => [key, amount(key)])),
      allowances: value.allowances.map((_, index) => ({ name: fields.get(`allowance-name-${index}`)!.value, amountYen: amount(`allowance-amount-${index}`) })), warnings: [] });
  };
  form.addEventListener('input', event => { if (event.target === checked) return; allowDuplicate = false; duplicates.replaceChildren(); checked.checked = false; });
  form.addEventListener('submit', event => {
    event.preventDefault(); if (submit.disabled) return;
    submit.disabled = true;
    void (async () => {
      let confirmed;
      try { confirmed = readValue(); } catch { status.textContent = '勤務先・支給日・整数の手取り額を確認してください。個人識別情報は入力できません。'; return; }
      const currentFingerprint = JSON.stringify(confirmed);
      if (!retryPending) {
        const found = await service.duplicates(confirmed, id);
        if ((found.transactions.length || found.scheduled || found.pending) && (!allowDuplicate || fingerprint !== currentFingerprint)) {
          duplicates.replaceChildren(node('p', '△ この給与はすでに登録されている可能性があります。同じ月の給与・定期給与を確認してください。'));
          for (const row of found.transactions) duplicates.append(button(`既存の記録を見る（${row.date}）`, () => options.onExisting(row.id), status));
          duplicates.append(button('それでも登録', () => { allowDuplicate = true; fingerprint = currentFingerprint; form.requestSubmit(); }, status));
          return;
        }
      }
      // Persist only after explicit review; freeze on ambiguous writes and retry the stable ID.
      retryPending = true;
      for (const input of Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select'))) input.disabled = true;
      photos.hidden = true; destroyImage();
      await service.register(id, confirmed, category.value, account.value, model, allowDuplicate);
      if (active) { dispose(); observer.disconnect(); await options.onSaved(); }
    })().catch(async () => {
      try { retryPending = (await service.list()).some(row => row.id === id); }
      catch { status.textContent = '登録状態を確認できません。内容を保持しています。再試行してください。'; return; }
      if (!active) return;
      if (!retryPending) {
        for (const input of Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select'))) input.disabled = false;
        photos.hidden = false;
        status.textContent = '登録できませんでした。銀行口座・収入カテゴリと重複の確認を見直してください。';
      } else {
        status.textContent = '登録を完了できませんでした。内容を保持しています。「登録結果を確認する」で再試行してください。'; submit.textContent = '登録結果を確認する';
      }
    })
      .finally(() => { submit.disabled = false; });
  });
  capture.addEventListener('change', () => { void selectPhoto(capture.files?.[0] ?? null); }); library.addEventListener('change', () => { void selectPhoto(library.files?.[0] ?? null); });
  const [categories, accounts] = await Promise.all([categoryChoices(ledger, ledger.listIncomeCategories()), ledger.listOpenAccounts()]);
  if (!active) return;
  category.append(new Option('選択してください', ''), ...categories.map(row => new Option(row.name, row.id)));
  category.value = pending?.categoryId ?? categories.find(row => row.name === '給与')?.id ?? '';
  account.append(new Option('銀行口座を選んでください', ''), ...accounts.filter(row => row.accountType === 'bank').map(row => new Option(row.name, row.id)));
  account.value = pending?.accountId ?? '';
  if (!pending) {
    const categoryAdd = createMasterShortcut({ ledger, request: { kind: 'category', isIncome: true },
      origin: { field: category, beforeOpen: async () => {}, onCreated: async id => {
        category.replaceChildren(new Option('選択してください', ''), ...(await categoryChoices(ledger, ledger.listIncomeCategories())).map(row => new Option(row.name, row.id))); category.value = id;
      } } });
    const accountAdd = createMasterShortcut({ ledger, request: { kind: 'account' },
      origin: { field: account, beforeOpen: async () => {}, onCreated: async id => {
        account.replaceChildren(new Option('銀行口座を選んでください', ''), ...(await ledger.listOpenAccounts()).filter(row => row.accountType === 'bank').map(row => new Option(row.name, row.id))); account.value = id;
      } } });
    const categorySide = node('div', '', 'entry-row-side'); categorySide.append(compactAddButton(categoryAdd)); categoryRow.append(categorySide);
    const accountSide = node('div', '', 'entry-row-side'); accountSide.append(compactAddButton(accountAdd)); accountRow.append(accountSide);
  }
  if (pending) { photos.hidden = true; checked.checked = true; for (const input of Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select'))) input.disabled = true; }
  if (initialPhoto && !pending) await selectPhoto(initialPhoto);
  initialPhoto = undefined;
  async function selectPhoto(file: File | null) {
    if (!file) return;
    destroyImage();
    const selectedRevision = imageRevision;
    try {
      const prepared = await financialImage(file); file = null;
      if (!active || selectedRevision !== imageRevision) { prepared.destroy(); return; }
      raster = prepared;
      form.hidden = true;
      const canvas = prepared.canvas; canvas.className = 'payroll-mask'; canvas.setAttribute('aria-label', '給与明細の写真。隠す範囲の左上と右下を順にタップ');
      let first: [number, number] | null = null;
      canvas.addEventListener('click', event => {
        const rect = canvas.getBoundingClientRect(); const point: [number, number] = [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
        if (!first) { first = point; status.textContent = '隠す範囲の右下をタップしてください。'; }
        else { maskFinancialImage(canvas, ...first, ...point); first = null; status.textContent = '範囲を隠しました。ほかにも隠す場合は左上をタップしてください。'; }
      });
      const consent = node('input'); consent.type = 'checkbox'; consent.id = 'payroll-masking-confirmed';
      const consentLabel = node('label', '不要な個人情報を隠しました。必要な部分をAIへ送信します'); consentLabel.htmlFor = consent.id;
      const read = button('AIで読み取る', async () => {
        if (!consent.checked || first) { status.textContent = '隠す範囲を確定し、個人情報を隠したことを確認してください。'; return; }
        controller = new AbortController(); const signal = controller.signal;
        let bytes: Uint8Array | null = null;
        photos.hidden = true;
        try {
          bytes = await financialImageBytes(canvas); destroyImage(); status.textContent = '読み取り中です。';
          const token = await getAiAccessToken(); if (!active || signal.aborted) return;
          let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
          const body = JSON.stringify({ flowId: crypto.randomUUID(), contentType: 'image/jpeg', imageBase64: btoa(binary), maskingConfirmed: true });
          binary = ''; bytes.fill(0); bytes = null;
          const response = await fetch('/api/ai/payroll', { method: 'POST', credentials: 'same-origin', signal,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
          if (!response.ok) throw new Error('payroll_read_failed');
          const parsed = z.object({ extraction: payrollSchema, model: z.string().min(1).max(100), promptVersion: z.literal('payroll-v1') }).strict().parse(await response.json());
          if (!active) return;
          if (parsed.extraction.documentKind !== 'pay_slip') throw new Error('not_pay_slip');
          value = parsed.extraction; model = parsed.model;
          for (const key of ['employerName', 'paymentDate', 'netPayYen', 'grossPayYen', 'payPeriod'] as const) fields.get(key)!.value = value[key] === null ? '' : String(value[key]);
          for (const key of Object.keys(deductionLabels) as Array<keyof typeof deductionLabels>) fields.get(key)!.value = value.deductions[key] === null ? '' : String(value.deductions[key]);
          payType.value = value.payType; renderAllowances(); checked.checked = false;
          status.textContent = payrollMismatch(value) ? '△ 総支給額・控除合計・手取りが一致しません。印字された値を確認してください。' : value.warnings.length ? '△ 読み取りに不確かな項目があります。各項目を確認してください。' : '写真から読み取りました。内容を確認してください。';
        } catch {
          if (active) status.textContent = '給与明細を読み取れませんでした。写真は破棄しました。写真を選び直すか、手で入力してください。';
        } finally { bytes?.fill(0); destroyImage(); controller = null; if (active) { photos.hidden = false; form.hidden = false; } }
      }, status);
      const consentRow = node('div', '', 'payroll-consent'); consentRow.append(consent, consentLabel);
      privacy.append(node('p', '隠す範囲の左上と右下を順にタップしてください。複数箇所を隠せます。', 'muted'), canvas, consentRow, read);
    } catch { file = null; destroyImage(); status.textContent = '写真を開けませんでした。JPEG・PNG・WebPを選んでください。'; form.hidden = false; }
  }

}

export function payrollDetails(record: PayrollRecord): HTMLElement {
  const details = optionalFields('給与明細', [], false, '内訳（登録時）'); details.querySelector('summary')!.setAttribute('aria-label', '給与明細の内訳（登録時）');
  const value = record.confirmed;
  details.append(node('p', '登録時に確認した内訳です。取引の編集後も元の内訳を保持し、削除の取り消しに備えて残します。', 'muted'));
  for (const [label, amount] of [['総支給額', value.grossPayYen], ...Object.entries(deductionLabels).map(([key, label]) => [label, value.deductions[key as keyof typeof deductionLabels]])] as Array<[string, number | null]>) details.append(node('p', `${label}：${amount === null ? '未記載' : `¥${amount.toLocaleString('ja-JP')}`}`));
  details.append(node('p', `対象期間：${value.payPeriod ?? '未記載'} / ${value.payType === 'bonus' ? '賞与' : value.payType === 'salary' ? '給与' : 'その他'}`));
  for (const row of value.allowances) details.append(node('p', `${row.name}：${row.amountYen === null ? '未記載' : `¥${row.amountYen.toLocaleString('ja-JP')}`}`));
  return details;
}
