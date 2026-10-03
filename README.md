# KakeiMatch

**レシートを撮るだけで家計簿に記録し、後から届くカード明細と自動で突き合わせる家族向けPWAです。**

一致した取引は自動で片付け、人が見るのは「金額が違う」「記録が見つからない」など判断が必要なものだけにします。家計データは利用者の端末に保存し、サーバーへ預けません。

- 本番アプリ: <https://kakeimatch.yhgry.workers.dev>（AI機能の利用には招待制のアカウントが必要です）
- 対応環境: iPhoneのSafari（ホーム画面に追加して使用）を主な対象とし、PCのブラウザーにも対応しています

<p>
  <img src="docs/screenshots/ui-home-light-top-375.png" alt="ホーム画面。今月の支出、収入、収支、カテゴリ別の内訳を表示している" width="240">
  <img src="docs/screenshots/ui-entry-receipt-light-375.png" alt="レシート登録画面。AIで読み取るボタンと、合計金額・店名・購入日の入力欄がある" width="240">
  <img src="docs/screenshots/ui-reconciliation-list-light-375.png" alt="照合画面。要確認1件、記録なし2件、自動で一致2件と、確認が必要な明細の一覧を表示している" width="240">
</p>

<img src="docs/screenshots/ui-desktop-home-light-1440.png" alt="PC幅のホーム画面。左にナビゲーション、中央に月の収支と最近の記録、右に支出の内訳がある" width="740">

スクリーンショットはすべて合成データです。

## 作った理由

家計簿をつけるときの負担は、レシートの入力だけではありません。入力した後、後日届くクレジットカードや決済サービスの明細と1件ずつ突き合わせ、金額の違いや記録漏れを探す作業が残ります。

家計簿アプリは記録や集計には優れています。しかし「レシートで記録した支出」と「後日届くカード明細」の照合は、人の手に残りがちです。KakeiMatchは、この照合作業を減らすために作りました。

主な利用者は親で、開発者本人も使っています。スマートフォンで毎日開くことを前提に設計しました。

### 目指したこと

1. **レシートから楽に記録できる**: 撮影した画像から店名・日付・金額・品目を読み取り、カテゴリも提案します
2. **カード明細と自動で照合できる**: カード会社のサイトから取得したCSVを取り込み、家計簿の記録と突き合わせます
3. **人には要確認だけを見せる**: 正しく一致した取引は表に出さず、判断が必要なものだけを示します

OCRの精度100%は目指していません。成功の基準は機能の数ではなく、家計簿と照合にかかる手作業がどれだけ減るかです。また、記録のない明細を「不正利用」とは呼びません。レシートの紛失、オンライン決済、利用日と計上日のずれなど、正当な理由が多いためです。

## 主な機能

### 記録する

- **レシート登録**: 画像から店名・日付・合計金額・品目をAIで読み取ります。AIを使わない手入力もできます
- **カテゴリ提案**: 品目ごとにカテゴリを提案します。利用者が修正した履歴を端末内で学習し、次回から優先します
- **手入力**: 収入・支出・口座間の振替を登録できます。品目を分けて、カテゴリ別に金額を配分することもできます
- **定期登録**: 家賃や給与など、毎月・毎週・毎年の固定収支を自動で登録します
- **編集・削除**: 登録後に品目やカテゴリを修正でき、変更履歴が残ります。削除は10秒間取り消せます

### カード明細と照合する

- **明細CSVの取り込み**: 次の形式に対応しています。CSVは端末内で処理し、AIやサーバーへ送りません

  | カード | 対応範囲 |
  | --- | --- |
  | PayPayカード | PayPayクレジットの1回払い |
  | 三井住友カード（Vpass） | 通常の1回払い |
  | 楽天カード | 通常の1回払い |

- **自動照合**: 日付・金額・店名から候補を探し、確実に一致したものは自動で処理します
- **要確認と記録なし**: 金額の違いや候補が複数ある取引は「要確認」に、対応する記録がない明細は「記録なし」に分け、画面の先頭に表示します。記録なしの明細は、その場で支出として登録できます
- **取り込みの重複防止**: 同じCSVを再度取り込んでも明細は増えません。分割払いなど対応範囲外の行は購入として登録せず、行番号と理由を示します

### 家計を見る

- 月ごとの収入・支出・収支と、カテゴリ別の内訳グラフ
- カテゴリ別の月予算と進み具合
- 口座ごとの残高
- 全期間の記録の検索・絞り込み（店名、メモ、品目名、期間、金額）

### データを守る

- **端末内保存とオフライン動作**: 家計データは端末に保存し、通信できない場所でも閲覧・記録できます
- **バックアップと復元**: 家計簿、レシート画像、明細を1つの `.kmb` ファイルに書き出し、別の端末で復元できます
- **安全な更新**: アプリ更新時も入力中の内容を保持します。端末内データの形式は、バージョンを判定してから移行します

### アカウントとサポート

- **Passkeyログイン**: パスワードを使わず、Face IDなどでログインします。アカウントはAI機能の利用時だけ必要です
- **AI利用枠**: 利用者ごとの月間利用回数と、サービス全体の費用上限を設けています
- **お問い合わせ**: 音声で入力でき、不具合や改善要望はGitHub Issueとして登録されます
- **アカウント削除**: 本人がアカウントを削除できます。端末の家計データは削除されません

## 設計で大事にしたこと

### 家計データを端末から出さない（local-first）

家計簿、レシート、明細、照合結果は利用者のブラウザー（IndexedDBとActual Budgetのブラウザー版）に保存します。サーバー側のデータベースには、本人確認、session、Passkey、AI利用量など、アカウントとAIの運用に必要な情報だけを保存します。アカウントにログインしていなくても、通信できなくても、AI以外の機能はすべて使えます。

AIに送る情報も絞っています。レシート画像は、利用者が「AIで読み取る」を選んだときだけ送ります。カテゴリ提案には、検証済みの店名、合計金額、最大30件の品目名と金額だけを送ります。

### AIと通常のコードを使い分ける

AIは曖昧さを含む処理だけに使います。

| 処理 | 担当 |
| --- | --- |
| レシート画像の読み取り | Gemini |
| 選択肢からのカテゴリ分類 | Jev（TypeSafe） |
| 明細の照合、重複判定、状態遷移、金額計算、認可 | 通常のTypeScriptコード |

AIの応答はZodのschemaで検証し、不正な応答は保存しません。金額は整数の円で扱い、浮動小数点を使いません。照合ロジックには、合成データの評価セット（`pnpm eval:reconciliation`）を用意しています。

### 解決済みの問題を作り直さない

家計簿の基盤には、オープンソースの[Actual Budget](https://github.com/actualbudget/actual)のブラウザー版を使っています。KakeiMatchは、レシート入力、AI分類、明細照合、スマートフォン向けの画面に集中しています。

### 費用と濫用を抑える

AIの利用はCloudflare Worker経由に限定し、APIキーをブラウザーに渡しません。利用者ごとの月間上限とレート制限に加え、サービス全体の日次・月次の費用上限を設けています。上限に達した場合や、障害が続いた場合はAIを自動で停止します。AIが止まっても、手入力と照合は使い続けられます。

## アーキテクチャ

```mermaid
flowchart TB
  subgraph Device["利用者の端末（ブラウザー / iPhone）"]
    UI["PWAの画面<br/>TypeScript + Vite"]
    Actual["Actual Budget<br/>ブラウザー版"]
    IDB["KakeiMatchの記録<br/>IndexedDB"]
    UI --> Actual
    UI --> IDB
  end

  subgraph CF["Cloudflare Worker（同一origin）"]
    Assets["PWA配信"]
    Auth["/api/auth・/api/account<br/>Better Auth + Passkey"]
    AI["/api/ai・/api/contact<br/>認証・利用枠・応答検証"]
    D1[("D1<br/>アカウント・利用量のみ")]
    Auth --> D1
    AI --> D1
  end

  UI -- "AIを使うときだけ" --> AI
  UI -- "ログイン" --> Auth
  AI --> Gemini["Gemini API"]
  AI --> Jev["Jev API"]
  AI --> GH["GitHub Issues"]
```

アプリとAPIは1つのCloudflare Workerから同じoriginで配信します。ブラウザー内でActual Budgetを動かすため、WorkerはCOOP/COEPヘッダーを返します。Service Workerは `/api/*` をキャッシュしません。詳細は[アーキテクチャ](docs/ARCHITECTURE.md)を参照してください。

### 技術スタック

| 領域 | 使用技術 |
| --- | --- |
| フロントエンド | TypeScript（UIフレームワークなし）、Vite、PWA（Service Worker） |
| 家計簿エンジン | Actual Budget（`@actual-app/api` のブラウザー版） |
| 端末内保存 | IndexedDB、Actual Budgetのブラウザー内データ |
| サーバー | Cloudflare Workers、Cloudflare Vite Plugin、`cf` CLI |
| データベース | Cloudflare D1（アカウントとAI利用量のみ） |
| 認証 | Better Auth、Passkey（WebAuthn） |
| AI | Gemini API（レシート読み取り、文字起こし）、Jev（カテゴリ分類） |
| 検証・解析 | Zod、csv-parse |
| テスト | Vitest、Playwright（合成データによるブラウザーE2E）、GitHub Actions |

### 開発の進め方

AIコーディングエージェントと一緒に開発しています。[AGENTS.md](AGENTS.md)と[CONTRIBUTING.md](CONTRIBUTING.md)に、データ境界、AIの使い方、UIの原則、ブランチ運用を明文化しました。機能ごとにIssueと小さなPull Requestで進め、CIで型検査、単体テスト、照合の評価、ブラウザーE2Eを実行しています。テストには実際の家計データを使わず、合成データだけを使います。

## 開発者向け

### 必要なもの

- Node.js 22
- pnpm（`package.json` の `packageManager` で固定したバージョン）

pnpmはCorepackで用意します。rootのscriptが内部で `pnpm` を呼ぶため、最初に一度Corepackを有効にしてください。

```sh
corepack enable
```

### ローカルで動かす

リポジトリのrootで実行します。

```sh
pnpm install
pnpm dev
```

`dev` はCloudflare Vite Plugin経由で、PWAと同じoriginのAPIを <http://127.0.0.1:5173> で起動します。ローカルではCloud accountとAIを設定していないため、`/api/ai/*` などは `503 not_configured` を返します。それ以外の家計機能はそのまま試せます。

本番と同じbuild出力で確認する場合は次を実行します。

```sh
pnpm build
pnpm start
```

### テスト

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm eval:reconciliation
pnpm --dir apps/pwa test
```

ブラウザーE2Eは、build済みのPWAを起動してから実行します。

```sh
pnpm --dir apps/pwa build
pnpm --dir apps/pwa exec playwright-core install chromium
pnpm --dir apps/pwa exec vite preview --host 127.0.0.1 --port 5173
```

別のターミナルで、起動したURLを指定して実行します。

```sh
PWA_E2E_URL=http://127.0.0.1:5173 pnpm --dir apps/pwa test:e2e
```

E2Eのscript一覧は [apps/pwa/package.json](apps/pwa/package.json) にあります。AI Gateway Workerは独立したnpm packageです。

```sh
npm ci --prefix workers/ai-gateway
npm run --prefix workers/ai-gateway test
npm run --prefix workers/ai-gateway typecheck
```

テストやfixtureに実際の家計情報を入れないでください。

### リポジトリ構成

```text
apps/pwa/             本番のPWAと、それを配信するWorkerの入口
workers/ai-gateway/   Cloud account・AI・お問い合わせのAPIとD1 migration
src/                  PWAと共有する一部のmoduleと、legacyサーバー実装
eval/                 照合ロジックの評価セット
docs/                 設計・運用の資料
legacy/               以前のサーバー中心構成の資料
```

## セルフホスト

自分のCloudflareアカウントでKakeiMatchを動かす手順です。Cloudflare Workers、D1、Rate Limitingを使います。AI機能を使う場合は、GeminiとTypeSafe（Jev）のAPIキーも必要で、利用量に応じて費用がかかります。

> [!IMPORTANT]
> ブラウザーの保存領域はURL（origin）ごとに分かれます。利用を始めた後にWorker名やURLを変えると、保存済みの家計データがアプリから見えなくなります。公開するWorker名とURLは最初に決め、変更しないでください。

### 1. 設定を自分の環境に合わせる

[apps/pwa/cloudflare.config.ts](apps/pwa/cloudflare.config.ts) の本番用の値は、このリポジトリの公開環境を指しています。次の値を変更してください。

| 設定 | 内容 |
| --- | --- |
| `worker.name` の本番値（`kakeimatch`） | 公開するWorker名 |
| `CLOUD_ACCOUNT_ORIGIN` の本番値 | 公開URL（例: `https://<worker名>.<subdomain>.workers.dev`） |
| `GITHUB_ISSUES_REPOSITORY` | お問い合わせの登録先リポジトリ（`owner/repo`） |
| `AI_USER_RATE_LIMIT` の本番 `namespace` | アカウント内で重複しないRate LimitingのID |
| `AI_FREE_MONTHLY_LIMIT` | アカウントごとの月間AI利用回数（初期値 `30`） |

お問い合わせ画面からリンクしているIssue一覧のURLは [apps/pwa/src/contact-ui.ts](apps/pwa/src/contact-ui.ts) にあります。

### 2. Cloudflareにログインし、D1を作る

Cloudflareの操作には、新しい公式CLIの `cf` を使います。`cf` はopen betaのため、実行前に `cf --help` と `cf cli search "<やりたいこと>"` で現在のコマンドを確認してください。

```sh
pnpm --dir apps/pwa exec cf auth login
pnpm --dir apps/pwa exec cf d1 create --name <D1の名前>
```

作成したD1のIDと名前を環境変数に設定します。本番modeのbuildは、この2つがないと失敗します。

```sh
export ACCOUNT_D1_ID='<D1のID>'
export ACCOUNT_D1_NAME='<D1の名前>'
```

### 3. D1にmigrationを適用する

```sh
pnpm --dir apps/pwa exec cf d1 migrations apply "$ACCOUNT_D1_ID" --dir ../../workers/ai-gateway/migrations
```

### 4. デプロイする

```sh
pnpm --dir apps/pwa exec cf deploy --mode production-deploy --dry-run
pnpm --dir apps/pwa exec cf deploy --mode production-deploy
```

`--mode production-deploy` を付けない通常のbuildは、開発用のpreview設定を選びます。

### 5. secretを登録する

次の値をWorkerのsecretとして登録します。値はGit、設定ファイル、シェル履歴、コマンド引数に残さないでください。初回デプロイの前後で登録方法が異なるため、[Cloudflareの公式手順](https://developers.cloudflare.com/workers/configuration/secrets/)と、その時点の `cf` を確認してください。

| secret | 用途 | 必要な場面 |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Cloud accountのsession署名 | ログイン |
| `ACCOUNT_BOOTSTRAP_SECRET` | 招待の発行 | アカウント作成 |
| `AI_GATEWAY_AUTH_SECRET` | AI要求用トークンの署名 | AI |
| `GEMINI_API_KEY` | レシート読み取り、お問い合わせ | AI |
| `TYPESAFE_API_KEY` | カテゴリ提案（Jev） | AI |
| `GITHUB_ISSUES_TOKEN` | お問い合わせのIssue登録（対象リポジトリのIssues書き込み権限） | お問い合わせ |
| `AI_GUARDRAILS_JSON` | 費用上限の上書き。未設定なら初期値で制限 | 任意 |
| `AI_EMERGENCY_STOP` | `true` で全AIを停止 | 任意 |

secretを登録しなくても、AI以外の家計機能は使えます。その場合、ログインとAIの要求は拒否されます。

### 6. 最初のアカウントを招待する

アカウントは招待制です。`ACCOUNT_BOOTSTRAP_SECRET` を使い、[招待script](workers/ai-gateway/scripts/account-invite.mjs)で招待URLを発行します。手順は[デプロイ](docs/DEPLOYMENT.md#本人による招待と実機確認)を参照してください。招待URLを開き、Passkeyを登録するとログインできます。

### 7. 公開後に確認する

- `GET /` が200を返し、`Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: require-corp` が付いている
- 未ログインでの `/api/account/*` と `/api/ai/*` が401や403で拒否され、500やsecretを返さない
- iPhoneのSafariでホーム画面に追加し、機内モードでも保存済みデータを閲覧できる

本番の更新手順、費用上限の運用、お問い合わせの導入は[デプロイ](docs/DEPLOYMENT.md)と[AI費用の停止と再開](docs/AI_COST_GUARDRAILS.md)にまとめています。

> [!NOTE]
> rootの `pnpm deploy` は、このリポジトリの本番Workerへのデプロイを想定したscriptです。`pnpm deploy:preview` は開発者用のpreview Workerを指しています。セルフホストでは上記のコマンドを使ってください。

### データについての注意

- `.kmb` バックアップは暗号化されません。安全な場所に保管してください
- previewや開発環境では、合成データだけを使ってください
- 以前のNext.js・Docker Compose・Actual Sync Serverによる構成はlegacyです。セルフホストに自宅サーバーは不要です

## ドキュメント

**プロダクトと設計**

- [プロダクト](docs/PRODUCT.md): 目的、MVP、対象外の機能
- [アーキテクチャ](docs/ARCHITECTURE.md): 本番構成とデータ境界
- [UX](docs/UX.md)と[デザイン](docs/DESIGN.md): 画面設計の方針
- [実装計画](docs/IMPLEMENTATION_PLAN.md): 現在の利用フローと残作業
- [セキュリティ](SECURITY.md): データとサービスの保護

**機能の仕様**

- [端末内の明細照合](docs/LOCAL_RECONCILIATION.md)と[明細形式](docs/STATEMENT_FORMATS.md)
- [カテゴリ修正履歴による分類](docs/LOCAL_CATEGORY_LEARNING.md)
- [カテゴリと支払元の管理](docs/LOCAL_MASTERS.md)
- [登録した記録の編集](docs/LOCAL_RECEIPT_EDITS.md)と[取引削除と取り消し](docs/LOCAL_TRANSACTION_DELETION.md)
- [口座間振替](docs/LOCAL_TRANSFERS.md)と[定期収入・定期支出](docs/LOCAL_RECURRING_TRANSACTIONS.md)
- [記録の検索・絞り込み](docs/LOCAL_TRANSACTION_SEARCH.md)
- [月次ダッシュボード](docs/LOCAL_MONTHLY_DASHBOARD.md)、[口座残高](docs/LOCAL_ACCOUNT_BALANCES.md)、[カテゴリ別月予算](docs/LOCAL_MONTHLY_BUDGETS.md)
- [Cloud account](docs/CLOUD_ACCOUNT.md): Passkey、AI利用、権限、D1
- [お問い合わせ](docs/CONTACT.md)と[端末内の診断](docs/LOCAL_DIAGNOSTICS.md)

**データと運用**

- [デプロイ](docs/DEPLOYMENT.md): 本番URL、preview、更新手順
- [AI費用の停止と再開](docs/AI_COST_GUARDRAILS.md)
- [バックアップと復元](docs/LOCAL_BACKUP.md)と[不完全復元の調査と停止](docs/ACTUAL_RESTORE_CLEANUP.md)
- [端末内データの構造変更](docs/LOCAL_DATA_MIGRATIONS.md)と[アプリ更新](docs/PWA_UPDATES.md)
- [暗号化クラウド保存の共通形式](docs/ENCRYPTED_HOUSEHOLD_STORAGE.md)（開発中）
- [ローカル利用フロー](docs/LOCAL_FIRST_FLOW.md): 合成データによるブラウザー・iPhoneでの確認状況
- [コントリビューション](CONTRIBUTING.md): ブランチとPull Requestの運用

## legacyサーバー実装

以前のNext.js、SQLite、ファイル保存、Actual CLIのコードは、テストと移行の参照用に残しています。`legacy:` で始まるscriptは開発専用で、PWAの利用やデプロイには不要です。PWAは旧サーバーのSQLiteを直接読みません。旧Actual ServerのZIPに含まれるのはActual Budgetの取引だけで、旧receipt/statement metadataは自動移行されません。詳細は[legacy文書index](docs/legacy/README.md)と[legacy runtime inventory](docs/LEGACY_RUNTIME_INVENTORY.md)を参照してください。

## ライセンス

家計簿エンジンには[Actual Budget](https://github.com/actualbudget/actual)（MIT License）を使っています。著作権表示とライセンス全文は[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)にあります。

KakeiMatch本体のコードには、まだオープンソースライセンスを設定していません。
