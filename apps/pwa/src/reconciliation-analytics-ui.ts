import { exportReconciliationAnalysis, summarizeReconciliation, type AnalysisRun } from '../../../src/lib/reconciliation-analytics';

export function reconciliationAnalyticsSection(runs: AnalysisRun[], testRuns: AnalysisRun[] = [], runTest?: () => Promise<AnalysisRun>) {
  const root = document.createElement('details'); root.className = 'review-history'; root.dataset.testid = 'reconciliation-analytics';
  const title = document.createElement('summary'); title.textContent = '照合の分析'; root.append(title);
  const summary = summarizeReconciliation(runs);
  const rate = (part: number, total: number) => total ? `${Math.round(part / total * 100)}%（${part}/${total}件）` : '未集計（対象0件）';
  const lines = [
    `保存した照合：${summary.recordedRuns}回（内容の記録がない過去の照合：${summary.runs - summary.recordedRuns}回）`,
    `分析対象の明細：${summary.statements}件`,
    `1位の採用率：${rate(summary.firstChoices, summary.manualMatches)}`,
    `候補なし率：${rate(summary.noCandidates, summary.statements)}`,
    `候補の却下：${summary.rejected}件`,
    `反映の失敗率：${rate(summary.failed, summary.terminalDecisions)}`,
    '1位の採用率は、人が「同じ支出」と判断して反映できた候補が対象です。自動一致や未確認は正解として数えません。候補なしは誤判定を意味しません。取り消した判断は採用率から除きます。反映の失敗率は判断の最新状態で集計し、再試行で成功したものと「登録しない」は失敗に数えません。',
    '履歴は端末内に保存します。匿名化版には店名・取引日・取引額・支払元名を含めません。差額・日付差・操作日時は含みます。詳細版には照合時点の内容を含めます。',
  ];
  for (const line of lines) { const p = document.createElement('p'); p.textContent = line; root.append(p); }
  function exportButton(rows: AnalysisRun[], detailed: boolean, test = false) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
    button.textContent = `${test ? 'テストの' : ''}${detailed ? '詳細版を書き出す（店名・金額を含む）' : '匿名化版を書き出す'}`;
    button.addEventListener('click', () => {
      const report = exportReconciliationAnalysis(rows, detailed, new Date().toISOString(), test ? 'test' : 'normal');
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `reconciliation-${test ? 'test-' : ''}analysis-${report.mode}.json`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    return button;
  }
  for (const detailed of [false, true]) root.append(exportButton(runs, detailed));
  if (runTest) {
    const heading = document.createElement('h3'); heading.textContent = 'テスト再照合';
    const note = document.createElement('p'); note.textContent = '判断済みの明細と照合済みの支出も対象にします。家計簿や通常の判断は変更しません。現在の記録・支払元設定・学習済み店名で再計算するため、当時の再現や正解率の測定ではありません。明細から作成した支出も候補に含まれます。';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = 'テスト再照合する';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const results = document.createElement('div');
    const render = () => {
      results.replaceChildren();
      const latest = [...testRuns].sort((a,b) => b.completedAt.localeCompare(a.completedAt))[0];
      if (!latest) { status.textContent = 'テスト結果はまだありません。'; return; }
      status.textContent = `保存したテスト：${testRuns.length}回。最新の対象明細${latest.statementResults.length}件、候補${latest.candidates.length}件。`;
      for (const detailed of [false, true]) results.append(exportButton(testRuns, detailed, true));
    };
    button.addEventListener('click', async () => {
      button.disabled = true; status.textContent = 'テスト再照合中…';
      try { testRuns = [...testRuns, await runTest()]; render(); }
      catch { status.textContent = 'テスト再照合を保存できませんでした。もう一度お試しください。'; }
      finally { button.disabled = false; }
    });
    root.append(heading, note, button, status, results); render();
  }
  return root;
}
