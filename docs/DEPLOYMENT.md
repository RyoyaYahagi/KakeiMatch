# デプロイ

本番のKakeiMatchは `apps/pwa` のPWAとCloudflare Workerで構成します。利用者の端末に家計データを保存します。自宅Linux、Docker、Next.js server、Actual Sync Server、server-side household storageは必要ありません。

## 本番URLとデータ

アプリが前提とする本番の正規originは `https://kakeimatch.yhgry.workers.dev` です。ブラウザーの保存領域はoriginごとに分かれます。利用開始後にWorker名やoriginを変更すると、保存済みデータをアプリから参照できなくなる可能性があります。Worker名とoriginを安定して維持してください。本番の配信経路、専用D1、secret bindingは準備済みです。本番Worker名 `kakeimatch` とCloudflareアカウントのsubdomain `yhgry` に対応するURLを正規originとして使います。

同一WorkerがPWAと `/api/auth/*`、`/api/account/*`、`/api/ai/*` を配信します。WorkerのD1 bindingは、本人確認、session、Passkey、登録ticket、Family招待・回復、利用権限、AI利用量の保存だけに使います。家計データは保存しません。GeminiとJevの認証情報はWorker secretに設定します。WorkerはCOOP/COEP headerを維持し、Service Workerは `/api/*` をcacheしません。

`apps/pwa/cloudflare.config.ts` は通常、`kakeimatch-issue-39-preview` Workerを選びます。previewは既存のsynthetic test用D1を使い、合成データだけで確認します。previewで家計データを開かないでください。本番設定はpreviewではないbuildで `production-deploy` modeを明示した場合だけ選択されます。本番用 `ACCOUNT_D1_ID` と `ACCOUNT_D1_NAME` の両方が必要です。これにより、指定なしでpreview D1を本番に使うことを防ぎます。指定するIDが本番用であることは運用時に確認してください。本番の `CLOUD_ACCOUNT_ORIGIN` は正規originに設定します。

Issue #39では本番route、D1、secretを準備・検証せず、本番deployもしません。preview deployは合成データによる回帰確認専用です。現在の `cf` CLIを使う前に `cf --help` と `cf cli search` を確認してください。古いWrangler手順からcommandを推測しないでください。専用previewには `pnpm deploy:preview` を使います。確認済みpreview URLは <https://kakeimatch-issue-39-kakeimatch-issue-39-preview.yhgry.workers.dev> です。rootの `deploy` scriptはproduction modeを選び、本番サービスへ変更を加える可能性があります。別途明示的な依頼がない限り実行しないでください。

preview上ではActualブラウザー版を使ったレシート、明細、照合、offline reloadと、backup/restore、原本整理、全消去を合成データで確認しました。Cloud auth secretsは設定していないため、認証要求は403で拒否されます。signed-outのlocal flowとmock AI応答を確認した結果であり、実Passkey認証や実provider要求の確認ではありません。iPhone実機でのIssue #39後の追加確認は、利用者からホーム画面からの起動、保存済みデータの閲覧、オフライン起動、backup導線の4項目とも問題なしと報告されました。iOS/Safariのバージョンは未記録です。

本番ではaccount専用D1を `ACCOUNT_D1_ID` と `ACCOUNT_D1_NAME` で選びます。Worker secret bindingは `BETTER_AUTH_SECRET`、`ACCOUNT_BOOTSTRAP_SECRET`、`AI_GATEWAY_AUTH_SECRET`、`TURNSTILE_SECRET_KEY`、`GEMINI_API_KEY`、`TYPESAFE_API_KEY` です。Workerは `AI_USER_RATE_LIMIT` と、登録・Family招待用の `ACCOUNT_RATE_LIMIT`（1分5回）も設定します。通常のtext設定は `AI_FREE_MONTHLY_LIMIT`、`CLOUD_ACCOUNT_ORIGIN`、`TURNSTILE_SITE_KEY`、`FAMILY_MAX_ACCOUNTS`、`GEMINI_MODEL`、`JEV_MODEL`、`TYPESAFE_API_URL` です。`TURNSTILE_SITE_KEY` は公開値で、production modeのbuildでは環境変数 `TURNSTILE_SITE_KEY` が必須です。previewはCloudflareの常に成功するテスト用site keyを使い、`TURNSTILE_SECRET_KEY` にもテスト用secretを設定します。provider keyと認証secretは秘密情報です。D1識別子とmodel/quotaの設定値はresource選択や動作設定であり、secretではありません。Issue #39では本番値の検証やbindingのprovisioningを行いません。

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

## 本番更新の手順

本番D1のIDと名前は運用者が管理し、下記の環境変数へ設定します。preview D1を流用しません。公開日時、Worker・D1・version・deploymentの識別子、個別の検証結果は、Git管理対象外のローカル運用記録で管理します。

```sh
export ACCOUNT_D1_ID='<production-d1-id>'
export ACCOUNT_D1_NAME='<production-d1-name>'
export TURNSTILE_SITE_KEY='<production-turnstile-site-key>'
```

Turnstileのwidgetは本番のhostname `kakeimatch.yhgry.workers.dev` だけを許可し、Managedモードで作成します。PWAは `action=signup` を指定し、Workerは成功・hostname・actionを検証します。[Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)を参照してください。

実行時点のCLIを確認します。新しい操作は `cf cli search` で検索し、現行のhelpと公式資料を確認してから実行します。

```sh
corepack pnpm --dir apps/pwa exec cf --help
corepack pnpm --dir apps/pwa exec cf cli search 'Manage D1 migrations and deploy a Worker'
```

D1のmigration履歴を確認し、未適用分だけを適用します。`0001_auth.sql` から `0008_open_signup_family_invites.sql` までが必要です。0008は登録ticketとFamily招待のテーブルを追加するだけで、既存のuser、Passkey、session、entitlementを変更しません。既存のFamily accountはそのまま維持されます。0003はテーブル追加で、旧 `ai_usage` を削除しません。schemaを破壊的に戻さず、旧アプリへ戻す場合も利用量計算への影響を確認してください。

```sh
corepack pnpm --dir apps/pwa exec cf d1 migrations list "$ACCOUNT_D1_ID" --dir ../../workers/ai-gateway/migrations
corepack pnpm --dir apps/pwa exec cf d1 migrations apply "$ACCOUNT_D1_ID" --dir ../../workers/ai-gateway/migrations
```

secret値は本人だけがCloudflareへ登録します。値をGit、PR、チャット、コマンド引数へ書かず、CLIの非表示入力等を使います。必要なsecret binding名は上記の6個です。初回登録と公開済みWorkerでの更新は挙動が異なるため、[公式secret手順](https://developers.cloudflare.com/workers/configuration/secrets/)と現行CLIを確認してください。previewの値をコピーしません。

検証とCIの成功、migration適用、secret bindingの存在を確認した後、production modeでdry-runします。Worker名 `kakeimatch`、本番D1、正規origin、PWAとAPIが同じversionに含まれることを確認してから公開します。

```sh
corepack pnpm --dir apps/pwa exec cf deploy --mode production-deploy --dry-run
corepack pnpm --dir apps/pwa exec cf deploy --mode production-deploy
```

公開後は本番の `GET /` が200、COOPが `same-origin`、COEPが `require-corp` であることを確認します。未認証のaccount / AI APIは401 / 403等で拒否し、500や秘密値、provider本文を返さないことを確認します。Service WorkerのAPIキャッシュ除外も維持します。認証済みの実AI確認は本人が行います。

## 一般登録・Family招待と実機確認

一般の利用者は招待なしで「新規登録」からaccountを作成し、freeで始めます。管理者の操作は不要です。

家族だけにFamily招待を発行します。リポジトリrootのzshで次を実行すると、bootstrap secretと対象メールアドレスを対話入力してFamily招待URLを発行できます。対象メールを空にすると、どのaccountでも1回だけ使える招待になります。招待URLは本人だけへ直接渡し、Gitや公開ログへ保存しません。

```sh
read -rs 'ACCOUNT_BOOTSTRAP_SECRET?本番bootstrap secret: '
echo
export ACCOUNT_BOOTSTRAP_SECRET
read -r 'family_email?Family招待の対象メールアドレス（省略可）: '
ACCOUNT_ADMIN_URL=https://kakeimatch.yhgry.workers.dev \
node workers/ai-gateway/scripts/account-admin.mjs family-invite ${family_email:+"$family_email"}
unset ACCOUNT_BOOTSTRAP_SECRET family_email
```

家族は招待URLを開き、未登録なら「新規登録」、登録済みなら「Passkeyで続ける」でログインしてから「家族プランを受け取る」を押します。招待は7日間・1回限りで、Familyは `FAMILY_MAX_ACCOUNTS`（既定5）までです。`account:set-plan` は例外的な変更や降格のために残します。本人の明示指示なしに実ユーザーのplanを変更しません。Passkeyを失った人の復旧は `account-admin.mjs recover <email>` で行います。

一般登録を外部へ案内する前に、[アカウント削除](CLOUD_ACCOUNT.md)の導線が本番で動作することを確認します。

実家計データを使わず、「テストマート、牛乳220円、パン180円、合計400円」の合成レシート画像で確認します。Gemini解析は利用量が1回増え、同じflowのJevカテゴリ提案では増えず、明示的な再解析ではさらに1回増えることを確認します。

iPhoneでは本人が次を確認します。

1. 本番URLをSafariで開き、ホーム画面へ追加して「新規登録」（Turnstile確認とPasskey作成）またはPasskeyでログインする。
2. 合成レシートをAI解析し、Actualへ登録する。
3. 初回解析で利用量が1回増え、同じflowのJevでは増えず、再解析ではさらに1回増える。
4. アプリを終了・再起動し、端末内データが保持される。
5. 機内モードで端末内の家計データを閲覧できる。
6. `.kmb`バックアップを作成できる。

## APIコスト計測の更新（Issue #117）

Workerの更新前に `0004_ai_provider_costs.sql` を適用します。追加するテーブルは、利用者・フローの識別子、モデル、トークン数、送信時点の単価、推定料金、時刻、安全な状態コードだけを保存します。画像・店名・購入金額・商品・回答・要求本文は保存しません。過去の要求は補完しません。[実装: ai-provider-costs.ts](../workers/ai-gateway/src/ai-provider-costs.ts)

料金設定はWorkerの `PRICING_CATALOG` で管理します。モデルID、価格の適用開始・終了日時、料金方式、入力・出力単価を一緒に更新してください。既存の版を上書きせず、新しい版を追加します。既存イベントの料金は更新しません。未知のモデルや未対応の料金方式はコスト不明になります。USDの100万分の1を整数で保存し、要求ごとの端数は切り上げます。[実装: ai-provider-costs.ts](../workers/ai-gateway/src/ai-provider-costs.ts)

2026年10月2日に確認したStandardの料金はGemini 3.5 Flash-Liteの入力100万トークンあたり0.30 USD、思考を含む出力100万トークンあたり2.50 USDです。Jev 1.13.0は入力100万トークンあたり0.042 USDで、出力は無料です。カタログはこの料金の推定値を使います。無料枠、請求書、為替換算との照合は行いません。[Google料金 (2026/10), Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/pricing)、[TypeSafe料金 (2026/10), Jev 1.13](https://docs.typesafe.ai/models)

合成要求で、再試行ごとのコスト記録、製品利用回数が増えないこと、`GET /api/ai/costs` の利用者分離、コスト不明の件数を確認します。画面では開発者向け設定を有効にしてから当月・前月の表示を確認します。設定を無効にしても計測は続きます。更新を戻す場合は追加テーブルを残してください。旧Workerを動かした期間は計測されないため、その期間の集計は不完全になります。[実装: worker.ts](../workers/ai-gateway/src/worker.ts)、[実装: PWA](../apps/pwa/src/main.ts)

## サービス全体のAI費用制限（Issue #56）

`0005_ai_global_guardrails.sql` をWorker更新前に適用します。`AI_GUARDRAILS_JSON` と `AI_EMERGENCY_STOP` はWorker側のbindingで管理します。未設定でも初期値による制限が有効です。Familyにも適用します。並行要求の費用予約、日・月・直前60秒の要求上限、障害による停止、調査・再開の手順は[AI費用の停止と再開](AI_COST_GUARDRAILS.md)を参照してください。PWAの開発者設定をOFFにしても制限は動作します。

## お問い合わせの導入

Worker更新前に `0006_contact_submissions.sql` を適用し、`GITHUB_ISSUES_TOKEN` をSecret bindingへ登録します。対象リポジトリへのIssues書き込み権限が必要です。`GITHUB_ISSUES_REPOSITORY` はサーバー設定で固定します。秘密値の登録は既存の本人による手順に従います。実際の投稿・文字起こし・iPhone録音は合成内容で確認してください。詳細は[お問い合わせ](CONTACT.md)を参照してください。
