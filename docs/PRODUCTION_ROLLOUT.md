# 本番公開の手順と確認記録

2026-09-30時点で、本番URL・専用D1・schema・公開前の検証は準備済みです。所有者による5個のsecret登録を待っています。公開deploymentはまだありません。

## 本番リソース

| 設定 | 確認した値 |
| --- | --- |
| canonical origin | `https://kakeimatch.yhgry.workers.dev` |
| Worker名 | `kakeimatch` |
| Worker ID | `0dbf0067732a4253b9477e0e61d4226d` |
| ACCOUNT_D1_NAME | `kakeimatch-prod-account` |
| ACCOUNT_D1_ID | `a8af09b1-86b0-4e09-8e89-0ad78e81e705` |
| 未公開の初期version | `c3ce18c5-0eb0-4ac4-a080-bfee3d90b9b4` |

開始時に `cf --help` と `cf cli search` を実行しました。引数なしのsearchはquery必須のエラーになったため、以後は匿名の操作説明をqueryとして使用しました。`cf workers list` の正式URLからaccount subdomainが `yhgry` と確認できました。Worker作成後にもCloudflareの返す `subdomain.url` がcanonical originと一致しました。URL形式は[Cloudflare公式 workers.dev資料](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)と照合しています。

IndexedDB、Service Worker、Passkeyはoriginに依存します。本番利用開始後にoriginやWorker名を安易に変更しないでください。previewは別originで合成データ専用です。previewのD1・secret・家計データを本番へ流用しません。

正本は [PWAのCloudflare設定](../apps/pwa/cloudflare.config.ts)です。D1には本人確認、session、Passkey、招待・回復、利用権限、AI利用量とflowの重複防止情報だけを保存します。端末の家計データは保存しません。

## D1とアプリの組み合わせ

最新main `ee3dfccd11afb25bbf7ed819c99ad057ba9aa383` を基点とする既存[PR #62](https://github.com/RyoyaYahagi/KakeiMatch/pull/62)で公開準備を管理します。初期未公開versionのアプリコードは同PRの `61314d46eb8497e044d01bf37a578e8c6eb9093b` です。以降の変更は静的検査対象の除外と公開手順書です。公開時は実際にdeployするcommitとCloudflare version IDを追記してください。

2026-09-30に本番専用D1を新規作成し、次のcommandで0001〜0003を順番に適用しました。

```sh
cf d1 migrations list a8af09b1-86b0-4e09-8e89-0ad78e81e705 --dir workers/ai-gateway/migrations
cf d1 migrations apply a8af09b1-86b0-4e09-8e89-0ad78e81e705 --dir workers/ai-gateway/migrations
cf d1 query a8af09b1-86b0-4e09-8e89-0ad78e81e705 --sql "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name; SELECT name FROM d1_migrations ORDER BY id; SELECT COUNT(*) AS flow_count FROM ai_receipt_flows;"
```

移行履歴は `0001_auth.sql`、`0002_entitlements_usage.sql`、`0003_receipt_ai_flows.sql` の3件です。再確認時の未適用migrationは0件でした。`user`、`session`、`account`、`verification`、`passkey`、`account_invite`、`account_entitlements`、`ai_usage`、`ai_receipt_flows` の9テーブルを確認しました。`ai_receipt_flows` は0件です。D1の内部管理テーブルも存在します。

0003はtable追加で、legacy `ai_usage` を削除しません。migration後にschemaを破壊的に戻さないでください。PWAとAPIは同じversionとして更新します。古いPWAがflow IDを送らない場合にAI要求を拒否する仕様を維持します。旧アプリへのrollbackは旧利用量計算へ戻るため、単に前versionを公開せず利用量の影響を確認してください。初回公開には過去の公開versionがありません。[実装と利用量仕様](../workers/ai-gateway/README.md)

## 設定と公開前検証

| binding / 設定 | 本番値 |
| --- | --- |
| ACCOUNT_DB | 上記の本番専用D1 |
| AI_USER_RATE_LIMIT | namespace `600039`、20要求 / 60秒 |
| AI_FREE_MONTHLY_LIMIT | `30` |
| CLOUD_ACCOUNT_ORIGIN | `https://kakeimatch.yhgry.workers.dev` |
| GEMINI_MODEL | `gemini-3.5-flash-lite` |
| JEV_MODEL | `jev-latest` |
| TYPESAFE_API_URL | `https://api.typesafe.ai/v1/systemone` |

secret bindingは下記の5個です。値は所有者だけが設定します。2026-09-30の `cf workers secrets list --worker kakeimatch` は空の一覧でした。

以下の検証を実行し、成功しました。

- root: lint、typecheck、test（285テスト）、build、eval:reconciliation（33ケース、失敗0件）
- PWA: typecheck、Service Workerテスト（2テスト）、build
- AI Worker: npm ci、test（39テスト）、typecheck、build
- ローカルブラウザー: 合成レシート・明細・照合・オフラインE2E、backup / restore / 原本整理 / 全消去E2E
- production modeのdeploy dry-run
- 最新mainの[CI](https://github.com/RyoyaYahagi/KakeiMatch/actions/runs/36712897309): 成功

最初のlintはGit管理外の `.worktrees` 内の過去コードと生成物を読み、失敗しました。静的検査設定で作業用コピーを除外して再実行すると成功しました。この端末の通常PATHに `pnpm` がなかったため、root scriptの内部呼び出し用に `/tmp` の一時ラッパーでCorepackを使用しました。AI WorkerのローカルD1テストは制限環境でtimeoutし、実行制限を外した環境では成功しました。バックアップE2Eはビルド中のサーバーでtimeoutしましたが、ビルド完了後にサーバーを再起動して単独実行すると成功しました。アプリの変更は不要でした。

lintにはlegacy画面の画像に関する警告2件が残っています。buildには既存のbundleサイズ、import、directive、workspace lockfileの警告があります。npm ciのauditは開発用依存に9件（moderate 6、高2、critical 1）を報告しました。criticalはVitestのUIサーバーに関する項目です。今回は `vitest run` を使い、UIサーバーは公開していません。依存更新とセキュリティ全般の対策は本作業に含めていません。

dry-runでは生成済みWorker設定も読み、名前 `kakeimatch`、本番D1のID / name、canonical origin、5個のsecret宣言、同一version内のPWA assetsとAPI Workerを確認しました。preview D1は含まれていません。

```sh
ACCOUNT_D1_ID=a8af09b1-86b0-4e09-8e89-0ad78e81e705 \
ACCOUNT_D1_NAME=kakeimatch-prod-account \
corepack pnpm --dir apps/pwa exec cf deploy --mode production-deploy --dry-run
```

## 公開を伴わない初回Worker準備

現行 `cf` 1.0.0-beta.5はWorker単体作成commandを持たず、`cf workers versions create` も未作成Workerでは初回deployを要求しました。そこで[公式Create Worker API](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/create/)を、インストール済みcfの認証クライアント経由で使用しました。`kakeimatch` を作成し、workers.devとversion previewを無効にしました。認証情報は出力していません。

初回versionには継承元secretがないため、通常のsecret宣言付きアップロードはAPI code 10057で拒否されました。Git管理外の生成済み `worker.config.json` からsecret宣言だけを一時的に除き、次のcommandでコードとassetsを登録しました。処理後に出力を元へ戻しました。正本のsource configは5個のsecret宣言を保持しています。

```sh
ACCOUNT_D1_ID=a8af09b1-86b0-4e09-8e89-0ad78e81e705 \
ACCOUNT_D1_NAME=kakeimatch-prod-account \
corepack pnpm --dir apps/pwa exec cf workers versions create \
  --mode production-deploy --prebuilt \
  --message 'Initial undeployed version; awaiting owner secrets'
```

これは公開deploymentではありません。Cloudflareの返す `deployed_on` はnullで、workers.devとversion previewは無効のままです。本番URLへのGETは404です。[versionとdeploymentの違いに関する公式資料](https://developers.cloudflare.com/workers/versions-and-deployments/)

## A. 所有者によるsecret登録

本人のターミナルで、リポジトリrootから次を実行します。[所有者用登録スクリプト](../scripts/register-production-secrets.py)が5個の秘密値を非表示で入力し、PWAとAPIのコードと一緒に未公開versionへ登録します。本番公開は行いません。Python 3と既存のCorepack / cfを使用します。

```sh
python3 scripts/register-production-secrets.py
```

入力する5個は `BETTER_AUTH_SECRET`、`ACCOUNT_BOOTSTRAP_SECRET`、`AI_GATEWAY_AUTH_SECRET`、`GEMINI_API_KEY`、`TYPESAFE_API_KEY` です。最初の3個は所有者のパスワード管理ツール等で個別に作成し、少なくとも32文字のランダム値を使います。後の2個は本人が取得したGemini / TypeSafeのAPI keyです。previewの値をコピーしないでください。`.env`、Git、PR本文、コマンド履歴へ保存しないでください。秘密値をチャットへ送らないでください。

スクリプトは対話ターミナル以外の実行と、getpassによる表示入力へのfallbackを拒否します。入力値はrepository外の権限700の一時ディレクトリに、権限600のJSONファイルとして保存します。CLIには値ではなくファイルパスだけを渡し、通常の完了・失敗・Ctrl+C時に一時ファイルを削除します。CLI出力に入力値が含まれた場合も、その値を伏せて表示します。production D1のnameとID、production-deploy modeをスクリプトが明示します。

2026-09-30に、以前の `cf workers secrets update` 手順は本人の最初の入力後にHTTP 500 / code 10013で失敗しました。再確認時もsecret名一覧とdeployment一覧は空で、最新versionにもsecret bindingはありませんでした。未公開Workerと通常secret更新APIの組み合わせが原因である可能性を考えていますが、Cloudflare内部の500原因は未確定です。秘密値を書き込む再現試験は、本人操作という境界を守るため行っていません。

代わりに、現行 `cf workers versions create --help` の `--secrets-file` と[公式のコード・secret同時アップロード仕様](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code)を確認しました。インストール済みcfがversion uploadへファイルを渡し、その処理がsecret_text bindingを明示的に設定することも確認しました。通常secret putは即時deployを伴うと公式資料にあるため、初回登録には使用しません。

所有者用スクリプトの3テストは、Cloudflare通信を置き換えた合成値だけで成功しました。一時ファイルの権限・削除、公開を伴わないcommand、本番D1選択、出力の値除去、非対話実行の拒否を検証しました。実CLIでも合成値と `--dry-run` だけを使用し、5個がhidden bindingとして構成されることを確認しました。実秘密値の入力・登録は本人操作待ちであり、成功はまだ確認していません。

登録後は「production secretを登録した」と、CLIの返すversion IDだけを報告してください。エージェントは値を聞かず、最新versionのsecret binding名を確認します。通常のsecret一覧は公開versionを参照する可能性があるため、未公開versionの登録確認に単独では使いません。

```sh
cf workers versions get latest --worker-id kakeimatch | python3 -c 'import json,sys; v=json.load(sys.stdin); print(v["id"]); print([b["name"] for b in v["bindings"] if b["type"] == "secret_text"])'
```

## 公開条件とエージェントによる続行

- [x] canonical originをCloudflare側で確認
- [x] sourceと現行文書のproduction originを統一
- [x] 本番専用D1を新規作成
- [x] 0001〜0003のmigrationを適用
- [x] 必須9テーブルとai_receipt_flowsを確認
- [x] production dry-runに成功
- [x] 最新mainのCIに成功
- [ ] 所有者による本番secret5個の登録を確認
- [ ] 最終sourceのPR CIと公開commitを確認（PRのmergeは依頼時のみ）
- [ ] 本番deploy
- [ ] 本番HTTP確認
- [ ] 本人によるPasskeyと実AI確認

secret登録後は、本番D1を再確認し、最終sourceのCI・公開commitを記録します。正本のconfigから再buildし、同じD1を明示してdeployします。最初のsecretなしversionをそのまま公開しないでください。

```sh
ACCOUNT_D1_ID=a8af09b1-86b0-4e09-8e89-0ad78e81e705 \
ACCOUNT_D1_NAME=kakeimatch-prod-account \
corepack pnpm --dir apps/pwa exec cf deploy --mode production-deploy
```

deploy後にCloudflareの返すWorker名、URL、version、D1を確認します。workers.devのroutingが有効になったことも確認します。PWAとAPIを別々に更新しません。

本番HTTP確認は `GET /` が200、`Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Embedder-Policy: require-corp` を確認します。認証情報を付けない `POST /api/account/invites`、`GET /api/ai/usage`、`POST /api/ai/token`、`POST /api/ai/gemini`、`POST /api/ai/jev` は401 / 403等で安全に拒否されることを確認します。POSTはcanonical originのOrigin headerとJSON body `{}` を使います。500、秘密値、provider本文を返した場合は公開完了としません。Service Workerの `/api/*` cache除外も維持します。

2026-09-30の公開前確認では、本番URLは404です。本番でのCOOP / COEPと未認証APIは未確認です。ローカルの本番ビルドはGET /が200で、COOP / COEPと `Cache-Control: no-store` を確認しました。Service WorkerのAPI除外テストも成功しています。

## B. 公開後の本人操作

本人が本番招待を発行します。以下はzsh用です。bootstrap secretと本人のメールアドレス・表示名を対話入力し、実値をコマンド履歴へ書きません。招待URLは本人にだけ渡し、Gitや公開ログへ保存しません。

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

本人が招待URLを開き、Passkey / Face IDを登録してログインします。家族への招待も同じoperator flowで発行できます。家族のメールアドレスをGitやfixtureへ保存しません。Familyを付与する場合は、本人の明示指示後に既存commandを使用します。

```sh
ACCOUNT_D1_ID=a8af09b1-86b0-4e09-8e89-0ad78e81e705 \
npm run --prefix workers/ai-gateway account:set-plan -- <opaque-user-id> family
```

実AI確認では、下記の合成レシートを画像として用意します。実家計データは使いません。

```text
テストマート
2026/09/30
牛乳 220円
パン 180円
合計 400円
```

Gemini解析だけで利用量が1回増えることを確認します。同じflowでJevカテゴリ提案を使っても利用量は増えません。本人が「再解析」するとさらに1回増えます。これは実provider確認であり、合成応答を使ったE2Eとは別の確認です。

iPhoneでは次の12項目を本人が確認します。

1. production URLをSafariで開く
2. Home Screenへ追加
3. Passkey login
4. 合成レシートをAI解析
5. Actualへ登録
6. usageが1回増える
7. Jevを使っても同じflowなら増えない
8. 明示的再解析で+1
9. アプリ終了・再起動
10. local data保持
11. 機内モードでlocal家計閲覧
12. .kmb backup作成

## 公開時に追記する記録

| 記録項目 | 現在の状態 |
| --- | --- |
| 公開commit / Cloudflare version | 未公開 |
| 本番secret名5個の確認 | 未登録 |
| GET /、COOP / COEP | 本番は404、header未確認 |
| 未認証account / AI API | 本番は未確認 |
| Passkey / Face ID | 本人確認待ち |
| Gemini / Jev実利用とusage | 本人確認待ち |
| iPhoneの端末内保存 / offline / backup | 本人確認待ち |

scope外のcloud backup、billing、app lock、migration framework拡張、セキュリティ全般、observability、AI global cost circuit breaker、Actual orphan cleanup、追加の明細providerは実装しません。
