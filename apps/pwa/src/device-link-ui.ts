// docs/UX.md 端末間の同期: two of the user's devices connect directly and settle on one household.
import type { LocalDataRepository } from '../../../src/lib/local-data';
import { createLocalSnapshot, restoreLocalBackup, type BackupLedger } from './local-backup';
import { DeviceLink, type FailureReason, type HouseholdSummary, type LinkRole } from './device-link';
import { LinkCodeError, sha256Hex } from './device-link-code';
import { markJustReceived, readLastSync, saveLastSync, syncDetailText, syncRowText, syncState, takeJustReceived } from './device-link-status';
import { qrSvg, scanQr } from './device-link-qr';
import { recordLocalDiagnostic } from './local-diagnostics';

type LinkLedger = BackupLedger & { getSearchTransactions(): Promise<Array<{ transaction: { id: string; date: string } }>> };

const text = (tag: string, value: string, className = '') => {
  const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element;
};
const button = (label: string, onClick: () => void, kind: 'primary' | 'secondary' | 'text' = 'secondary') => {
  const element = document.createElement('button'); element.type = 'button'; element.textContent = label;
  if (kind !== 'primary') element.className = kind === 'text' ? 'text-button' : 'secondary';
  element.addEventListener('click', onClick); return element;
};

export function deviceName(userAgent = navigator.userAgent): string {
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Macintosh/.test(userAgent)) return 'Mac';
  if (/Windows/.test(userAgent)) return 'Windows';
  return '';
}
function summaryLine(summary: HouseholdSummary): string {
  const latest = summary.latestDate ? `最新 ${Number(summary.latestDate.slice(5, 7))}月${Number(summary.latestDate.slice(8, 10))}日` : '取引なし';
  return `取引${summary.transactions}件・${latest}`;
}

export function initializeDeviceLinkUi(repository: LocalDataRepository, ledger: LinkLedger) {
  const summary = async (): Promise<HouseholdSummary> => {
    const rows = await ledger.getSearchTransactions();
    const latest = rows.reduce<string | null>((max, row) => (max === null || row.transaction.date > max ? row.transaction.date : max), null);
    // Any change to any transaction changes the fingerprint, so "changed since the last sync" is exact.
    const ordered = rows.map(row => row.transaction).sort((a, b) => a.id.localeCompare(b.id));
    const fingerprint = await sha256Hex(new TextEncoder().encode(JSON.stringify(ordered)).buffer as ArrayBuffer);
    return { device: deviceName(), transactions: rows.length, latestDate: latest, fingerprint };
  };
  /** Compares this household with the last sync; right after receiving, the reloaded household becomes the baseline. */
  const currentState = async () => {
    const own = await summary();
    let last = readLastSync();
    if (last && last.fingerprint === null) { last = { ...last, fingerprint: own.fingerprint ?? null }; saveLastSync(last); }
    return syncState(last, own.fingerprint ?? '');
  };

  // docs/UX.md 設定: one entry in データ; the explanation and the steps are in the dialog it opens.
  const entry = document.createElement('button');
  entry.type = 'button'; entry.className = 'master-entry'; entry.id = 'device-link-entry'; entry.setAttribute('aria-label', 'ほかの端末と同期');
  const entryValue = text('span', '', 'master-entry-value'); entryValue.id = 'device-link-state';
  entry.append(text('span', 'ほかの端末と同期', 'master-entry-name'), entryValue);
  entry.addEventListener('click', () => open());
  document.getElementById('data-rows')!.prepend(entry);
  const refreshEntry = () => { void currentState().then(state => { entryValue.textContent = syncRowText(state); }).catch(() => { entryValue.textContent = ''; }); };
  refreshEntry();
  document.getElementById('settings-tab')!.addEventListener('click', refreshEntry);

  function open() {
    const dialog = document.createElement('dialog');
    dialog.className = 'device-link-dialog'; dialog.setAttribute('aria-labelledby', 'device-link-title');
    const title = text('h2', 'ほかの端末と同期'); title.id = 'device-link-title';
    const body = document.createElement('div'); body.className = 'device-link-body';
    const status = text('p', ''); status.setAttribute('role', 'status'); status.className = 'device-link-status';
    const closeButton = button('閉じる', () => close(), 'text');
    dialog.append(title, body, status, closeButton);
    document.body.append(dialog);
    dialog.showModal();

    let link: DeviceLink | null = null;
    let ownSummary: HouseholdSummary | null = null;
    let peerSummary: HouseholdSummary | null = null;
    let scanner: { stop(): void } | null = null;
    let restoring = false;
    const stopScanner = () => { scanner?.stop(); scanner = null; };
    function close() {
      if (restoring) return;
      stopScanner(); link?.close(); dialog.close(); dialog.remove();
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    const show = (...nodes: Node[]) => { stopScanner(); body.replaceChildren(...nodes); status.textContent = ''; };
    const failMessage = (error: unknown) => error instanceof LinkCodeError ? error.message : 'つなげませんでした。2台が同じWi-Fiにつながっているか確かめて、はじめからやり直してください。';

    /** The code as a QR, with the same code as text for a device without a camera. */
    const codeBlock = (code: string, label: string) => {
      const wrap = document.createElement('div'); wrap.className = 'link-code';
      const area = document.createElement('textarea'); area.readOnly = true; area.value = code; area.rows = 3; area.setAttribute('aria-label', `${label}（文字）`);
      const copied = text('span', '', 'muted');
      const copy = button('コードをコピー', () => {
        void navigator.clipboard.writeText(code).then(() => { copied.textContent = 'コピーしました'; }, () => { area.select(); copied.textContent = '選んだコードをコピーしてください'; });
      });
      const asText = document.createElement('details'); asText.append(text('summary', '文字のコードで渡す'), area, copy, copied);
      wrap.append(qrSvg(code, label), asText);
      return wrap;
    };
    /** Reads a code with the camera, or from pasted text. */
    const codeReader = (label: string, submit: (code: string) => Promise<void>) => {
      const wrap = document.createElement('div'); wrap.className = 'link-reader';
      const video = document.createElement('video'); video.className = 'link-camera'; video.hidden = true;
      const area = document.createElement('textarea'); area.rows = 3; area.placeholder = 'コードを貼り付け'; area.setAttribute('aria-label', label);
      let busy = false;
      const run = (code: string) => {
        if (busy) return; busy = true; status.textContent = 'つないでいます…';
        void submit(code).catch(error => { status.textContent = failMessage(error); recordLocalDiagnostic('save', error); }).finally(() => { busy = false; });
      };
      const camera = button('カメラで読む', () => {
        video.hidden = false; status.textContent = 'QRコードをカメラに映してください。';
        void scanQr(video, value => { if (!value.startsWith('KM1')) return false; video.hidden = true; run(value); return true; })
          .then(handle => { scanner = handle; }, () => { video.hidden = true; status.textContent = 'カメラを使えませんでした。コードを貼り付けてください。'; });
      }, 'primary');
      const paste = button('貼り付けたコードで続ける', () => run(area.value));
      wrap.append(camera, video, area, paste);
      return wrap;
    };

    const events = {
      onPeerSummary: (peer: HouseholdSummary) => { void summary().then(own => { ownSummary = own; peerSummary = peer; choose(own, peer); }); },
      onChoice: (source: LinkRole, chosenHere: boolean) => {
        if (!link) return;
        if (source === link.role) {
          show(text('p', '家計簿を送っています。2台とも、この画面を開いたままにしてください。'));
          void createLocalSnapshot(repository, ledger).then(snapshot => link!.sendSnapshot(snapshot)).catch(error => { recordLocalDiagnostic('save', error); link?.reportFailure(); status.textContent = '家計簿を送れませんでした。はじめからやり直してください。'; });
        } else {
          show(text('p', chosenHere ? '相手の家計簿を受け取っています。2台とも、この画面を開いたままにしてください。' : '相手の端末で、相手の家計簿にそろえることが選ばれました。受け取っています。'));
          pendingConfirm = !chosenHere;
        }
      },
      onProgress: (fraction: number) => { status.textContent = `${Math.round(fraction * 100)}%`; },
      onSnapshot: (snapshot: Blob) => { if (pendingConfirm) confirmReplace(snapshot); else void replace(snapshot); },
      onPeerReceived: () => {
        const own = ownSummary!;
        saveLastSync({ at: new Date().toISOString(), peerDevice: peerSummary?.device ?? '', direction: 'sent', transactions: own.transactions, latestDate: own.latestDate, fingerprint: own.fingerprint ?? null });
        refreshEntry();
        show(text('p', '✓ そろいました', 'device-link-done'), text('p', '相手の端末の家計簿を、この端末の家計簿にそろえました。'), text('p', summaryLine(own), 'muted'));
      },
      onFailed: (reason: FailureReason) => {
        if (restoring) return;
        if (reason === 'unreachable') {
          show(text('p', 'つながりませんでした。家計簿は変えていません。次を確かめてから、はじめからやり直してください。'), unreachableHelp());
          return;
        }
        status.textContent = reason === 'broken_transfer' ? '途中で家計簿が欠けました。家計簿は変えていません。はじめからやり直してください。'
          : '接続が切れました。家計簿は変えていません。はじめからやり直してください。';
      },
    };
    let pendingConfirm = false;
    const unreachableHelp = () => {
      const list = document.createElement('ul'); list.className = 'device-link-help';
      for (const item of ['2台が同じWi-Fi（同じネットワーク名）につながっている',
        'Macでは「システム設定」→「プライバシーとセキュリティ」→「ローカルネットワーク」で、使っているブラウザーがオンになっている（変えた後はMacの再起動が要ることがあります）',
        'Wi-Fiルーターで、端末どうしの通信を止める設定（プライバシーセパレーター、AP隔離など）が切れている']) list.append(text('li', item));
      return list;
    };

    function choose(own: HouseholdSummary, peer: HouseholdSummary) {
      const rows = document.createElement('ul'); rows.className = 'device-link-households';
      const named = (who: string, device: string) => device ? `${who}（${device}）` : who;
      for (const [who, item] of [[named('この端末', own.device), own], [named('相手の端末', peer.device), peer]] as const) {
        const row = document.createElement('li'); row.append(text('span', who), text('span', summaryLine(item), 'muted')); rows.append(row);
      }
      const same = Boolean(own.fingerprint) && own.fingerprint === peer.fingerprint;
      show(text('p', same ? 'つながりました。2台の家計簿は同じです。そろえる必要はありません。' : 'つながりました。どちらの家計簿にそろえますか？'), rows,
        button('この端末の家計簿にそろえる', () => { link?.choose(link.role); status.textContent = '相手の端末の応答を待っています…'; }, 'primary'),
        button('相手の家計簿にそろえる', () => { link?.choose(link.role === 'offerer' ? 'answerer' : 'offerer'); status.textContent = '相手の端末の応答を待っています…'; }),
        text('p', 'そろえられた側の元の家計簿は、その端末の設定の「切り替え前の家計データに戻る」で戻せます。', 'muted'));
    }
    function confirmReplace(snapshot: Blob) {
      show(text('p', '受け取った家計簿で、この端末の家計簿を置き換えますか？元の家計簿は「切り替え前の家計データに戻る」で戻せます。'),
        button('置き換える', () => { void replace(snapshot); }, 'primary'),
        button('やめる', () => { link?.reportFailure(); close(); }));
    }
    async function replace(snapshot: Blob) {
      restoring = true; closeButton.disabled = true;
      show(text('p', '家計簿を切り替えています。数秒かかります。この画面を閉じずにお待ちください。'));
      try {
        await restoreLocalBackup(snapshot, ledger);
        const peer = peerSummary;
        saveLastSync({ at: new Date().toISOString(), peerDevice: peer?.device ?? '', direction: 'received', transactions: peer?.transactions ?? 0, latestDate: peer?.latestDate ?? null, fingerprint: null });
        markJustReceived(`✓ ${peer?.device || '相手の端末'}の家計簿にそろえました（${peer ? summaryLine(peer) : ''}）。`);
        link?.confirmReceived();
        recordLocalDiagnostic('restore');
        status.textContent = '切り替えました。読み込み直します。';
        // Let the confirmation reach the other device before the page goes away.
        setTimeout(() => location.reload(), 500);
      } catch (error) {
        restoring = false; closeButton.disabled = false;
        recordLocalDiagnostic('restore', error);
        link?.reportFailure();
        status.textContent = '切り替えられませんでした。この端末の家計簿は元のままです。';
      }
    }

    function begin() {
      const state = document.createElement('div'); state.className = 'device-link-state'; state.setAttribute('aria-live', 'polite');
      void currentState().then(current => { state.replaceChildren(...syncDetailText(current).map(line => text('p', line))); }).catch(() => undefined);
      show(state, text('p', '同じWi-Fiにつないだ自分の2台の間で、家計簿をどちらか一方にそろえます。サーバーを通さず、2台の間で直接、暗号化して送ります。', 'muted'),
        button('この端末から始める', () => { void startHere(); }, 'primary'),
        button('相手の端末のコードを読む', () => { joinOther(); }));
    }
    async function startHere() {
      status.textContent = 'コードを作っています…';
      try {
        const started = await DeviceLink.start(summary, events);
        link = started.link;
        show(text('h3', '1. 相手の端末で読んでもらう'),
          text('p', '相手の端末で「設定」→「ほかの端末と同期」→「相手の端末のコードを読む」を選び、このQRコードを読んでください。'),
          codeBlock(started.code, '最初のコード'),
          text('h3', '2. 相手の返事を読む'),
          text('p', '相手の端末に返事のコードが出たら、読んでください。'),
          codeReader('返事のコード', async code => { await started.accept(code); status.textContent = 'つないでいます…'; }));
      } catch (error) { status.textContent = failMessage(error); }
    }
    function joinOther() {
      show(text('p', '相手の端末に出ている最初のコードを読んでください。'),
        codeReader('最初のコード', async code => {
          const joined = await DeviceLink.join(code, summary, events);
          link = joined.link;
          show(text('p', 'このQRコードを、相手の端末で読んでください。'), codeBlock(joined.code, '返事のコード'));
          status.textContent = 'つながるのを待っています…';
        }));
    }
    begin();
  }

  return {
    /** After the first screen has rendered (it clears the message), say that this device was just replaced. */
    announceReceived() {
      const received = takeJustReceived();
      const message = document.getElementById('message');
      if (received && message) message.textContent = received;
    },
  };
}
