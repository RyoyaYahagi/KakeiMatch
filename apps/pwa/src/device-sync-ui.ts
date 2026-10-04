import { hasUnsentChanges, readSyncState } from './household-sync-state';
import type { HouseholdWriteGuard } from './household-write-guard';
import type { DeviceSyncEngine, SyncOutcome } from './device-sync-engine';
import { SyncApiError } from './device-sync-api';

// Settings > データ > 端末間の同期 (docs/UX.md 端末間同期, Issue #143 §7).
// Sync is off by default. While it is on, it runs at startup, when the app returns to the
// foreground or goes online, and shortly after saves. It never reloads a screen being edited.

const LAST_SYNC_KEY = 'kakeimatch.sync-last.v1';
const AFTER_SAVE_DELAY_MS = 3000;

type Options = {
  engine: DeviceSyncEngine;
  guard: HouseholdWriteGuard;
  /** Asks for a fresh Passkey sign-in. Resolves false when the user cancels. */
  reauthenticate: () => Promise<boolean>;
  /** True while a work screen (entry, edit, import) is open. Imports wait until it closes. */
  isEditing: () => boolean;
};

type Status = { symbol: string; label: string; tone: 'ok' | 'pending' | 'warning' | 'error' };
const statuses: Record<string, Status> = {
  synced: { symbol: '✓', label: '同期済み', tone: 'ok' },
  unsent: { symbol: '●', label: '未送信の変更があります', tone: 'pending' },
  offline: { symbol: '○', label: 'オフライン', tone: 'pending' },
  sign_in: { symbol: '!', label: 'ログインが必要です', tone: 'warning' },
  remote: { symbol: '!', label: '別の端末の変更があります', tone: 'warning' },
  failed: { symbol: '×', label: '同期できませんでした', tone: 'error' },
  removed: { symbol: '×', label: 'この端末は同期から外れました', tone: 'error' },
};

const text = (tag: string, value = '', className = '') => {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
};
function button(label: string, kind: 'primary' | 'secondary' | 'text' | 'danger', action: () => Promise<void> | void, id?: string) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.className = { primary: '', secondary: 'secondary', text: 'text-button', danger: 'text-button destructive-text' }[kind];
  if (id) node.id = id;
  node.addEventListener('click', () => { void action(); });
  return node;
}

function tokyoTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function readLastSync(): string | null {
  try { return localStorage.getItem(LAST_SYNC_KEY); } catch { return null; }
}

export function initializeDeviceSyncUi(container: HTMLElement, options: Options) {
  const { engine, guard } = options;
  const section = document.createElement('section');
  section.id = 'device-sync-settings';
  section.className = 'surface-section settings-panel device-sync';
  section.setAttribute('aria-labelledby', 'device-sync-title');
  const title = text('h2', '端末間の同期'); title.id = 'device-sync-title';
  const statusLine = text('p', '', 'sync-status'); statusLine.setAttribute('role', 'status'); statusLine.id = 'sync-status';
  const lastSync = text('p', '', 'muted');
  const body = document.createElement('div');
  const message = text('p', '', 'status'); message.setAttribute('role', 'status'); message.id = 'sync-message';
  section.append(title, statusLine, lastSync, body, message);
  container.append(section);

  let enabled = false;
  let busy = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let afterSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function showStatus(key: keyof typeof statuses | null) {
    statusLine.hidden = key === null;
    if (key === null) return;
    const status = statuses[key];
    statusLine.dataset.tone = status.tone;
    statusLine.replaceChildren(text('span', status.symbol, 'sync-status-symbol'), text('span', status.label));
    const last = readLastSync();
    lastSync.textContent = last ? `最終同期：${tokyoTime(last)}（日本時間）` : '';
  }

  function updateStorageLocation() {
    const location = document.querySelector('.storage-location');
    if (!location) return;
    location.querySelector('.storage-location-sync')?.remove();
    // The default text says household data is not stored in the cloud; it is hidden while sync is on.
    const cloud = location.querySelector<HTMLElement>('.storage-location-cloud');
    if (cloud) cloud.hidden = enabled;
    if (!enabled) return;
    const note = text('p', '端末間の同期がオンです。暗号化した家計簿全体をKakeiMatch Cloudにも保存し、同じアカウントの端末と交換しています。AIアカウントの認証や利用枠の情報もCloudflareで管理します。', 'storage-location-sync');
    location.querySelector('.storage-location-device')?.after(note);
  }

  function aboutSync() {
    const about = document.createElement('details');
    about.className = 'settings-inner-disclosure';
    about.append(text('summary', '同期について'),
      text('p', '同じアカウントでログインした自分の端末どうしで、家計簿全体（取引・支払元・カテゴリ・予算・定期登録、レシートと明細、照合の判断、残っている画像とCSV原本）を交換します。'),
      text('p', '送る前にこの端末で暗号化し、KakeiMatch Cloudに保存します。復号に使う鍵と復旧コードは送りません。復旧コードを失い、同期している端末もすべて失うと、クラウドのデータは復号できません。'),
      text('p', '変更は家計簿全体の単位で交換します。2台で同時に変更した場合は自動でまとめず、どちらの内容を使うかを選んでもらいます。選ばなかった側の変更は合流しません。'),
      text('p', '同期はアプリを開いている間に行います。オフラインやログインしていない間も、この端末の家計簿はそのまま使えます。'));
    return about;
  }

  /** Shows a one-time recovery code and runs `next` once the user confirms it is stored. */
  function showRecoveryCode(code: string, intro: string, next: () => Promise<void>) {
    const panel = document.createElement('div');
    panel.className = 'sync-recovery-code';
    const codeText = text('code', code); codeText.id = 'sync-recovery-code';
    const confirm = document.createElement('input'); confirm.type = 'checkbox'; confirm.id = 'sync-recovery-saved';
    const label = document.createElement('label'); label.htmlFor = confirm.id;
    label.append(confirm, ' 復旧コードを端末の外（パスワード管理アプリなど）に保存しました');
    const proceed = button('続ける', 'primary', async () => { panel.remove(); await next(); }, 'sync-recovery-continue');
    proceed.disabled = true;
    confirm.addEventListener('change', () => { proceed.disabled = !confirm.checked; });
    panel.append(text('p', intro), codeText,
      button('コピー', 'secondary', async () => {
        try { await navigator.clipboard.writeText(code); message.textContent = '復旧コードをコピーしました。'; }
        catch { message.textContent = 'コピーできませんでした。コードを書き写してください。'; }
      }),
      text('p', 'このコードは今だけ表示します。KakeiMatchも再発行できません。別の端末で参加するときに使います。', 'muted'),
      label, proceed);
    body.replaceChildren(panel);
    codeText.focus();
  }

  /** Runs an action that needs a recent Passkey sign-in, asking for one when the server requires it. */
  async function withRecentSignIn<T>(action: () => Promise<T>): Promise<T | null> {
    try { return await action(); } catch (error) {
      if (!(error instanceof SyncApiError) || (error.status !== 401 && error.code !== 'recent_sign_in_required')) throw error;
      message.textContent = '安全のため、Passkeyでもう一度ログインしてください。';
      if (!await options.reauthenticate()) return null;
      return action();
    }
  }

  function renderOff() {
    showStatus(null);
    lastSync.textContent = '';
    body.replaceChildren(
      text('p', 'オフです。オンにすると、同じアカウントの端末どうしで家計簿を暗号化して交換します。'),
      aboutSync(),
      button('この端末で同期を始める', 'primary', startSync, 'sync-enable'),
      button('別の端末の同期に参加する', 'secondary', renderJoin, 'sync-join-start'),
    );
  }

  function renderJoin() {
    const input = document.createElement('input');
    input.id = 'sync-recovery-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'KM1-…';
    const label = text('label', '復旧コード') as HTMLLabelElement; label.htmlFor = input.id;
    body.replaceChildren(
      text('p', '同期を始めた端末に表示された復旧コードを入力してください。'),
      text('p', 'この端末の今の家計データは消さずに「切り替え前の家計データ」として残し、同期している家計簿を開きます。2つの家計簿は自動でまとめません。', 'muted'),
      label, input,
      button('参加する', 'primary', async () => {
        const code = input.value.trim();
        if (!code) { message.textContent = '復旧コードを入力してください。'; input.focus(); return; }
        await run(async () => {
          const outcome = await withRecentSignIn(() => engine.join(code));
          if (outcome) await handle(outcome, true);
        }, '参加しています…', error => error instanceof Error && error.name === 'EncryptedHouseholdError'
          ? '復旧コードが違います。同期を始めた端末で表示されたコードを確認してください。' : null);
      }, 'sync-join'),
      button('やめる', 'text', async () => { await refresh(); }),
    );
    input.focus();
  }

  async function startSync() {
    if (!window.confirm('端末間の同期を始めますか？\n\n暗号化した家計簿全体をKakeiMatch Cloudに保存します。次に表示する復旧コードを、端末の外に保存してください。')) return;
    await run(async () => {
      const result = await withRecentSignIn(() => engine.enable());
      if (!result) return;
      enabled = true;
      updateStorageLocation();
      showRecoveryCode(result.recoveryCode, '同期を始めました。この復旧コードを保存してください。', async () => { await syncNow(true); });
    }, '同期の準備をしています…');
  }

  function renderOn(outcome: SyncOutcome | null) {
    const children: Node[] = [];
    if (outcome?.status === 'conflict') {
      children.push(text('p', '両方の端末で変更されています。内容を確認してください。', 'sync-conflict'),
        text('p', 'どちらかの内容を選ぶと、それが新しい家計簿として同期されます。選ばなかった側の変更は合流しません。この端末の内容は、別の端末を選んでも「切り替え前の家計データ」としてこの端末に残ります。', 'muted'),
        button('この端末の内容を使う', 'secondary', () => choose('this'), 'sync-keep-this'),
        button('別の端末の内容を使う', 'secondary', () => choose('other'), 'sync-use-other'));
    } else if (outcome?.status === 'remote_changes') {
      children.push(text('p', '入力中の画面を閉じてから反映します。', 'muted'),
        button('反映する', 'primary', () => syncNow(true), 'sync-apply-remote'));
    } else if (outcome?.status === 'rejoin_required') {
      children.push(text('p', '別の端末で失効されたか、同期データが削除されました。この端末の家計データは残っています。続けるには新しい復旧コードで参加し直してください。'),
        button('参加し直す', 'primary', async () => { await engine.stopOnThisDevice(); enabled = false; updateStorageLocation(); renderJoin(); }, 'sync-rejoin'));
    } else if (outcome?.status === 'sign_in_required') {
      children.push(button('ログインする', 'primary', async () => { if (await options.reauthenticate()) await syncNow(true); }, 'sync-sign-in'));
    } else if (outcome?.status === 'recovery_code_required') {
      renderJoin();
      return;
    } else {
      children.push(button('今すぐ同期', 'primary', () => syncNow(true), 'sync-now'));
    }
    const manage = document.createElement('details');
    manage.className = 'settings-inner-disclosure danger-zone';
    manage.id = 'sync-manage';
    const deviceList = document.createElement('ul'); deviceList.className = 'sync-devices';
    manage.append(text('summary', '端末と同期データの管理'), deviceList,
      text('p', 'この端末の同期を停止しても、この端末の家計データとクラウドの同期データは残ります。', 'muted'),
      button('この端末の同期を停止', 'text', stopHere, 'sync-stop'),
      text('p', 'クラウドの同期データをすべて削除しても、各端末に保存済みの家計データは消えません。他の端末のデータを遠隔で消すことはできません。', 'muted'),
      button('クラウドの同期データをすべて削除', 'danger', deleteCloud, 'sync-delete-cloud'));
    manage.addEventListener('toggle', () => { if (manage.open) void listDevices(deviceList); });
    children.push(aboutSync(), manage);
    body.replaceChildren(...children);
  }

  async function listDevices(list: HTMLUListElement) {
    try {
      const devices = (await engine.devices()).filter(device => device.revokedAt === null);
      list.replaceChildren(...devices.map((device, index) => {
        const row = document.createElement('li');
        row.append(text('span', device.current ? 'この端末' : `端末 ${index + 1}（${tokyoTime(device.createdAt)}に追加）`));
        if (!device.current) row.append(button('失効', 'danger', () => revoke(device.deviceId)));
        return row;
      }));
    } catch {
      list.replaceChildren(text('li', '端末の一覧を取得できません。オンラインで再度お試しください。'));
    }
  }

  async function revoke(deviceId: string) {
    if (!window.confirm('この端末を同期から外しますか？\n\n外した端末に保存済みの家計データは消せません。新しい復旧コードを作るので、ほかの端末も参加し直しが必要です。')) return;
    await run(async () => {
      const result = await engine.revokeDevice(deviceId);
      showRecoveryCode(result.recoveryCode, '端末を外し、新しい復旧コードを作りました。以前のコードは使えません。', async () => { await handle(result.outcome, false); });
    }, '端末を外しています…');
  }

  async function stopHere() {
    if (!window.confirm('この端末の同期を停止しますか？\n\nこの端末の家計データとクラウドの同期データは残ります。')) return;
    await run(async () => {
      await engine.stopOnThisDevice();
      enabled = false;
      updateStorageLocation();
      renderOff();
      message.textContent = 'この端末の同期を停止しました。家計データはこの端末に残っています。';
    });
  }

  async function deleteCloud() {
    if (!window.confirm('クラウドの同期データをすべて削除しますか？\n\n各端末に保存済みの家計データは消えません。他の端末のデータを遠隔で消すことはできません。元に戻せません。')) return;
    if (window.prompt('確認のため「同期データを削除」と入力してください。') !== '同期データを削除') { message.textContent = '削除を取り消しました。'; return; }
    await run(async () => {
      const deleted = await withRecentSignIn(async () => { await engine.deleteCloudData(); return true; });
      if (!deleted) return;
      enabled = false;
      updateStorageLocation();
      renderOff();
      message.textContent = 'クラウドの同期データを削除しました。この端末の家計データは残っています。';
    }, '削除しています…', () => '削除を完了できませんでした。削除済みではありません。オンラインで再度お試しください。');
  }

  async function choose(side: 'this' | 'other') {
    const confirmText = side === 'this'
      ? 'この端末の内容を同期しますか？別の端末だけで行った変更は合流しません。'
      : '別の端末の内容に切り替えますか？この端末だけで行った変更は合流しません。この端末の今のデータは「切り替え前の家計データ」として残ります。';
    if (!window.confirm(confirmText)) return;
    await run(async () => { await handle(side === 'this' ? await engine.keepThisDevice() : await engine.useOtherDevice(), true); }, '同期しています…');
  }

  async function run(action: () => Promise<void>, pending = '', explain: (error: unknown) => string | null = () => null) {
    if (busy) return;
    busy = true;
    for (const node of Array.from(section.querySelectorAll('button'))) node.disabled = true;
    if (pending) message.textContent = pending;
    try {
      await action();
      if (message.textContent === pending) message.textContent = '';
    } catch (error) {
      message.textContent = explain(error) ?? (error instanceof SyncApiError && error.status === 0
        ? 'オフラインのため完了できませんでした。この端末の家計簿はそのまま使えます。'
        : 'できませんでした。この端末の家計データは変更していません。時間をおいて再度お試しください。');
    } finally {
      busy = false;
      for (const node of Array.from(section.querySelectorAll('button'))) node.disabled = false;
      // The recovery code's continue button stays off until the user confirms the code is stored.
      const saved = section.querySelector<HTMLInputElement>('#sync-recovery-saved');
      const proceed = section.querySelector<HTMLButtonElement>('#sync-recovery-continue');
      if (saved && proceed) proceed.disabled = !saved.checked;
    }
  }

  /** Reflects one sync result. `userAction` lets an import reload right away. */
  async function handle(outcome: SyncOutcome, userAction: boolean) {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (outcome.status === 'off') { enabled = false; updateStorageLocation(); renderOff(); return; }
    enabled = true;
    updateStorageLocation();
    if (outcome.status === 'synced' || outcome.status === 'published' || outcome.status === 'imported') {
      try { localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString()); } catch { /* the time is a display aid only */ }
    }
    if (outcome.status === 'imported') {
      // The other device's household is now active here. Reload unless someone is typing.
      if (userAction || !options.isEditing()) { location.reload(); return; }
      showStatus('remote');
      message.textContent = '別の端末の変更を反映しました。最新の内容を表示するには再読み込みしてください。';
      return;
    }
    if (outcome.status === 'waiting') {
      retryTimer = setTimeout(() => { void syncNow(false); }, Math.max(outcome.retryAfterMs, 1000));
    }
    const key = {
      synced: 'synced', published: hasUnsentChanges(readSyncState(guard.profileId)) ? 'unsent' : 'synced',
      waiting: 'unsent', conflict: 'remote', remote_changes: 'remote', offline: 'offline',
      sign_in_required: 'sign_in', rejoin_required: 'removed', recovery_code_required: 'sign_in', failed: 'failed',
    }[outcome.status] as keyof typeof statuses;
    showStatus(key);
    if (outcome.status === 'failed' && userAction) message.textContent = '同期できませんでした。この端末の家計簿はそのまま使えます。時間をおいて再度お試しください。';
    if (outcome.status === 'published' || outcome.status === 'synced') message.textContent = userAction ? '同期しました。' : message.textContent;
    renderOn(outcome);
  }

  async function syncNow(userAction: boolean) {
    if (busy) return;
    if (!userAction && !enabled) return;
    if (userAction) {
      await run(async () => { await handle(await engine.sync({ allowImport: true }), true); }, '同期しています…');
    } else {
      await handle(await engine.sync({ allowImport: !options.isEditing() }), false);
    }
  }

  async function refresh() {
    enabled = await engine.isEnabled();
    updateStorageLocation();
    if (!enabled) { renderOff(); return; }
    showStatus(hasUnsentChanges(readSyncState(guard.profileId)) ? 'unsent' : 'synced');
    renderOn(null);
    await syncNow(false);
  }

  guard.onChange(() => {
    if (!enabled) return;
    if (afterSaveTimer) clearTimeout(afterSaveTimer);
    showStatus('unsent');
    afterSaveTimer = setTimeout(() => { void syncNow(false); }, AFTER_SAVE_DELAY_MS);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncNow(false); });
  window.addEventListener('online', () => { void syncNow(false); });
  window.addEventListener('offline', () => { if (enabled) showStatus('offline'); });

  return { refresh };
}
