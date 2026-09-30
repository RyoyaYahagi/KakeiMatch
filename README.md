# KakeiMatch

家族向けのシンプルな家計簿・レシート照合Webアプリです。

レシートを撮影して支出を記録し、後からクレジットカード・決済サービスの明細と照合します。
一致した取引は自動で処理し、確認が必要な取引だけをユーザーに見せることで、家計簿入力と明細確認の手間を減らすことを目指します。

レシート解析では、保存した画像をGoogleのGemini APIへ送信します。カテゴリ提案ではGeminiが検証した店名・合計金額・商品明細の必要な範囲をTypeSafe Jev APIへ送信します。Jevへ画像、ユーザー情報、家計履歴、Actual Budget情報は送信しません。各APIキーとモデル設定はサーバー側の環境変数で管理します。

## コンセプト

Issue #30以降のPWAでは、家計簿データを利用者の端末に置きます。Cloud accountはAI利用量・プランなどのクラウド機能にだけ使います。ログインやCloudflareへの接続に失敗しても、実装済みの端末内機能は引き続き利用できます。レシート、明細、照合のPWA画面への接続はIssue #35で行います。Cloud accountの範囲とPasskeyの流れは[Cloud account](docs/CLOUD_ACCOUNT.md)を参照してください。

- 親を含む家族がスマートフォンから迷わず使えることを最優先する
- 家計簿の基盤にはセルフホストした Actual Budget を利用する
- 親向けUIは KakeiMatch 側で提供し、Actual Budget の複雑さを隠す
- レシート解析には Gemini を利用する
- 支出カテゴリの提案には Jev を利用し、ユーザーが確認・確定する
- カード明細との一致判定は、原則として決定的なルール・スコアリングで行う
- 「未照合 = 不正利用」とは判定せず、確認が必要な取引として提示する
- 家計データとレシート画像は原則として自宅の常時稼働Linux上で管理する

## MVP

- レシート撮影・画像保存
- Geminiによるレシート情報の構造化抽出
- 基本カテゴリの提案とユーザー確定
- ユーザーごとのアカウント（MVPでは本人の家計簿だけ閲覧可能）
- 三井住友カード / 楽天カード / イオンカード / PayPay の明細取り込み
- 家計簿記録と明細の自動照合
- 一致 / 要確認 / 記録なし の確認画面
- Actual Budgetとの連携

## ドキュメント

- [PRODUCT.md](docs/PRODUCT.md): プロダクト目的・MVP・非目標
- [ARCHITECTURE.md](docs/ARCHITECTURE.md): システム構成と責務分離
- [UX.md](docs/UX.md): ユーザーフローと画面設計
- [DESIGN.md](docs/DESIGN.md): UIデザイン原則
- [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md): 段階的な実装計画
- [DEPLOYMENT.md](docs/DEPLOYMENT.md): 自宅LinuxからVPS/PaaSへ移行できるデプロイ方針
- [CODING_AGENT_PROMPT.md](docs/CODING_AGENT_PROMPT.md): 初期実装を依頼するためのプロンプト
- [CONTRIBUTING.md](CONTRIBUTING.md): ブランチ・コミット・PR運用
- [SECURITY.md](SECURITY.md): 家計データを扱う際のセキュリティ方針
- [CLOUD_ACCOUNT.md](docs/CLOUD_ACCOUNT.md): Cloud account、Passkey、AI利用量の境界と運用

## Status

家族ごとのメールアドレス・パスワードによるログインと、本人の家計簿を確認する画面を実装しています。ホームには今月の支出と最近の支出を表示します。支出一覧・支出詳細・設定も利用できます。レシート画像の登録・保存・本人限定の再表示、Geminiによるレシート情報抽出、カテゴリ提案とユーザー確定、確認済みレシートのActual Budget登録に対応しています。レシート登録は本人のBudget内の口座を選び、店名・日付・整数円金額を確認してから実行します。`/statements/import` から明細CSVを取り込めます。現時点でPayPayの公式13列形式を受け付けます。三井住友カードと楽天カードの実exportでは文字コードと構造を確認しましたが、取引へ変換するための行の意味が未確定なので取り込みを拒否します。イオンカードも形式未確認のため拒否します。詳細は[明細CSV形式の確認記録](docs/STATEMENT_FORMATS.md)を参照してください。登録済みレシートとcanonical明細の決定的な照合engineと、本人単位のrun snapshot保存を実装しています。`/reconciliation` の確認画面、判断記録、Actualへの反映を実装しています。自動一致はまとめて確認済みにし、判断が必要な明細と反映エラーを優先表示します。Actualへのレシート登録のライブ試験は未実施です。手順は[レシート登録ライブ試験](docs/ACTUAL_RECEIPT_LIVE_TEST.md)を参照してください。

支出一覧は、本人の家計簿から日付の新しい取引を最大50件取得し、その中の支出だけを表示します。ホームの最近の支出は同じ取得結果から最大5件を表示します。収入と口座間振替は支出一覧へ表示しません。「今月」は `APP_TIME_ZONE`（既定値 `Asia/Tokyo`）で判定します。取引に保存された日付は変換しません。

## Development workflow

仕様・設計は `docs/` を正本とし、実装作業はGitHub Issuesで管理します。

- [MVP Epic](https://github.com/RyoyaYahagi/KakeiMatch/issues/15)
- [最初の実装Issue: MVP基盤](https://github.com/RyoyaYahagi/KakeiMatch/issues/1)

基本の流れ:

```text
docs = 長期仕様
  ↓
GitHub Issue = 1つの作業
  ↓
feature branch
  ↓
Pull Request
  ↓
squash merge
```

AIコーディングエージェントには原則として1 Issueずつ実装させます。

## ローカル開発

必要なものはNode.js 22以降とCorepackです。CorepackはNode.jsに同梱され、プロジェクト指定のpnpmを利用できるようにします。

```sh
corepack enable
pnpm install
cp .env.example .env.local
openssl rand -base64 32  # 出力を .env.local の AUTH_SECRET に設定する
# .env.local の APP_URL を http://localhost:3000 に変更する
pnpm user:create
pnpm dev
```

アカウント作成コマンドは管理者がサーバー上の対話端末で実行します。表示名、メールアドレス、パスワードを順に入力します。パスワードの入力内容は画面に表示されません。家族の人数分だけコマンドを実行してください。パスワードをコマンド引数や環境変数へ書かないでください。

Actualでユーザー用Budgetを作成した後、KakeiMatch userとBudgetを管理者commandで紐付けます。開発環境では `pnpm actual:link-user` を実行し、KakeiMatch userのemailとActual Sync IDを対話入力してください。Sync ID入力は画面に表示されません。既にmappingがあるuserは上書きされないため、誤ったmappingの修正は管理者が別途対応してください。

開発サーバーは <http://localhost:3000> で起動します。SQLiteデータベースは初期設定では `./data/kakeimatch.db` に保存されます。認証テーブルのマイグレーションはアプリ起動時にも適用されます。データを消去する場合は開発サーバーを停止してから `data/` を削除してください。

## Docker Composeでの起動

Docker Composeはアプリと公式Actual Serverを別serviceとして起動します。アプリは `127.0.0.1` に、Actual管理UIも `127.0.0.1` にだけ公開し、それぞれSQLiteとActual `/data` を別の名前付きvolumeへ保存します。外部公開にはHTTPSを終端するリバースプロキシが必要です。Actual管理UIは一般ユーザー向けに公開しないでください。

```sh
cp .env.example .env
# openssl rand -base64 32 の出力を .env の AUTH_SECRET に設定する
# Actual管理UIで設定したserver passwordを .env の ACTUAL_SERVER_PASSWORD に設定する
docker compose up --build -d
docker compose run --rm bootstrap
curl http://127.0.0.1:3002/api/health
```

`bootstrap` は同じ永続volumeを使う管理者用コマンドです。家族のアカウントごとに実行してください。通常の画面に登録機能はなく、公開の新規登録APIは無効です。Actual管理UIは <http://127.0.0.1:5006> で開けます。初回起動時にActualのserver passwordを設定してください。正常時のKakeiMatchヘルスチェック応答は `{"status":"ok"}` です。停止するには `docker compose down` を実行します。データ用volumeはこの操作では削除されません。データを含めて削除する場合は `docker compose down --volumes` を実行してください。

ActualでBudgetを作成した後、各ユーザーを紐付けます。Composeでは管理用imageを使って `docker compose run --rm bootstrap pnpm actual:link-user` を実行し、画面の案内に従ってuser emailと非表示のSync IDを入力してください。既にmappingがあるuserは上書きされません。

ホスト側の保存先はDockerが管理します。KakeiMatch SQLiteとActual CLI cache (`app-data`)、レシート画像 (`receipt-data`)、明細CSV原本 (`statement-data`)、Actual (`actual-data`) は別のvolumeです。DBとレシート画像・明細CSV原本は同じ時点の組としてバックアップ・復元してください。Actualのvolumeには家計簿データとサーバー設定が含まれます。バックアップ手順は運用開始前に整備が必要です。

## 確認コマンド

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Actual Gatewayの検証

`src/lib/actual-gateway.ts` はBetter Authのログインセッションからユーザーを特定し、`actual_budget_mapping` に保存された本人のSync IDをサーバー側で取得します。`getRecentTransactions`、`getTransactions`、`getTransactionById`、`getMonthlySpending` が読み取り専用の公開インターフェースです。各呼び出しでは公式 `@actual-app/cli` のActualQL照会を1回実行します。CLIのJSONを検証し、金額を整数円に変換してから返します。取引種別はGateway内で支出・収入・口座間振替へ変換し、画面には支出だけを表示します。ID指定の取得も本人のBudget内だけで行います。認証が必要な `GET /api/actual` は `view=recent`、`view=range&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`、`view=monthly&yearMonth=YYYY-MM` を受け付けます。Sync IDとパスワードはブラウザーへ返しません。CLIの接続設定とJSON形式は[Actual公式CLI資料](https://actualbudget.org/docs/api/cli/)に従います。

レシート登録は別の `src/lib/actual-receipt-writer.ts` が担当します。Actual公式CLIの `transactions import` と `transactions update` を使い、取引情報を引数ではなく標準入力からJSONで渡します。KakeiMatchとActualのカテゴリ名が一致しないBudgetでは、管理者が対話端末で `pnpm actual:map-categories` を実行してユーザー別の対応を設定します。詳細な状態保存と再試行手順は[レシート登録ライブ試験](docs/ACTUAL_RECEIPT_LIVE_TEST.md)に記載しています。

通常の `pnpm test` は人工データによる単体テストを実行します。実Actual Serverを使ったA/B分離テストは、次の手順で別途実行します。

1. 一時的なActual Serverを起動し、Actualの画面でJPY設定のBudget AとBudget Bを作成します。既存の家計簿は使用しないでください。
2. Budget Aへ `2026-09-28`、支出 `¥3,284`、支払先 `Synthetic A` の人工取引を登録します。同じ日付に合計 `¥500` のsplit transaction（`¥200` と `¥300` の子取引）と、別の口座への `¥400` のtransferも登録します。Budget Bへ同日、支出 `¥710`、支払先 `Synthetic B` の人工取引を登録します。
3. 2つのSync IDをActualの設定画面で確認します。テスト用Actual ServerのURLとパスワードも用意します。
4. リポジトリ外の `/tmp/kakeimatch-actual-test.env` を権限 `600` で作成し、以下の4変数を設定します。実際の値をGitへ登録しないでください。

```text
ACTUAL_SERVER_URL=http://127.0.0.1:5006
ACTUAL_SERVER_PASSWORD=<test-server-password>
ACTUAL_TEST_SYNC_ID_A=<budget-a-sync-id>
ACTUAL_TEST_SYNC_ID_B=<budget-b-sync-id>
```

```sh
chmod 600 /tmp/kakeimatch-actual-test.env
set -a
. /tmp/kakeimatch-actual-test.env
set +a
pnpm exec vitest run src/lib/actual-gateway.live.test.ts
```

このテストは一時SQLiteへテストユーザーA/Bとそれぞれのmappingを作成します。認証ユーザーをA/Bへ切り替えてそれぞれのBudgetの取引だけを取得し、mappingのないユーザーでは明示的に失敗することを確認します。Aの月間支出はsplitの親を重複計上せず、transferを除いた `¥3,784` です。Actual CLIのJSONでAの最初の支出が `-3284`、Bの支出が `-710` となることも確認します。CLIが返すJPY金額の扱いは、[Actualの通貨定義](https://github.com/actualbudget/actual/blob/master/packages/loot-core/src/shared/currencies.ts)とこの人工Budgetでの往復結果に基づき、整数値1単位を1円としています。

本番Dockerイメージ内のCLIを確認するには、`docker compose build app` の後、`docker compose run --rm --no-deps app node /app/node_modules/@actual-app/cli/dist/cli.js --version` を実行します。実接続の確認は、テスト専用の資格情報ファイルを `docker run --env-file` で渡し、`node /app/node_modules/@actual-app/cli/dist/cli.js --format json query run --table transactions --select id,date,amount --order-by date:desc` を実行します。CLI用キャッシュディレクトリをコンテナ内の書き込み可能な `/app/data/actual-cli` 以下に設定してください。

## 環境変数

`.env.example` にある `APP_URL` はアプリの公開URL、`PORT` はComposeでホストへ割り当てるポート、`DATABASE_PATH` はSQLiteファイルの場所です。`RECEIPT_STORAGE_DIR` は公開ディレクトリ外のレシート原本保存先で、ローカル開発では `./data/receipts`、Composeでは `/app/receipts` を使います。`AUTH_SECRET` は認証セッションの署名に使う秘密鍵です。`ACTUAL_SERVER_URL` と `ACTUAL_SERVER_PASSWORD` はサーバー側のActual接続設定であり、ブラウザーへ渡さないでください。`ACTUAL_DATA_DIR` はActual Serverコンテナ内のデータディレクトリです。`ACTUAL_CLI_DATA_DIR` はKakeiMatch内のCLIクライアント用キャッシュディレクトリです。Composeでは前者をActual専用volumeの `/data`、後者をアプリ専用volumeの `/app/data/actual-cli` に分けます。CLIのキャッシュはmapping IDとSync IDのハッシュごとに別ディレクトリへ保存し、生のメールアドレスやSync IDをパスに使用しません。

KakeiMatch userを削除すると、そのuserのmapping行だけがDBから削除されます。対応するActual Budgetとその家計データはActual Server上に残るため、不要になったBudgetはActual管理UIで別途削除してください。

`GEMINI_API_KEY` はGemini APIへの接続に使う秘密情報です。`GEMINI_MODEL` はレシート解析モデルで、既定値は `gemini-3.5-flash-lite` です。どちらもサーバーだけが読み取り、ブラウザーへ公開しません。Gemini APIを有効にすると、ユーザーが保存したレシート画像が解析のためGoogleへ送信されます。画像と形式、抽出指示以外のユーザー情報は送信しません。

`TYPESAFE_API_KEY` はTypeSafe APIへの接続に使う秘密情報です。`TYPESAFE_API_URL` はSystem One endpoint（既定値 `https://api.typesafe.ai/v1/systemone`）、`JEV_MODEL` は分類モデル（既定値 `jev-latest`）です。`JEV_CATEGORY_MIN_PROBABILITY`（既定値 `0.75`）と `JEV_CATEGORY_MIN_MARGIN`（既定値 `0.15`）は自動提案の初期しきい値です。選択カテゴリの確率が前者以上で、1位と2位の確率差が後者以上の場合だけ自動提案し、それ以外は確認を求めます。どれもサーバー専用で、ブラウザーへ公開しません。Jevへ送るのは抽出済みデータの店名・合計金額・商品明細だけで、画像やレシートIDは送りません。

分類のしきい値を検証する場合は、人工データ22件を使う `corepack pnpm eval:category` を実行します。実行には `TYPESAFE_API_KEY` が必要です。このコマンドは通常の `pnpm test` から独立しており、評価入力をTypeSafe APIへ送信します。出力にはカテゴリ正解率、自動提案率、要確認率、選択カテゴリの確率、上位2カテゴリの確率差が含まれます。しきい値を変えた場合も同じデータで比較できます。実データは評価に使用しません。

実際の秘密情報は `.env` や `.env.local` に設定し、Gitへ登録しないでください。

## Reconciliation evaluation

照合ルールの変更時は、完全に人工データの33シナリオを再評価できます。

```sh
pnpm eval:reconciliation
```

評価はauto-match precision（誤った自動一致を最優先で検出）、matchable pairに対するcoverage、statementのneeds-review率、unmatched statement/receipt件数、期待状態との一致率を出します。各scenarioは独立して実行し、配列順や他ケースのデータが結果に影響しません。現行ルールはamount/date/merchantを55%/25%/20%で加重し、候補日付windowは±7日、自動一致はamount exact、日付差2日以内、merchant similarity 0.72以上または明示alias、score 0.88以上、mutual best、双方のmargin 0.15以上を要求します。現行ルールで33シナリオを評価した結果は、auto-match precision 1.00、coverage 1.00（19件中19件）、needs-review率 31.4%、unmatched statement 5件、unmatched receipt 5件、期待状態との一致率 1.00です。precisionを落としてcoverageを上げる目的には使いません。
