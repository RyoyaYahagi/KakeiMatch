# 実装計画

この文書は現在のlocal-first製品と残作業を記録します。旧サーバー中心の実装計画は[legacy implementation plan](legacy/IMPLEMENTATION_PLAN.md)に履歴として残しています。実装作業はGitHub Issueで管理し、各Issueの範囲と完了条件はその本文を正本とします。

## 本番構成

本番clientは `apps/pwa` で、Cloudflare Workerから配信します。本番の正規URLは `https://kakeimatch.yhgry.workers.dev` です。ブラウザー保存領域はURLごとに分かれるため、利用開始後もこのURLを維持してください。previewは合成データだけで使用します。

家計簿、レシート、明細、照合状態は利用者の端末に保存します。ブラウザー版Actualエンジンが家計簿を管理し、KakeiMatchのIndexedDBが記録と原本を保存します。Cloud accountは家計操作に不要です。CloudflareのBetter AuthとD1は、本人確認、session、Passkey、招待・回復、利用権限、AI利用量だけに使います。GeminiとJevへの要求は同一originのWorker routeを通します。

## 現在の利用フロー

1. レシート画像と入力途中の記録を端末へ保存します。利用者は手入力するか、Geminiの抽出を要求できます。
2. AI応答をレシートschemaで検証します。利用者が店名、日付、金額、カテゴリ、口座を確認します。
3. 確認済み支出をブラウザー版Actual APIから端末内の家計簿へ登録します。
4. 対応する明細CSVをブラウザー内で解析し、正規化した行を端末へ保存します。PayPayカードの確認済み形式に対応し、列の意味を確認していない形式は受け付けません。
5. 確認済みレシートと明細行を決定的な端末内処理で照合します。判断が必要な結果を利用者に提示し、確定した判断を端末内のActual家計簿へ反映します。
6. `.kmb` backupを書き出します。必要な場合は別の端末profileへstagingしてから切り替えます。

AIはレシート値やカテゴリを提案します。照合、データ境界、状態遷移、金額処理は行いません。データの採用と状態変更はschema検証と決定的なコードで行います。

## 現行仕様と確認記録

- [アーキテクチャ](ARCHITECTURE.md): 本番構成とデータ境界
- [ローカル利用フロー](LOCAL_FIRST_FLOW.md): synthetic browser / iPhone確認手順
- [バックアップと復元](LOCAL_BACKUP.md): `.kmb` export、staged restore、整理、既知の制約
- [Cloud account](CLOUD_ACCOUNT.md): Passkey、AI利用、権限、D1の運用
- [デプロイ](DEPLOYMENT.md): 本番とpreviewの運用
- [明細形式](STATEMENT_FORMATS.md): 確認済みの明細形式

## 残作業

実装状態はGitHub Issuesで管理します。legacyのサーバー中心計画にあるphase checklistを本番要件として扱わないでください。cloud backup、billing、local app lock、移行framework、複数端末同期、Actual孤児データ整理は別Issueの範囲です。Actual孤児データの整理制約はIssue #58で管理しています。

確認済みの内容と未確認の作業は、ローカル利用フローとバックアップ文書に記録します。Issue #39後のiPhone確認は、ホーム画面からの起動、既存合成データの表示、オフライン起動、バックアップ画面への入口だけを確認します。実施前に成功と記録しないでください。
