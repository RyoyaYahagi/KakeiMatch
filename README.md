# KakeiMatch

家族向けのシンプルな家計簿・レシート照合Webアプリです。

レシートを撮影して支出を記録し、後からクレジットカード・決済サービスの明細と照合します。
一致した取引は自動で処理し、確認が必要な取引だけをユーザーに見せることで、家計簿入力と明細確認の手間を減らすことを目指します。

## コンセプト

- 親を含む家族がスマートフォンから迷わず使えることを最優先する
- 家計簿の基盤にはセルフホストした Actual Budget を利用する
- 親向けUIは KakeiMatch 側で提供し、Actual Budget の複雑さを隠す
- レシート解析には Gemini を利用する
- 支出カテゴリの選択・曖昧な分類には Jev の利用を検討する
- カード明細との一致判定は、原則として決定的なルール・スコアリングで行う
- 「未照合 = 不正利用」とは判定せず、確認が必要な取引として提示する
- 家計データとレシート画像は原則として自宅の常時稼働Linux上で管理する

## MVP

- レシート撮影・画像保存
- Geminiによるレシート情報抽出
- 家計簿への支出登録
- 基本カテゴリ分類
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

## Status

家族ごとのメールアドレス・パスワードによるログインを実装しています。ホームはログインした本人だけが閲覧できます。本人のActual Budgetから取引を読むサーバー側Gatewayも実装しています。ホームへの取引表示、取引の書き込み、レシート・明細機能は後続のIssueで実装します。

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

ホスト側の保存先はDockerが管理します。KakeiMatch SQLite (`app-data`) とActual (`actual-data`) は別々にバックアップ・復元してください。Actualのvolumeには家計簿データとサーバー設定が含まれます。バックアップ手順は運用開始前に整備が必要です。

## 確認コマンド

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Actual Gatewayの検証

`src/lib/actual-gateway.ts` はBetter Authのログインセッションからユーザーを特定し、`actual_budget_mapping` に保存された本人のSync IDをサーバー側で取得します。`getRecentTransactions`、`getTransactions`、`getMonthlySpending` が読み取り専用の公開インターフェースです。各呼び出しでは公式 `@actual-app/cli` のActualQL照会を1回実行します。CLIのJSONを検証し、金額を整数円に変換してから返します。認証が必要な `GET /api/actual` は `view=recent`、`view=range&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`、`view=monthly&yearMonth=YYYY-MM` を受け付けます。Sync IDとパスワードはブラウザーへ返しません。CLIの接続設定とJSON形式は[Actual公式CLI資料](https://actualbudget.org/docs/api/cli/)に従います。

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

`.env.example` にある `APP_URL` はアプリの公開URL、`PORT` はComposeでホストへ割り当てるポート、`DATABASE_PATH` はSQLiteファイルの場所です。`AUTH_SECRET` は認証セッションの署名に使う秘密鍵です。`ACTUAL_SERVER_URL` と `ACTUAL_SERVER_PASSWORD` はサーバー側のActual接続設定であり、ブラウザーへ渡さないでください。`ACTUAL_DATA_DIR` はActual Serverコンテナ内のデータディレクトリです。`ACTUAL_CLI_DATA_DIR` はKakeiMatch内のCLIクライアント用キャッシュディレクトリです。Composeでは前者をActual専用volumeの `/data`、後者をアプリ専用volumeの `/app/data/actual-cli` に分けます。CLIのキャッシュはmapping IDとSync IDのハッシュごとに別ディレクトリへ保存し、生のメールアドレスやSync IDをパスに使用しません。

KakeiMatch userを削除すると、そのuserのmapping行だけがDBから削除されます。対応するActual Budgetとその家計データはActual Server上に残るため、不要になったBudgetはActual管理UIで別途削除してください。

実際の秘密情報は `.env` や `.env.local` に設定し、Gitへ登録しないでください。
