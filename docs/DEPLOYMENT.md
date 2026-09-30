# デプロイ

本番のKakeiMatchは `apps/pwa` のPWAとCloudflare Workerで構成します。利用者の端末に家計データを保存します。自宅Linux、Docker、Next.js server、Actual Sync Server、server-side household storageは必要ありません。

## 本番URLとデータ

アプリが前提とする本番の正規originは `https://kakeimatch.workers.dev` です。ブラウザーの保存領域はoriginごとに分かれます。利用開始後にWorker名やoriginを変更すると、保存済みデータをアプリから参照できなくなる可能性があります。Worker名とoriginを安定して維持してください。ただし、configでproduction Worker名を `kakeimatch` に設定しただけでは、正規originへのroutingが成立したことを意味しません。Cloudflare側のroute、D1、secretはIssue #39ではprovisioningも実接続確認もしていないため、正規originから本番Workerへ接続できることは未検証です。正規origin自体は変更しません。

同一WorkerがPWAと `/api/auth/*`、`/api/account/*`、`/api/ai/*` を配信します。WorkerのD1 bindingは、本人確認、session、Passkey、招待・回復、利用権限、AI利用量の保存だけに使います。家計データは保存しません。GeminiとJevの認証情報はWorker secretに設定します。WorkerはCOOP/COEP headerを維持し、Service Workerは `/api/*` をcacheしません。

`apps/pwa/cloudflare.config.ts` は通常、`kakeimatch-issue-39-preview` Workerを選びます。previewは既存のsynthetic test用D1を使い、合成データだけで確認します。previewで家計データを開かないでください。本番設定はpreviewではないbuildで `production-deploy` modeを明示した場合だけ選択されます。本番用 `ACCOUNT_D1_ID` と `ACCOUNT_D1_NAME` の両方が必要です。これにより、指定なしでpreview D1を本番に使うことを防ぎます。指定するIDが本番用であることは運用時に確認してください。本番の `CLOUD_ACCOUNT_ORIGIN` は正規originに設定します。

Issue #39では本番route、D1、secretを準備・検証せず、本番deployもしません。preview deployは合成データによる回帰確認専用です。現在の `cf` CLIを使う前に `cf --help` と `cf cli search` を確認してください。古いWrangler手順からcommandを推測しないでください。専用previewには `pnpm deploy:preview` を使います。確認済みpreview URLは <https://kakeimatch-issue-39-kakeimatch-issue-39-preview.yhgry.workers.dev> です。rootの `deploy` scriptはproduction modeを選び、本番サービスへ変更を加える可能性があります。別途明示的な依頼がない限り実行しないでください。

preview上ではActualブラウザー版を使ったレシート、明細、照合、offline reloadと、backup/restore、原本整理、全消去を合成データで確認しました。Cloud auth secretsは設定していないため、認証要求は403で拒否されます。signed-outのlocal flowとmock AI応答を確認した結果であり、実Passkey認証や実provider要求の確認ではありません。iPhone実機でのIssue #39後の確認は未実施です。

本番ではaccount専用D1を `ACCOUNT_D1_ID` と `ACCOUNT_D1_NAME` で選びます。Worker secret bindingは `BETTER_AUTH_SECRET`、`ACCOUNT_BOOTSTRAP_SECRET`、`AI_GATEWAY_AUTH_SECRET`、`GEMINI_API_KEY`、`TYPESAFE_API_KEY` です。Workerは `AI_USER_RATE_LIMIT` も設定します。通常のtext設定は `AI_FREE_MONTHLY_LIMIT`、`CLOUD_ACCOUNT_ORIGIN`、`GEMINI_MODEL`、`JEV_MODEL`、`TYPESAFE_API_URL` です。provider keyと認証secretは秘密情報です。D1識別子とmodel/quotaの設定値はresource選択や動作設定であり、secretではありません。Issue #39では本番値の検証やbindingのprovisioningを行いません。

## ローカル開発と確認

リポジトリで固定したpackage managerを使い、rootから次を実行します。

```sh
corepack pnpm install
corepack pnpm --dir apps/pwa dev
corepack pnpm --dir apps/pwa typecheck
corepack pnpm --dir apps/pwa test
corepack pnpm --dir apps/pwa build
npm ci --prefix workers/ai-gateway
npm run --prefix workers/ai-gateway test
npm run --prefix workers/ai-gateway typecheck
npm run --prefix workers/ai-gateway build
```

AI Gateway Workerは独立した `package-lock.json` を持ち、pnpm workspace外にあります。`npm ci --prefix workers/ai-gateway` でその依存をinstallしてから上記commandを実行してください。`npm run --prefix workers/ai-gateway dev` はViteを直接起動し、PWAのCloudflare configを読みません。本番PWAと同一origin APIのlocal確認にはrootの `pnpm dev` またはbuild後の `pnpm start` を使います。Worker単体のlocal開発を行う場合は、必要なときだけ `.dev.vars.example` を `.dev.vars` へコピーし、合成値を設定します。実provider要求にはprovider keyが必要です。値はGitに入れず、deploy先ではCloudflare secretを使います。D1 schema変更は `workers/ai-gateway/migrations/` のversion付きSQLで管理します。

## legacy server環境からの移行

以前のNext.jsアプリ、server SQLite、ファイル保存、Actual CLI、Docker Composeはlegacy参照として残します。PWAを利用するための本番構成ではありません。legacy Composeファイルを本番導入手順として使わないでください。過去の設計は[legacy architecture](legacy/ARCHITECTURE.md)と[legacy implementation plan](legacy/IMPLEMENTATION_PLAN.md)に記録しています。

旧Actual ServerからexportしたZIPにはActual Budgetの家計簿データだけが含まれます。PWAのブラウザー版Actualへimportしてください。旧Next.jsにはKakeiMatch `.kmb` export機能がなく、旧receipt/statement metadataも自動移行されません。local-first PWAで作成した `.kmb` には、Actual BudgetとKakeiMatch端末記録、残っているreceipt/statement原本が含まれます。PWAは旧server SQLiteや旧receipt/statement directoryを直接読みません。新しい端末profileを確認するまで旧環境の検証済みbackupを保管してください。対応するexportに含まれないlegacy記録は個別に手動移行してください。詳細は[端末内データのバックアップと復元](LOCAL_BACKUP.md)を参照してください。Actual orphan cleanupの特殊制約はIssue #58で管理します。

2026-09-30の読み取り確認では、指定された本番origin `https://kakeimatch.workers.dev` をこの実行環境からDNS解決できませんでした。Issue #39専用previewはHTTPS 200で応答し、COOP/COEPを維持していました。本番originの指定は変更せず、公開前にDNSと配信経路、account専用D1、secretの設定を別途確認します。本番への書き込みは実施していません。
