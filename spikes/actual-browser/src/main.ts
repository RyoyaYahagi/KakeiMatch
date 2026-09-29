import * as api from '@actual-app/api';
import {
  checkOffline, formatReport, readReport, resumeAfterReload, runDiagnostics,
  saveReport, setManualResult, summarize, type DiagnosticItem, type DiagnosticReport, type Progress,
} from './diagnostic';
import './style.css';

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const runButton = get<HTMLButtonElement>('run');
const copyButton = get<HTMLButtonElement>('copy');
const message = get<HTMLElement>('message');
let report = readReport();
let busy = false;

function renderItem(item: DiagnosticItem): HTMLLIElement {
  const li = document.createElement('li');
  li.className = item.status;
  const head = document.createElement('div');
  head.className = 'result-head';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = item.status.toUpperCase();
  const title = document.createElement('strong');
  title.textContent = item.label;
  head.append(badge, title);
  const detail = document.createElement('span');
  detail.className = 'detail';
  detail.textContent = `${item.detail || '未実行'}${item.source === 'reported' ? '［利用者報告］' : ''}`;
  li.append(head, detail);
  return li;
}

function render(progress?: Progress) {
  runButton.disabled = busy;
  copyButton.disabled = !report;
  const results = get<HTMLElement>('results');
  results.replaceChildren();
  if (!report) return;
  const summary = summarize(report);
  get<HTMLElement>('overall').textContent = summary.overall;
  get<HTMLElement>('last-run').textContent = `最終診断: ${new Date(report.finishedAt ?? report.startedAt).toLocaleString('ja-JP')}`;
  get<HTMLElement>('counts').textContent = `PASS ${summary.pass} / WARN ${summary.warn} / FAIL ${summary.fail} / PENDING ${summary.pending}`;
  get<HTMLElement>('progress-label').textContent = progress ? `${progress.current} / ${progress.total} ${progress.label}` : (report.phase === 'complete' ? '診断が完了しました。' : '前回の診断を再開しています…');
  const bar = get<HTMLProgressElement>('progress');
  bar.max = progress?.total ?? 1;
  bar.value = progress?.current ?? (report.phase === 'complete' ? bar.max : 0);
  let section = '';
  let list: HTMLUListElement | undefined;
  for (const item of report.items) {
    if (item.section !== section) {
      section = item.section;
      const group = document.createElement('section');
      group.className = 'result-group';
      const heading = document.createElement('h3');
      heading.textContent = section;
      list = document.createElement('ul');
      list.className = 'result-list';
      group.append(heading, list);
      results.append(group);
    }
    list!.append(renderItem(item));
  }
}

function update(next: DiagnosticReport, progress: Progress) {
  report = next;
  if (!saveReport(next)) message.textContent = '結果を端末に保存できません。保存容量を確認し、結果をコピーしてください。';
  render(progress);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

runButton.addEventListener('click', () => {
  if (busy) return;
  busy = true;
  message.textContent = '';
  render();
  void runDiagnostics(update).then(next => {
    report = next;
    if (next.phase === 'reload') {
      if (saveReport(next)) {
        message.textContent = '保存できました。再読込後の保持を確認します。';
        location.reload();
        return;
      }
      message.textContent = '診断結果を保存できず、自動再読込を中止しました。保存容量を確認してください。';
    }
    busy = false;
    render();
  }).catch(error => {
    busy = false;
    message.textContent = `診断を完了できませんでした: ${errorText(error)}`;
    render();
  });
});

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch { /* Try the selection fallback. */ }
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.readOnly = true;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('ブラウザがコピーを許可しませんでした');
}

copyButton.addEventListener('click', () => {
  if (!report) return;
  void copyText(formatReport(report)).then(() => {
    message.textContent = '診断結果をコピーしました。';
  }).catch(error => {
    message.textContent = `コピーできませんでした: ${errorText(error)}`;
  });
});

get<HTMLButtonElement>('offline').addEventListener('click', () => {
  if (!report || busy) { message.textContent = '先に一括診断を完了してください。'; return; }
  busy = true;
  render();
  void checkOffline(report).then(outcome => {
    setManualResult(report!, 'offline', outcome);
    if (!saveReport(report!)) message.textContent = 'オフライン結果を保存できませんでした。結果をコピーしてください。';
    else message.textContent = outcome.detail;
    busy = false;
    render();
  }).catch(error => {
    busy = false;
    message.textContent = `オフライン確認でエラー: ${errorText(error)}`;
    render();
  });
});

get<HTMLButtonElement>('export').addEventListener('click', () => {
  if (!report?.budgetId) { message.textContent = '先に一括診断を完了してください。'; return; }
  void (async () => {
    await api.init({});
    await api.loadBudget(report!.budgetId!);
    const zip = await api.exportBudget();
    const url = URL.createObjectURL(new Blob([new Uint8Array(zip)], { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'kakeimatch-actual-diagnostic.zip';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    message.textContent = `ZIP を保存しました（${zip.byteLength} byte）。`;
  })().catch(error => { message.textContent = `ZIP を保存できませんでした: ${errorText(error)}`; });
});

get<HTMLInputElement>('import').addEventListener('change', event => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  void (async () => {
    await api.init({});
    const imported = await api.importBudget(await file.arrayBuffer(), { filename: file.name });
    await api.loadBudget(imported.id);
    message.textContent = `ZIP を読み込みました。Budget ID: ${imported.id}`;
  })().catch(error => { message.textContent = `ZIP を読み込めませんでした: ${errorText(error)}`; });
});

render();
if (report?.phase === 'reload') {
  busy = true;
  render();
  void resumeAfterReload(report, update).then(() => { busy = false; render(); }).catch(error => {
    busy = false;
    message.textContent = `再読込後の確認でエラー: ${errorText(error)}`;
    render();
  });
}
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(error => { message.textContent = `オフライン用ファイルの準備に失敗: ${errorText(error)}`; });
}
