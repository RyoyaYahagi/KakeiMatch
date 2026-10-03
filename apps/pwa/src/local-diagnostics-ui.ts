import { clearLocalDiagnostics, getLocalDiagnosticReport } from './local-diagnostics';

declare const __APP_BUILD_ID__: string;

export function initializeDiagnosticsUi(container: HTMLElement) {
  const section = document.createElement('section');
  section.className = 'surface-section settings-panel';
  section.id = 'local-diagnostics';
  const heading = document.createElement('h4'); heading.textContent = '端末内の診断';
  const explanation = document.createElement('p');
  explanation.textContent = '不具合を調べるためのアプリの版と処理結果です。家計内容・入力文字・認証情報は含めません。自動送信せず、アプリを開いている間の直近15分・最大40件だけをメモリに保持します。再読み込みでも消えます。';
  const preview = document.createElement('pre'); preview.id = 'diagnostics-preview'; preview.className = 'diagnostics-preview'; preview.tabIndex = 0;
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  let snapshot = '';
  function refresh() {
    snapshot = JSON.stringify(getLocalDiagnosticReport(__APP_BUILD_ID__, navigator.onLine), null, 2);
    preview.textContent = snapshot;
  }
  function button(id: string, label: string, action: () => void | Promise<void>) {
    const element = document.createElement('button'); element.id = id; element.type = 'button'; element.className = 'secondary'; element.textContent = label;
    element.addEventListener('click', () => { void action(); });
    return element;
  }
  const disclosure = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = '診断内容を確認する';
  disclosure.addEventListener('toggle', () => { if (disclosure.open) refresh(); });
  disclosure.append(summary, preview,
    button('diagnostics-refresh', '表示を更新', () => { refresh(); status.textContent = '表示を更新しました。'; }),
    button('diagnostics-copy', '表示内容をコピー', async () => {
      try { await navigator.clipboard.writeText(snapshot); status.textContent = '診断内容をコピーしました。'; }
      catch { status.textContent = 'コピーできませんでした。ファイルに書き出すか、表示内容を選択してコピーしてください。'; }
    }),
    button('diagnostics-export', '表示内容を書き出す', () => {
      const url = URL.createObjectURL(new Blob([snapshot], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'kakeimatch-diagnostics.json';
      section.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = '診断ファイルを生成しました。保存先を確認してください。';
    }),
    button('diagnostics-clear', '診断記録を消す', () => { clearLocalDiagnostics(); refresh(); status.textContent = '診断記録を消しました。家計データは残っています。'; }), status,
  );
  section.append(heading, explanation, disclosure); container.append(section);
}
