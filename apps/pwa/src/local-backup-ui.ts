import type { LocalDataRepository } from '../../../src/lib/local-data';
import { recordLocalDiagnostic, type DiagnosticFeature } from './local-diagnostics';
import { cleanupReceiptImages, cleanupStatementCsv, getCleanupSummary, getStorageStatus, shouldRemindLocalExport } from './local-data-lifecycle';
import { exportLocalBackup, INCOMPLETE_RESTORE_KEY, PREVIOUS_PROFILE_KEY, restoreLocalBackup, returnToPreviousProfile, wipeLocalHousehold, type BackupLedger } from './local-backup';

const text = (tag: string, value: string) => { const element = document.createElement(tag); element.textContent = value; return element; };
const bytes = (size: number) => `${(size / 1024 / 1024).toFixed(1)} MiB`;

export async function initializeBackupUi(repository: LocalDataRepository, ledger: BackupLedger): Promise<void> {
  // Backup actions and recovery help share a page; the settings overview shows reminders.
  const section = document.createElement('section'); section.id = 'backup-settings';
  const ledgerPanel = document.createElement('section'); ledgerPanel.id = 'backup-restore'; ledgerPanel.className = 'surface-section settings-panel';
  const cleanupPanel = document.createElement('section'); cleanupPanel.id = 'backup-cleanup-tools'; cleanupPanel.className = 'surface-section settings-panel';
  const statusLine = () => { const line = text('p', ''); line.setAttribute('role', 'status'); return line; };
  const statuses = new Map<Element, HTMLElement>([[section, statusLine()], [ledgerPanel, statusLine()], [cleanupPanel, statusLine()]]);
  // Messages appear in the part of the screen where the action was started.
  let status = statuses.get(section)!;
  const exportDate = text('p', ''); exportDate.id = 'last-export';
  const reminder = text('p', ''); reminder.id = 'backup-reminder';
  const capacity = text('p', '');
  const incompleteWarning = text('p', '');
  const input = document.createElement('input'); input.type = 'file'; input.id = 'backup-file'; input.accept = '.kmb,application/octet-stream'; input.hidden = true;
  let running = false;
  let persistenceRequested = false;
  const run = async (action: () => Promise<void>, feature: DiagnosticFeature = 'save') => {
    if (running) return;
    running = true;
    // Household controls stay inert during the snapshot/switch; account operations are independent.
    const targets = [document.querySelector('nav'), document.getElementById('household-view'), document.getElementById('local-view'), document.getElementById('local-settings'), section, ledgerPanel, cleanupPanel];
    for (const target of targets) target?.setAttribute('inert', '');
    status.textContent = '処理しています。この画面を閉じずにお待ちください。';
    try { await action(); } catch (error) { recordLocalDiagnostic(feature, error); status.textContent = error instanceof Error && /[ぁ-んァ-ヶ一-龠]/.test(error.message) ? error.message : '処理に失敗しました。元のデータを確認してください。'; }
    finally { running = false; for (const target of targets) target?.removeAttribute('inert'); }
  };
  const button = (id: string, label: string, action: () => Promise<void>, primary = false) => {
    const element = document.createElement('button'); element.type = 'button'; element.id = id; element.textContent = label; element.className = primary ? '' : 'secondary';
    element.addEventListener('click', () => { status = statuses.get([...statuses.keys()].find(area => area.contains(element)) ?? section)!; void run(action, id === 'backup-export' ? 'backup' : id === 'restore-previous' ? 'restore' : 'save'); }); return element;
  };
  const cleanupInfo = text('p', '');
  async function refresh() {
    const incomplete = localStorage.getItem(INCOMPLETE_RESTORE_KEY) !== null;
    incompleteWarning.textContent = incomplete ? '復元途中のデータが残っている可能性があります。新しい復元とアプリからの全削除は停止しています。元の家計データのバックアップを保存し、ブラウザーのサイトデータ削除を利用してください。' : '';
    (document.getElementById('backup-import') as HTMLButtonElement).disabled = incomplete;
    (document.getElementById('restore-previous') as HTMLButtonElement).hidden = !localStorage.getItem(PREVIOUS_PROFILE_KEY);
    const saved = await repository.get<{ lastExportAt: string }>('settings:backup');
    const at = saved?.value.lastExportAt ?? null;
    exportDate.textContent = at ? `最終書き出し生成日時：${new Date(at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}（日本時間）` : 'まだバックアップを書き出していません。';
    reminder.textContent = shouldRemindLocalExport(at) ? '復旧に備えてバックアップを書き出してください。目安は最終書き出しから30日です。' : '';
    const summary = await getCleanupSummary(repository);
    cleanupInfo.textContent = `削除できる原本：登録済みレシート画像 ${summary.receipts.count}件（約${bytes(summary.receipts.bytes)}）、取込元CSV ${summary.statements.count}件（約${bytes(summary.statements.bytes)}）`;
    (document.getElementById('receipt-image-cleanup') as HTMLButtonElement).disabled = summary.receipts.count === 0;
    (document.getElementById('statement-csv-cleanup') as HTMLButtonElement).disabled = summary.statements.count === 0;
    const storage = await getStorageStatus({ requestPersistence: !persistenceRequested });
    persistenceRequested = true;
    capacity.textContent = `${storage.persisted === true ? 'ブラウザーから保存維持の許可を取得しています。それでもブラウザーデータの削除には備えてください。' : 'ブラウザーによる保存維持は保証されません。バックアップを別の場所に保管してください。'}${storage.usage !== null && storage.quota !== null ? ` 使用量の目安 ${bytes(storage.usage)} / ${bytes(storage.quota)}。${storage.usage / storage.quota >= 0.9 ? '空き容量が少なくなっています。' : ''}` : ''}`;
  }
  section.append(text('h2', 'バックアップと端末データ'), text('p', 'この端末のデータはブラウザ設定や容量不足で消える可能性があります。端末の紛失やSafariの保存領域の消去後は、バックアップがなければ復旧できない可能性があります。'),
    text('p', '書き出す内容：家計簿の取引・支払元・カテゴリ、レシートの確認値と解析情報、明細の取込情報と取引行、照合結果と判断・再試行状態、店舗の対応・端末設定、残っている画像とCSV原本。削除済みの原本は含まれません。アカウント・ログイン情報・AI利用量・支払情報は含みません。'),
    text('p', 'バックアップは暗号化されていない .kmb ファイルです。Filesなどへ保存し、他人に渡さないでください。生成日時は保存完了を保証しません。'), exportDate, reminder, capacity, incompleteWarning,
    button('backup-export', 'バックアップを書き出す', async () => {
      const blob = await exportLocalBackup(repository, ledger);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `KakeiMatch-${new Date().toISOString().replace(/[:.]/g, '-')}.kmb`; section.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      await refresh(); recordLocalDiagnostic('backup'); status.textContent = 'バックアップを生成しました。Filesなどへの保存を確認してください。';
    }, true),
    text('p', '読み込みは新しい家計データとして復元します。現在のデータと合併しません。復元に成功した後に切り替え、元のデータも端末に残します。ほかのタブでの家計操作を終えてから実行してください。'),
    button('backup-import', 'バックアップを読み込む', async () => { input.value = ''; input.click(); status.textContent = 'バックアップファイルを選択してください。'; }), input,
    button('restore-previous', '変更前のデータに戻す', async () => { if (!window.confirm('変更前のデータに戻しますか？現在のデータも端末に残ります。')) return; await returnToPreviousProfile(); location.reload(); }),
    text('h3', '原本の整理'), cleanupInfo,
    text('p', '原本を削除すると後から原本を確認・再解析できなくなります。家計簿の取引、確認値、明細行、照合結果、判断と履歴は残します。未確認・登録待ち・再試行待ちのレシート画像は対象にしません。原本の自動削除は行いません。'),
    button('receipt-image-cleanup', 'レシート画像を削除', async () => { await refresh(); if (!window.confirm(`${cleanupInfo.textContent}\n登録済みのレシート画像を削除しますか？後から原本を確認できなくなります。`)) return; const result = await cleanupReceiptImages(repository); await refresh(); status.textContent = `${result.deletedCount}件のレシート画像を削除しました。確認値と照合結果は残っています。`; }),
    button('statement-csv-cleanup', '取込元CSVを削除', async () => { await refresh(); if (!window.confirm(`${cleanupInfo.textContent}\n取り込み済みのCSV原本を削除しますか？後から原本を確認できなくなります。`)) return; const result = await cleanupStatementCsv(repository); await refresh(); status.textContent = `${result.deletedCount}件のCSV原本を削除しました。明細行と照合結果は残っています。`; }),
    text('h3', 'この端末の家計データをすべて削除'), text('p', '切り替え前のデータと復元途中のデータを含め、このサイトの端末内家計簿・レシート・画像・明細・照合・設定を削除します。バックアップがなければ復旧できません。アカウント・Passkey・契約・AI利用権限には影響しません。'),
    button('local-wipe', 'この端末の家計データをすべて削除', async () => { if (!window.confirm('この端末の家計データをすべて削除します。バックアップがなければ復旧できません。続けますか？')) return; if (window.prompt('削除を確定するには「すべて削除」と入力してください。') !== 'すべて削除') { status.textContent = '削除を取り消しました。'; return; } await wipeLocalHousehold(repository, ledger); location.reload(); }), status);
  section.className = 'backup-quick-actions';
  const children = Array.from(section.children);
  const at = (node: Element) => children.indexOf(node);
  const exportButton = section.querySelector('#backup-export')!;
  const importButton = section.querySelector('#backup-import')!;
  importButton.textContent = '復元する'; importButton.setAttribute('aria-label', 'バックアップを復元する');
  const restoreButton = section.querySelector('#restore-previous')!;
  const cleanupHeading = children.find(child => child.tagName === 'H3')!;
  const actions = document.createElement('div'); actions.className = 'backup-quick-buttons'; actions.append(exportButton, importButton);
  const explanations = children.slice(1, at(cleanupHeading)).filter(child => child.tagName === 'P' && ![exportDate, reminder, capacity, incompleteWarning, status].includes(child as HTMLElement));
  const about = document.createElement('details'); about.className = 'settings-inner-disclosure';
  about.append(text('summary', 'バックアップについて'), capacity, ...explanations);
  ledgerPanel.append(restoreButton, statuses.get(ledgerPanel)!, about);
  cleanupPanel.append(...children.slice(at(cleanupHeading)).filter(child => child !== status), statuses.get(cleanupPanel)!);
  section.replaceChildren(exportDate, incompleteWarning, actions, input, statuses.get(section)!);
  document.getElementById('backup-quick')!.append(reminder);
  document.getElementById('data-settings')!.prepend(section, ledgerPanel);
  document.getElementById('cleanup-host')!.append(cleanupPanel);
  input.addEventListener('change', () => { const file = input.files?.[0]; if (!file) return; status = statuses.get(section)!; void run(async () => { if (!window.confirm('バックアップを新しい保存先へ復元し、成功後に切り替えますか？元の家計データは端末に残ります。')) return; await restoreLocalBackup(file, ledger); recordLocalDiagnostic('restore'); location.reload(); }, 'restore'); });
  document.getElementById('settings-tab')!.addEventListener('click', () => { void refresh().catch(error => { status = statuses.get(section)!; status.textContent = error instanceof Error ? error.message : '保存状況を確認できません。'; }); });
  await refresh();
}
