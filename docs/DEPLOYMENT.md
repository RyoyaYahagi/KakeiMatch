# デプロイ

本番のCloudflare Workerは `workers/ai-gateway` から配信します。家計データは利用者の端末に保存します。自宅Linux、Docker、Next.js server、Actual Sync Server、server-side household storageは必要ありません。

## 本番URLとデータ

本番 Worker `kakeimatch` の正規 origin は `https://kakeimatch.yhgry.workers.dev` です。ネイティブ認証の RP ID と Associated Domains に関わるため、この origin を維持します。

`workers/ai-gateway` の Worker が管理画面とネイティブ API を配信します。D1 は認証、利用権限、AI 利用量、問い合わせの運用に使います。家計データは iOS 端末内に保存し、Gemini の認証情報は Worker の Secret binding に設定します。

`workers/ai-gateway/cloudflare.config.ts` は通常、`kakeimatch-issue-39-preview` Workerを選びます。previewは既存のsynthetic test用D1を使い、合成データだけで確認します。previewで家計データを開かないでください。本番設定はpreviewではないbuildで `production-deploy` modeを明示した場合だけ選択されます。本番用 `ACCOUNT_D1_ID` と `ACCOUNT_D1_NAME` の両方が必要です。これにより、指定なしでpreview D1を本番に使うことを防ぎます。指定するIDが本番用であることは運用時に確認してください。本番の `CLOUD_ACCOUNT_ORIGIN` は正規originに設定します。

Issue #39では本番route、D1、secretを準備・検証せず、本番deployもしません。preview deployは合成データによる回帰確認専用です。現在の `cf` CLIを使う前に `cf --help` と `cf cli search` を確認してください。古いWrangler手順からcommandを推測しないでください。専用previewには `pnpm deploy:preview` を使います。確認済みpreview URLは <https://kakeimatch-issue-39-kakeimatch-issue-39-preview.yhgry.workers.dev> です。rootの `deploy` scriptはproduction modeを選び、本番サービスへ変更を加える可能性があります。別途明示的な依頼がない限り実行しないでください。

旧 PWA の Issue #39 では、プレビュー上で Actual ブラウザー版を使ったレシート、明細、照合、offline reloadと、backup/restore、原本整理、全消去を合成データで確認しました。Cloud auth secretsは設定していないため、認証要求は403で拒否されます。signed-outのlocal flowとmock AI応答を確認した結果であり、実認証（当時のPasskey。S6で撤去）や実provider要求の確認ではありません。iPhone実機でのIssue #39後の追加確認は、利用者からホーム画面からの起動、保存済みデータの閲覧、オフライン起動、backup導線の4項目とも問題なしと報告されました。iOS/Safariのバージョンは未記録です。

本番ではaccount専用D1を `ACCOUNT_D1_ID` と `ACCOUNT_D1_NAME` で選びます。Worker の secret binding は `AI_GATEWAY_AUTH_SECRET`、`GEMINI_API_KEY`、`GITHUB_ISSUES_TOKEN`、`FEEDBACK_ENCRYPTION_KEY`、`ADMIN_ACCESS_EMAILS`、`CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`、`AI_EMERGENCY_STOP`、`AI_GUARDRAILS_JSON` です。Workerは `AI_USER_RATE_LIMIT` と、管理画面のAI分析用の `CONTACT_RATE_LIMIT` も設定します。通常のtext設定は `AI_GUEST_DAILY_LIMIT`、`CLOUD_ACCOUNT_ORIGIN`、`GEMINI_MODEL`、`GITHUB_ISSUES_REPOSITORY`、ネイティブの `NATIVE_APP_*` です。`GEMINI_MODEL` はInteractions APIを使うレシート読み取りなどのモデル名です。カテゴリ分類はレシート読み取りと同じ `GEMINI_API_KEY` を使い、モデルはWorkerのコードで `gemini-decision-1` に固定されます。追加のprovider keyや環境変数は必要ありません。`BETTER_AUTH_SECRET`、`ACCOUNT_BOOTSTRAP_SECRET`、`TURNSTILE_*`、`ADMIN_USER_IDS` は Worker の設定から参照しません（S7で参照を外した。Cloudflare 上の実体の削除はS8の作業です）。`AI_PRO_MONTHLY_LIMIT` は Worker の設定ではなく、`account:set-plan` の実行時に読む運用の入力です（`free` は月間上限を読まないため不要）。Issue #39では本番値の検証やbindingのprovisioningを行いません。

カテゴリ分類はGemini Decisions API（`POST https://generativelanguage.googleapis.com/v1beta/decisions`）へ、コードで固定したモデル `gemini-decision-1` を指定して送ります。`workers/ai-gateway/cloudflare.config.ts` の `GEMINI_MODEL`（既定 `gemini-3.5-flash-lite`）は、レシート読み取りなどGemini Interactions APIを使う機能のモデルで、分類には効きません。本番Workerの既存 `GEMINI_API_KEY` が両方の機能で共有されるため、この変更に伴う新しいsecret登録はありません。Cloudflareの `kakeimatch` Workerで読み取り用Gemini keyが既に設定されていることを確認してください。分類のAPI要求が失敗した場合は他providerへ再送せず、分類を停止します。

分類のGemini要求が失敗した場合は、既存のcircuit・metering制御に従って失敗を記録し、分類を停止します。Gemini circuitが開いている間はレシート読み取りと分類の両方を停止します。OpenCodeまたはOpenRouterへのfallbackはありません。旧 `0017_jev_upstream_circuits.sql` は過去のJev circuit記録を維持する履歴migrationであり、新Workerはその記録を参照しません。既存のJev/OpenCode/OpenRouter secretはこのWorkerの現在の設定と送信経路では使いません。運用者は他の対象で未使用と確認してからCloudflare secretを削除できます。Secretを操作する場合は現行 `cf cli search` と対象commandのhelpを確認し、値をsourceやコマンド引数へ書かないでください。

## ローカル開発と確認

リポジトリで固定したpackage managerを使い、rootから次を実行します。

```sh
corepack pnpm install
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
npm ci --prefix workers/ai-gateway
npm run --prefix workers/ai-gateway test
npm run --prefix workers/ai-gateway typecheck
npm run --prefix workers/ai-gateway build
```

AI Gateway Workerは独立した `package-lock.json` を持ち、pnpm workspace外にあります。Workerの開発サーバーは `npm run --prefix workers/ai-gateway dev` で起動します。D1 schema変更は `workers/ai-gateway/migrations/` に記録します。

## ローカルでAIを試す

Workerの設定とD1は `workers/ai-gateway` を起点に操作します。Node.js 22以上が必要です。リポジトリrootから次を実行します。

```sh
corepack pnpm install --frozen-lockfile
cd workers/ai-gateway
npm ci
cp .dev.vars.example .dev.vars
```

既に `.dev.vars` がある場合はコピーで上書きせず、足りない設定だけ追加します。`.dev.vars` はGitの管理対象外です。`AI_GATEWAY_AUTH_SECRET` は `openssl rand -hex 32` で生成したローカル専用値へ置き換えます。本番の値をコピーしません。Geminiを実際に呼び出す場合は、レシート読み取りとカテゴリ分類で共通の `GEMINI_API_KEY` を設定します。API利用に費用が発生する場合があります。問い合わせを試さない場合は、`GITHUB_ISSUES_TOKEN` を雛形のままにします。

次に、開発サーバーと同じ保存先にあるローカルD1だけを更新します。IDは `cloudflare.config.ts` の開発用 `ACCOUNT_DB` と一致させます。`--local` と `--persist-to .wrangler/state` を省略しないでください。

```sh
npm exec -- cf d1 migrations apply 25111b8d-a7ec-4765-b53e-5b5d0ad6fd39 \
  --local --persist-to .wrangler/state --dir migrations
npm run dev
```

開発サーバーは管理画面とネイティブAPIの窓口です。ネイティブ認証を試す場合は、合成データを使い、preview用のネイティブ識別子とoriginを設定します。D1のtableエラーが出たら、開発サーバーとmigrationの保存先を確認します。

## legacy server環境からの移行

以前のNext.jsアプリ、server SQLite、ファイル保存、Actual CLI、Docker Composeはlegacy参照として残します。現在の本番構成ではありません。legacy Composeファイルを本番導入手順として使わないでください。過去の設計は[legacy architecture](legacy/ARCHITECTURE.md)と[legacy implementation plan](legacy/IMPLEMENTATION_PLAN.md)に記録しています。

旧 PWA から書き出した `.kmb` は iOS アプリに取り込めます。旧 Next.js の Actual ZIP に含まれるのは Actual Budget の取引です。新しい端末で移行結果を確認するまで、旧環境のバックアップを保管してください。

## Cloudflare Workers Buildsによる本番更新

通常の本番更新は、PRのGitHub Actions検証job `ci` が成功し、人間がmainへSquash mergeした後にCloudflare Workers Buildsが行います。GitHubのmain rulesetは、最新mainとの整合を満たしたPRの `ci` 成功を必須にします。mainへの直接pushとAIによるmainへのマージは禁止です。GitHub ActionsはPRの検証を担当し、本番公開は行いません。マージ後のCI成功を待つ構成ではありません。

既存Worker `kakeimatch` のSettings > Buildsから `RyoyaYahagi/KakeiMatch` を連携し、次の設定を使います。リポジトリ連携の手順は[Cloudflare公式「Workers Builds」](https://developers.cloudflare.com/workers/ci-cd/builds/)、各項目は[公式の設定資料](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)を参照してください。連携設定はCloudflare側で管理します。S3 を main にマージした後、`cf builds triggers update` で下表の設定に切り替えました。

| 項目 | 設定 |
| --- | --- |
| Production branch | `main` |
| Root directory | リポジトリroot |
| Build command | `pnpm install --frozen-lockfile && npm ci --prefix workers/ai-gateway && cd workers/ai-gateway && npm exec -- cf deploy --mode production-deploy --dry-run` |
| Deploy command | `cd workers/ai-gateway && npm exec -- cf deploy --prebuilt --mode production-deploy` |
| 非本番branchの自動build・preview | 無効（PR検証はGitHub Actionsで行う） |

Node.js 22.18以上と、リポジトリで固定したpnpm 10.15.0を使います。本番modeでbuildを検証し、その成果物をprebuiltで公開します。`cf` は `workers/ai-gateway/package.json` に固定した版を使います。通常modeではpreview Workerを選ぶため、`production-deploy` を省略しません。

Cloudflare側のBuild variablesに、次の値を登録します。build用の環境変数とWorkerの実行時bindingは別設定です。[Cloudflare公式「Configuration」](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

| 名前 | 用途 |
| --- | --- |
| `ACCOUNT_D1_ID` | 既存の本番account専用D1のID |
| `ACCOUNT_D1_NAME` | 同じ本番D1の名前 |

GitHubへのデプロイ用Secret登録は不要です。公開用のAPI tokenはWorkers Builds側で設定します。Gemini等のprovider keyやアプリの認証secretは、引き続き本番WorkerのSecret bindingで管理し、build用に複製しません。[Cloudflare公式「Configuration」](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

D1 migrationやSecretの新規登録は自動実行しません。schemaやbindingを変更するPRでは、人間が必要な準備を終えてからマージします。

公開に失敗した場合は、Cloudflare側のBuild historyでログを確認し、設定不足や権限を修正して対象buildを再実行します。古いcommitの再実行は、その版への差し戻しになります。再実行前に対象commitと現在のmain・公開版を確認してください。

### 非本番ブランチのビルドトリガーを確認する

Cloudflare側のプレビュー設定だけでなく、Workerに紐づくビルドトリガーも確認します。既存の連携には旧プレビューモデルが残る場合があります。[Cloudflare公式「Build branches」](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)

2026年10月12日のPR #267では、`previews_enabled: false`でも、`Deploy non-production branches`という別トリガーが`branch_includes: ["*"]`、`branch_excludes: ["main"]`で残っていました。アプリのbuildは成功し、その後のpreview公開がBuild Outputの`triggers`非対応で失敗していました。非本番の自動buildを無効にする運用に合わせ、このトリガーだけを削除しました。

確認には次のコマンドを使います。Worker名で検索した`id`を`build_worker_tag`へ設定します。

```sh
cf workers scripts search --name kakeimatch
cf builds triggers list --external-script-id "$build_worker_tag"
```

非本番専用トリガーが残っている場合は、一覧の設定とbuild用環境変数をGit管理対象外の運用記録へ保存します。対象の`trigger_uuid`を`nonproduction_trigger_uuid`へ設定し、main専用トリガーと異なることを確認してから削除します。トリガーの削除は、そのトリガーで実行中のbuildも停止します。[Cloudflare公式「Delete a build trigger」](https://developers.cloudflare.com/api/resources/workers_builds/subresources/triggers/methods/delete/)

```sh
cf builds triggers environment-variables list --trigger-uuid "$nonproduction_trigger_uuid"
cf builds triggers delete "$nonproduction_trigger_uuid" --dry-run
cf builds triggers delete "$nonproduction_trigger_uuid"
cf builds triggers list --external-script-id "$build_worker_tag"
```

読み戻しでmain専用トリガーだけが残り、ブランチ条件・build/deployコマンドが維持されていることを確認します。続いてPRブランチへのpushで不要なCloudflare buildが起動しないことを確認します。既存の失敗チェックは過去のcommitの記録として残します。

## iOS ネイティブ認証の公開前準備（Issue #240）

Workerを更新する前に `0018_native_app_auth.sql` を適用してください。新しい定期清掃もこの表を参照するため、ネイティブ機能を無効にして公開する場合も必要です。本PRの担当エージェントは本番migration・deploy・秘密値の登録を行いません。Worker の配信に影響するため、利用者が準備とCI結果を確認してからマージします。

`NATIVE_APP_TEAM_ID`、`NATIVE_APP_ID`、`NATIVE_APP_ORIGIN`、`NATIVE_APP_RP_ID`、`NATIVE_APP_ATTEST_ENVIRONMENT` は明示的なbuild変数からWorkerのtext bindingへ渡します。未設定ならnative APIは無効、AASAは404です。Team IDやApp ID prefixを推測しません。preview buildは `PREVIEW_NATIVE_APP_*` だけを読み、本番の値を継承しません。新しいprovider秘密鍵は不要です。

署名Team、App Attest / Associated Domains capability、AASAの直接200応答、環境分離と実機の確認手順は[ネイティブ認証境界](NATIVE_APP_AUTH.md#8-利用者による準備実機確認)を参照してください。管理画面の認証、利用枠、費用停止は引き続き有効です。

## 手動の本番更新・復旧手順

以下は人間による初回準備と復旧用です。通常の更新は上記Workers Buildsを使います。

本番D1のIDと名前は運用者が管理し、下記の環境変数へ設定します。preview D1を流用しません。公開日時、Worker・D1・version・deploymentの識別子、個別の検証結果は、Git管理対象外のローカル運用記録で管理します。

```sh
export ACCOUNT_D1_ID='<production-d1-id>'
export ACCOUNT_D1_NAME='<production-d1-name>'
```

リポジトリrootから `cd workers/ai-gateway` で移動し、実行時点のCLIを確認します。新しい操作は `cf cli search` で検索し、現行のhelpと公式資料を確認してから実行します。

```sh
npm exec -- cf --help
npm exec -- cf cli search 'Manage D1 migrations and deploy a Worker'
```

D1のmigration履歴を確認し、未適用分だけを適用します。`0001_auth.sql` から `0007_account_deletion.sql` まで、および `0014_guest_ai.sql`、`0015_uncounted_provider_errors.sql`、`0016_category_suggestion_flows.sql`、`0017_jev_upstream_circuits.sql`、`0018_native_app_auth.sql`、`0019_admin_operator_principal.sql` が必要です。`0016_feedback_inbox.sql` も適用してください。0017は当時のJev provider停止状態のキーを分割した履歴migrationです。過去のJev circuit行は残りますが、現行WorkerのGemini分類は利用しません。0016は、MoneyForwardの未対応カテゴリ提案に使う入力HMACと利用回数の予約を保存する表を追加します。カテゴリ名や家計取引はD1へ保存しません。0015は、providerがエラーを返した読み取りを利用回数に数えないための列を追加します。0014はゲスト用の表と、利用記録の種類・暦日・アドレスHMACの列を追加します。既存の行は種類がレシートのまま扱われます。番号は、別ブランチにある未適用の0008〜0013と重ならないようにしています。`TURNSTILE_SITE_KEY` は公開値で、production modeのbuildでは環境変数として必須です。previewはCloudflareのテスト用の鍵を使います。0003はテーブル追加で、旧 `ai_usage` を削除しません。schemaを破壊的に戻さず、旧アプリへ戻す場合も利用量計算への影響を確認してください。

```sh
npm exec -- cf d1 migrations list "$ACCOUNT_D1_ID" --dir migrations
npm exec -- cf d1 migrations apply "$ACCOUNT_D1_ID" --dir migrations
```

secret値は本人だけがCloudflareへ登録します。値をGit、PR、チャット、コマンド引数へ書かず、CLIの非表示入力等を使います。必要なbinding名は「本番URLとデータ」に記載しています。初回登録と公開済みWorkerでの更新は挙動が異なるため、[公式secret手順](https://developers.cloudflare.com/workers/configuration/secrets/)と現行CLIを確認してください。previewの値をコピーしません。

`cf workers secrets update <name> --type secret_text` は `--text` を省略すると空の値で更新します。`--text` に値を渡すと実行中のプロセス一覧から値が見えるため、値は0600の一時ファイルへ書き、`--body @<file>` で渡します。`--body` のJSONには `name` も必要です。`--dry-run` は送信内容をそのまま表示するため、実値では使わないでください。

検証とCIの成功、migration適用、secret bindingの存在を確認した後、production modeでdry-runします。Worker名 `kakeimatch`、本番D1、正規origin、管理画面アセットとAPIが同じ成果物に含まれることを確認してから公開します。

```sh
npm exec -- cf deploy --mode production-deploy --dry-run
npm exec -- cf deploy --mode production-deploy
```

公開後は `GET /` が410、未認証の管理画面が拒否されること、`/.well-known/apple-app-site-association` がネイティブ認証の設定に従って応答することを確認します。認証済みの実AI確認は本人が行います。

## 本人による実機確認

本人の招待は S6・S7 で撤去しました（`scripts/account-invite.mjs` と `/api/account/*` は削除、410）。新しい利用者の追加はありません。Plus（内部ID `family`）の付与には既存の `account:set-plan` を使い、本人の明示指示なしに実ユーザーのplanを変更しません。

実家計データを使わず、「テストマート、牛乳220円、パン180円、合計400円」の合成レシート画像で確認します。Gemini解析と同じflowのカテゴリ分類は合わせて利用量1回となり、明示的な再解析ではさらに1回増えることを確認します。

iPhoneでは本人が次を確認します。

1. iOS アプリを開き、レシートの読み取りでゲストの確認（App Attest）を通す。
2. 合成レシートを AI で読み取り、端末の家計簿へ登録する。
3. 初回解析と同じflowのカテゴリ分類で利用量が1回だけ増え、再解析ではさらに1回増える。
4. アプリを終了・再起動し、端末内データが保持される。
5. 機内モードで端末内の家計データを閲覧できる。
6. `.kmib` バックアップを作成できる。

## APIコスト計測の更新（Issue #117）

Workerの更新前に `0004_ai_provider_costs.sql` を適用します。追加するテーブルは、利用者・フローの識別子、モデル、トークン数、送信時点の単価、推定料金、時刻、安全な状態コードだけを保存します。画像・店名・購入金額・商品・回答・要求本文は保存しません。過去の要求は補完しません。[実装: ai-provider-costs.ts](../workers/ai-gateway/src/ai-provider-costs.ts)

料金設定はWorkerの `PRICING_CATALOG` で管理します。モデルID、価格の適用開始・終了日時、料金方式、入力・出力単価を一緒に更新してください。既存の版を上書きせず、新しい版を追加します。既存イベントの料金は更新しません。未知のモデルや未対応の料金方式はコスト不明になります。USDの100万分の1を整数で保存し、要求ごとの端数は切り上げます。[実装: ai-provider-costs.ts](../workers/ai-gateway/src/ai-provider-costs.ts)

2026年10月2日に確認したStandardの料金はGemini 3.5 Flash-Liteの入力100万トークンあたり0.30 USD、思考を含む出力100万トークンあたり2.50 USDです。Jev 1.13.0は入力100万トークンあたり0.042 USDで、出力は無料です。現行のカテゴリ分類に使う `gemini-decision-1` は、カタログに入力100万トークンあたり0.10 USD、出力0 USDの版（`2026-11-25-gemini-decisions`）を登録しています。この値はコードの登録内容で、Googleの料金ページとの照合は今回行っていません。カタログはこの料金の推定値を使います。無料枠、請求書、為替換算との照合は行いません。[Google料金 (2026/10), Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/pricing)、[TypeSafe料金 (2026/10), Jev 1.13](https://docs.typesafe.ai/models)

合成要求で再試行ごとのコスト記録、製品利用回数、利用者の分離、コスト不明の件数を確認します。管理画面の「AI 利用」タブで月ごとの集計を確認できます。[実装](../workers/ai-gateway/src/worker.ts)

## サービス全体のAI費用制限（Issue #56）

`0005_ai_global_guardrails.sql` をWorker更新前に適用します。`AI_GUARDRAILS_JSON` と `AI_EMERGENCY_STOP` はWorker側のbindingで管理します。未設定でも初期値による制限が有効です。Plusにも適用します。並行要求の費用予約、日・月・直前60秒の要求上限、障害による停止、調査・再開の手順は[AI費用の停止と再開](AI_COST_GUARDRAILS.md)を参照してください。

## お問い合わせと管理画面の導入

Worker更新前に `0019_admin_operator_principal.sql` までのmigrationを適用します。`FEEDBACK_ENCRYPTION_KEY` と `ADMIN_ACCESS_EMAILS`（Cloudflare AccessのJWTで許可するメールアドレスのカンマ区切り一覧）をSecret bindingへ登録します。本番では管理経路をCloudflare Accessで保護し、Worker側に `CF_ACCESS_TEAM_DOMAIN` と `CF_ACCESS_AUD` を設定します。問い合わせ原文の暗号鍵は独立した32バイトのランダム値をBase64で表します。鍵不足の場合は平文保存へ切り替えず、送信を拒否します。

`GITHUB_ISSUES_TOKEN` は管理者による明示的なIssue作成にだけ使います。対象リポジトリへのIssues書き込み権限に限定し、`GITHUB_ISSUES_REPOSITORY` はサーバー設定で固定します。通常の問い合わせ送信はGitHubへ投稿しません。毎日03:00（日本時間）のscheduled handlerは90日の保存期限を過ぎた問い合わせ本文と原文を削除します。詳しくは[管理画面](ADMIN.md)と[お問い合わせ](CONTACT.md)を参照してください。
