# Coding Agent Prompt — Initial Implementation

この文書は旧Next.jsサーバー構成の開発・検証記録です。現在の本番PWAの起動要件ではありません。現行構成は[アーキテクチャ](ARCHITECTURE.md)、旧構成の任意実行は[legacy手順](../legacy/README.md)を参照してください。

あなたは `RyoyaYahagi/KakeiMatch` の初期実装を担当してください。

## 最初に必ず読む

実装前に以下をすべて読んでください。

1. `README.md`
2. `docs/PRODUCT.md`
3. `docs/ARCHITECTURE.md`
4. `docs/UX.md`
5. `docs/DESIGN.md`
6. `docs/IMPLEMENTATION_PLAN.md`
7. `CONTRIBUTING.md`
8. `SECURITY.md`
9. `AGENTS.md`

これらの内容を仕様として扱ってください。矛盾がある場合は、勝手に大きな仕様変更をせずPR本文に明記してください。

## 今回の作業範囲

**Phase 0 + Phase 1のみ実装してください。**

今回まだ実装しないもの:

- Geminiレシート解析
- Jev分類
- レシート画像アップロード
- 三井住友 / 楽天 / イオン / PayPayカード parser
- 明細reconciliation本体
- 不正利用判定
- 家族間の家計簿共有

まず「本人だけ見える家計簿Webアプリ」とActual Budget連携の土台を完成させます。

## Git

`main` へ直接実装しないでください。

```text
feature/mvp-foundation
```

を作成して作業してください。

無関係な変更は含めないでください。完了時にはPRにできる状態にしてください。

## 技術構成

過度に複雑にしないでください。

基本案:

- Next.js
- TypeScript strict
- Node.js runtime
- pnpm
- SQLite
- Drizzle ORM
- Better Auth
- Tailwind CSS
- Vitest
- Docker / Docker Compose
- Actual Budget self-hosted

既存コードや現在の安定版との相性に問題がある場合は、理由を示して変更して構いません。

### 認証

家族だけが利用します。

- email + passwordで十分
- Better Auth等の維持されている認証ライブラリを使う
- public signupはproductionでは無効
- 管理者が家族アカウントを作成できるbootstrap方法を用意する
- セッションcookieは安全な設定にする
- 認証を自作しない

MVPでは各ユーザーは**本人の家計簿だけ**を見られます。

すべてのserver action / route handler / storage accessで認可してください。

クライアントから送られた `userId` を認可根拠にしてはいけません。必ずsessionからユーザーを取得してください。

## KakeiMatch DB

SQLiteを利用し、少なくとも以下を管理できるようにしてください。

- auth関連テーブル
- KakeiMatch userとActual Budgetのmapping
- 将来のreceipt / import / reconciliationを追加できる最小限の構造

ただし将来用テーブルを大量に先行実装しないでください。

Actual mappingの概念:

```text
kakeimatch_user_id
actual_sync_id
created_at
updated_at
```

必要であればdefault account等を追加して構いませんが、理由を文書化してください。

## Actual Budget

Actual本体をforkしないでください。

Dockerで公式Actual Serverを起動できるようにしてください。

KakeiMatchからActual内部SQLiteへ直接アクセスしてはいけません。

### 1 user = 1 Actual Budget

MVPでは1人につき1つのActual Budgetを割り当てます。

同一Actual Server上に複数Budgetを置いて構いません。

KakeiMatch側ではログインユーザーから対応するSync IDをサーバー側で解決します。

Sync IDやActual password/session tokenをブラウザへ返さないでください。

### Actual Adapter

domain/UIからActualの実装詳細を分離してください。

例:

```ts
interface ActualGateway {
  getRecentTransactions(...): Promise<...>
  getMonthlySummary(...): Promise<...>
}
```

必要以上に巨大なinterfaceにはしないでください。

### CLI方式を最初に検証

現在のActual公式CLI `@actual-app/cli` は、account/category/transaction/query等を扱えます。

今回のMVPでは、複数ユーザーのBudgetを安全に切り替えるため、まずCLIをサーバー側の短命プロセスとして使う方式を試してください。

重要:

- shell文字列連結で実行しない
- `spawn` / `execFile` 等でargsを配列として渡す
- user inputをcommandとして解釈させない
- `ACTUAL_SYNC_ID` はsession userのmappingから設定
- password/tokenはenvironmentまたはsecret fileから渡す
- stdoutはJSONとしてvalidationする
- stderrをそのままブラウザへ返さない
- CLIを細かいループで何十回も呼ばず、queryをまとめる

CLIで必要な機能が不足する場合のみ `@actual-app/api` をActual Adapter内部で検討してください。

その場合もブラウザ版APIは使わずNode.js server-sideだけで利用してください。

## Actual integration spike

UIを作り込む前に以下を確認してください。

### Test user A

Actual Budget A

### Test user B

Actual Budget B

以下をintegration testまたは再現可能な検証手順で確認してください。

- AのSync IDでAのtransactionを取得できる
- BのSync IDでBのtransactionを取得できる
- KakeiMatch user AからBのデータを取得できない
- URLやrequest bodyを書き換えても他人のSync IDを指定できない
- Actual credentialがclient bundleへ入っていない

Actual CLI自体にBudget新規作成機能がない場合は、Phase 0ではActual純正UIでテストBudgetを手動作成し、Sync IDをbootstrap commandでKakeiMatch userへ紐付ける方式で構いません。自動化のためだけにActual内部DBを触らないでください。

## 金額

KakeiMatchのdomain上では、日本円を整数円で扱ってください。

例:

```text
3284 = ¥3,284
```

JavaScript floating pointの小数金額をdomain valueにしないでください。

Actual側のamount representationはKakeiMatchと同じとは限りません。Actual Adapter境界で変換し、変換ロジックをunit testしてください。

Actualの設定・通貨仕様を確認せず、機械的に `* 100` する実装は禁止です。

## Phase 1 UI

モバイルファーストで以下を作ってください。

### Login

- email
- password
- login
- logout

public signup UIは出さないでください。

### Home

最低限:

```text
今月の支出
¥xx,xxx

[レシートを登録]  ← 今回はdisabledまたは「準備中」でよい

最近の支出
9/28 ベイシア      ¥3,284
9/27 ガスト        ¥1,280
...
```

Phase 1ではActualの実データから表示できることを優先します。

「レシートを登録」は後続Phase用なので、動いているふりをするdummy implementationは作らないでください。

### 支出一覧

- 日付
- 店名/payee
- 金額
- カテゴリ（あれば）

コンパクトな1行表示を基本にしてください。

Cardを1件ずつ大量に使わないでください。

### 支出詳細

最低限:

- 日付
- 店名
- 金額
- カテゴリ
- cleared等、ユーザーに必要な状態

Actualの内部ID等を通常UIへ表示しないでください。

### Settings

最低限:

- ログインユーザー情報
- logout
- Actual接続状態を一般ユーザー向け表現で表示してよい

Sync ID / passwordは表示しないでください。

## UI/UX

`docs/UX.md` と `docs/DESIGN.md` を厳守してください。

特に:

- mobile first
- Card乱用禁止
- 1行リスト
- 本文16px程度を基準
- 44px程度以上のtap target
- 色だけで状態を示さない
- 技術名を通常UIに出さない
- 1画面のprimary CTAは原則1つ
- loading / empty / error stateを作る

UIコンポーネントは、

```text
components/ui
components/app
```

等で責務を分けてください。

巨大なpage componentにすべて入れないでください。

## Docker / Hosting portability

最初のデプロイ先は自宅の常時稼働Linuxですが、KakeiMatchを自宅Linux専用にしないでください。

`docs/DEPLOYMENT.md` も必ず読み、VPS等へ同じ構成を移せるようにしてください。

以下をsource codeへ埋め込まないでください。

- home server固有のabsolute path
- LAN IP
- Docker Compose service name
- reverse proxy固有設定
- host username

これらはenvironment/deployment configurationへ置いてください。

レシート保存は将来のPhaseで `ReceiptStorage` interface等を介し、local persistent volumeからS3-compatible storageへ差し替えられる構造にします。

MVPではSQLiteを維持します。将来のためだけにPostgreSQLを導入しないでください。ただしSQLite固有処理をdomain/UIへ散らさないでください。

### 自宅Linux reference deployment


少なくとも以下を用意してください。

- KakeiMatch Dockerfile
- Actual Server
- Docker Compose
- persistent volume for Actual
- persistent volume for KakeiMatch SQLite
- Actual CLI cache/data directoryが必要ならpersistentまたは安全なruntime directory
- healthcheck（現実的な範囲）

秘密情報をimageへ焼き込まないでください。

HTTPS/reverse proxyは今回の必須実装でなくても構いませんが、production公開前に必要であることをREADMEへ明記してください。

## Environment

既存 `.env.example` を実装に合わせて更新してください。

最低限の概念:

- app URL
- auth secret
- database path/URL
- Actual server URL
- Actual passwordまたはsession token
- Actual CLI data dir

本番秘密情報をcommitしないでください。

## Security

このアプリは家計データを扱います。

必ず確認:

- IDORがない
- server-side authorization
- no public signup in production
- secrets are server-only
- sensitive data is not logged
- no raw family financial data in fixtures
- error responseにcredentialやCLI stderrを漏らさない

## Tests

### Unit

最低限:

- Actual Adapter output parsing
- amount conversion
- monthly aggregation
- authorization helper
- invalid CLI output handling

### Integration

可能な範囲で:

- user A / B data isolation
- Actual test budget access
- unauthorized route access

外部Actual Serverが必要なintegration testは、通常CIで無理に実サーバーへ接続せず、明確に分けてください。

### E2E

Phase 1では最低1本:

```text
login
 -> home
 -> own transactions visible
 -> logout
```

Playwright等を使用して構いません。

## CI

GitHub Actionsで最低限:

- install
- lint
- typecheck
- unit test
- build

を実行してください。

実Actual credentialをGitHub Actionsへ要求しない構成にしてください。

## Documentation

実装後に更新してください。

- README: setup / local development
- docs/ARCHITECTURE.md: 実際に採用したActual Adapter方式
- .env.example
- Docker起動方法
- テスト方法
- test Budgetとuser mappingの設定方法

## 完了条件

今回の作業は以下を満たしたら完了です。

1. DockerでKakeiMatch + Actualを起動できる
2. 家族用ユーザーを作成する手順がある
3. userごとにActual Sync IDを紐付けられる
4. ログインできる
5. 本人のActual transactionだけホーム/一覧で見える
6. 別ユーザーのデータへアクセスできない
7. lint/typecheck/test/buildが通る
8. CIがある
9. mobile UIが `UX.md` / `DESIGN.md` に沿う
10. READMEだけで開発者が起動手順を再現できる

## 最後に報告する内容

作業後は以下を簡潔に報告してください。

- 採用した技術と理由
- 作成/変更した主要ファイル
- Actual連携方式
- データ分離方法
- テスト結果
- 未解決事項
- 次にPhase 2（Receipt Capture）へ進む前に確認すべきこと

仕様を勝手にPhase 2以降へ広げないでください。
