# デプロイ

本番のKakeiMatchは `apps/pwa` のPWAとCloudflare Workerで構成します。利用者の端末に家計データを保存します。自宅Linux、Docker、Next.js server、Actual Sync Server、server-side household storageは必要ありません。

## 本番URLとデータ

アプリが前提とする本番の正規originは `https://kakeimatch.yhgry.workers.dev` です。ブラウザーの保存領域はoriginごとに分かれます。利用開始後にWorker名やoriginを変更すると、保存済みデータをアプリから参照できなくなる可能性があります。Worker名とoriginを安定して維持してください。本番の配信経路、専用D1、secret bindingは準備済みです。本番Worker名 `kakeimatch` とCloudflareアカウントのsubdomain `yhgry` に対応するURLを正規originとして使います。

同一WorkerがPWAと `/api/auth/*`、`/api/account/*`、`/api/ai/*` を配信します。WorkerのD1 bindingは、本人確認、session、Passkey、招待・回復、利用権限、AI利用量の保存だけに使います。家計データは保存しません。GeminiとJevの認証情報はWorker secretに設定します。WorkerはCOOP/COEP headerを維持し、Service Workerは `/api/*` をcacheしません。

`apps/pwa/cloudflare.config.ts` は通常、`kakeimatch-issue-39-preview` Workerを選びます。previewは既存のsynthetic test用D1を使い、合成データだけで確認します。previewで家計データを開かないでください。本番設定はpreviewではないbuildで `production-deploy` modeを明示した場合だけ選択されます。本番用 `ACCOUNT_D1_ID` と `ACCOUNT_D1_NAME` の両方が必要です。これにより、指定なしでpreview D1を本番に使うことを防ぎます。指定するIDが本番用であることは運用時に確認してください。本番の `CLOUD_ACCOUNT_ORIGIN` は正規originに設定します。

Issue #39では本番route、D1、secretを準備・検証せず、本番deployもしません。preview deployは合成データによる回帰確認専用です。現在の `cf` CLIを使う前に `cf --help` と `cf cli search` を確認してください。古いWrangler手順からcommandを推測しないでください。専用previewには `pnpm deploy:preview` を使います。確認済みpreview URLは <https://kakeimatch-issue-39-kakeimatch-issue-39-preview.yhgry.workers.dev> です。rootの `deploy` scriptはproduction modeを選び、本番サービスへ変更を加える可能性があります。別途明示的な依頼がない限り実行しないでください。

preview上ではActualブラウザー版を使ったレシート、明細、照合、offline reloadと、backup/restore、原本整理、全消去を合成データで確認しました。Cloud auth secretsは設定していないため、認証要求は403で拒否されます。signed-outのlocal flowとmock AI応答を確認した結果であり、実Passkey認証や実provider要求の確認ではありません。iPhone実機でのIssue #39後の追加確認は、利用者からホーム画面からの起動、保存済みデータの閲覧、オフライン起動、backup導線の4項目とも問題なしと報告されました。iOS/Safariのバージョンは未記録です。

本番ではaccount専用D1を `ACCOUNT_D1_ID` と `ACCOUNT_D1_NAME` で選びます。Worker secret bindingは `BETTER_AUTH_SECRET`、`ACCOUNT_BOOTSTRAP_SECRET`、`AI_GATEWAY_AUTH_SECRET`、`TURNSTILE_SECRET_KEY`、`GEMINI_API_KEY`、`TYPESAFE_API_KEY` です。Workerは `AI_USER_RATE_LIMIT` と、お問い合わせ用の `CONTACT_RATE_LIMIT` も設定します。通常のtext設定は `AI_FREE_MONTHLY_LIMIT`、`AI_GUEST_DAILY_LIMIT`、`TURNSTILE_SITE_KEY`、`CLOUD_ACCOUNT_ORIGIN`、`GEMINI_MODEL`、`JEV_MODEL`、`TYPESAFE_API_URL` です。provider keyと認証secretは秘密情報です。D1識別子とmodel/quotaの設定値はresource選択や動作設定であり、secretではありません。Issue #39では本番値の検証やbindingのprovisioningを行いません。

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

## ローカルでAIを試す

PWAと同一originのWorkerを動かすには、リポジトリrootで次を実行します。Node.js 22以上とCorepackが必要です。`pnpm start` はビルド済みの配信確認用なので、AIの開発には `pnpm dev` を使います。

```sh
corepack pnpm install
cp apps/pwa/.dev.vars.example apps/pwa/.dev.vars
```

既に `.dev.vars` がある場合はコピーで上書きせず、足りない設定だけ追加します。`.dev.vars` はGitの管理対象外です。`BETTER_AUTH_SECRET`、`ACCOUNT_BOOTSTRAP_SECRET`、`AI_GATEWAY_AUTH_SECRET` はそれぞれ `openssl rand -hex 32` で生成したローカル専用値へ置き換えます。本番の値をコピーしません。実際の読み取りには `GEMINI_API_KEY`、カテゴリ提案には `TYPESAFE_API_KEY` を自分のAPIキーへ置き換えます。API利用に費用が発生する場合があります。問い合わせを試さない場合は、`GITHUB_ISSUES_TOKEN` を雛形のままにします。

次に、開発サーバーと同じ保存先にあるローカルD1だけを更新します。IDは `cloudflare.config.ts` の開発用 `ACCOUNT_DB` と一致させます。`--local` と `--persist-to .wrangler/state` を省略しないでください。

```sh
corepack pnpm --dir apps/pwa exec cf d1 migrations apply 25111b8d-a7ec-4765-b53e-5b5d0ad6fd39 \
  --local --persist-to .wrangler/state --dir ../../workers/ai-gateway/migrations
corepack pnpm dev
```

ブラウザーで `http://localhost:5173` を開きます。`CLOUD_ACCOUNT_ORIGIN` もこの値に合わせます。Passkeyを試す場合はIPアドレスではなく `localhost` を使います。設定の「ログイン・利用状況」で登録なしのAI利用が表示され、合成レシートから「AIで読み取る」を選ぶと、bot確認後に読み取りへ進みます。例として「テストマート、牛乳220円、パン180円、合計400円」の画像を使います。実際のレシート画像は、読み取り時にGoogleへ送られます。登録なしの利用枠は日本時間の1日5回です。

開発用の公開鍵はconfigでテスト鍵を選び、秘密鍵は `.dev.vars.example` のテスト鍵を使います。これらは [Cloudflare公式のテスト鍵](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)です。本番では使いません。bot確認にはCloudflareへの通信が必要です。providerキーを合成値のままにした場合、実AIの成功は確認できません。`not_configured` やD1のtableエラーが出たら、`.dev.vars` の設定と、開発サーバーとmigrationの保存先が一致しているかを確認します。設定を変えたら開発サーバーを再起動します。

アカウント付きの経路を試す場合は、別のターミナルでローカルの `ACCOUNT_BOOTSTRAP_SECRET` を対話入力して招待を発行します。実在するメールアドレスや本番のsecretは使いません。

```sh
read -rs 'ACCOUNT_BOOTSTRAP_SECRET?ローカルbootstrap secret: '
echo
export ACCOUNT_BOOTSTRAP_SECRET
ACCOUNT_ADMIN_URL=http://localhost:5173 \
node workers/ai-gateway/scripts/account-invite.mjs invite developer@example.test 'Local Developer'
unset ACCOUNT_BOOTSTRAP_SECRET
```

この入力例はzsh用です。発行されたローカルの招待URLを同じブラウザーで開き、Passkeyを登録します。APIキー、`.dev.vars` の内容、招待URLをPRやチャットへ貼りません。

## legacy server環境からの移行

以前のNext.jsアプリ、server SQLite、ファイル保存、Actual CLI、Docker Composeはlegacy参照として残します。PWAを利用するための本番構成ではありません。legacy Composeファイルを本番導入手順として使わないでください。過去の設計は[legacy architecture](legacy/ARCHITECTURE.md)と[legacy implementation plan](legacy/IMPLEMENTATION_PLAN.md)に記録しています。

旧Actual ServerからexportしたZIPにはActual Budgetの家計簿データだけが含まれます。PWAのブラウザー版Actualへimportしてください。旧Next.jsにはKakeiMatch `.kmb` export機能がなく、旧receipt/statement metadataも自動移行されません。local-first PWAで作成した `.kmb` には、Actual BudgetとKakeiMatch端末記録、残っているreceipt/statement原本が含まれます。PWAは旧server SQLiteや旧receipt/statement directoryを直接読みません。新しい端末profileを確認するまで旧環境の検証済みbackupを保管してください。対応するexportに含まれないlegacy記録は個別に手動移行してください。詳細は[端末内データのバックアップと復元](LOCAL_BACKUP.md)を参照してください。Actual orphan cleanupの特殊制約はIssue #58で管理します。

## 本番更新の手順

本番D1のIDと名前は運用者が管理し、下記の環境変数へ設定します。preview D1を流用しません。公開日時、Worker・D1・version・deploymentの識別子、個別の検証結果は、Git管理対象外のローカル運用記録で管理します。

```sh
export ACCOUNT_D1_ID='<production-d1-id>'
export ACCOUNT_D1_NAME='<production-d1-name>'
```

実行時点のCLIを確認します。新しい操作は `cf cli search` で検索し、現行のhelpと公式資料を確認してから実行します。

```sh
corepack pnpm --dir apps/pwa exec cf --help
corepack pnpm --dir apps/pwa exec cf cli search 'Manage D1 migrations and deploy a Worker'
```

D1のmigration履歴を確認し、未適用分だけを適用します。`0001_auth.sql` から `0007_account_deletion.sql` まで、および `0014_guest_ai.sql`、`0015_uncounted_provider_errors.sql` が必要です。0015は、providerがエラーを返した読み取りを利用回数に数えないための列を追加します。0014はゲスト用の表と、利用記録の種類・暦日・アドレスHMACの列を追加します。既存の行は種類がレシートのまま扱われます。番号は、別ブランチにある未適用の0008〜0013と重ならないようにしています。`TURNSTILE_SITE_KEY` は公開値で、production modeのbuildでは環境変数として必須です。previewはCloudflareのテスト用の鍵を使います。0003はテーブル追加で、旧 `ai_usage` を削除しません。schemaを破壊的に戻さず、旧アプリへ戻す場合も利用量計算への影響を確認してください。

```sh
corepack pnpm --dir apps/pwa exec cf d1 migrations list "$ACCOUNT_D1_ID" --dir ../../workers/ai-gateway/migrations
corepack pnpm --dir apps/pwa exec cf d1 migrations apply "$ACCOUNT_D1_ID" --dir ../../workers/ai-gateway/migrations
```

secret値は本人だけがCloudflareへ登録します。値をGit、PR、チャット、コマンド引数へ書かず、CLIの非表示入力等を使います。必要なbinding名は「本番URLとデータ」に記載しています。初回登録と公開済みWorkerでの更新は挙動が異なるため、[公式secret手順](https://developers.cloudflare.com/workers/configuration/secrets/)と現行CLIを確認してください。previewの値をコピーしません。

検証とCIの成功、migration適用、secret bindingの存在を確認した後、production modeでdry-runします。Worker名 `kakeimatch`、本番D1、正規origin、PWAとAPIが同じversionに含まれることを確認してから公開します。

```sh
corepack pnpm --dir apps/pwa exec cf deploy --mode production-deploy --dry-run
corepack pnpm --dir apps/pwa exec cf deploy --mode production-deploy
```

公開後は本番の `GET /` が200、COOPが `same-origin`、COEPが `require-corp` であることを確認します。未認証のaccount / AI APIは401 / 403等で拒否し、500や秘密値、provider本文を返さないことを確認します。Service WorkerのAPIキャッシュ除外も維持します。認証済みの実AI確認は本人が行います。

## 本人による招待と実機確認

リポジトリrootのzshで次を実行すると、bootstrap secretとメールアドレス・表示名を対話入力して招待を発行できます。招待URLは本人だけが使用し、Gitや公開ログへ保存しません。

```sh
read -rs 'ACCOUNT_BOOTSTRAP_SECRET?本番bootstrap secret: '
echo
export ACCOUNT_BOOTSTRAP_SECRET
read -r 'account_email?招待先メールアドレス: '
read -r 'account_name?表示名: '
ACCOUNT_ADMIN_URL=https://kakeimatch.yhgry.workers.dev \
node workers/ai-gateway/scripts/account-invite.mjs invite "$account_email" "$account_name"
unset ACCOUNT_BOOTSTRAP_SECRET account_email account_name
```

本人が招待URLからPasskey / Face IDを登録してログインします。家族の招待にも同じ手順を使えます。Familyの付与には既存の `account:set-plan` を使い、本人の明示指示なしに実ユーザーのplanを変更しません。

実家計データを使わず、「テストマート、牛乳220円、パン180円、合計400円」の合成レシート画像で確認します。Gemini解析は利用量が1回増え、同じflowのJevカテゴリ提案では増えず、明示的な再解析ではさらに1回増えることを確認します。

iPhoneでは本人が次を確認します。

1. 本番URLをSafariで開き、ホーム画面へ追加してPasskeyでログインする。
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
