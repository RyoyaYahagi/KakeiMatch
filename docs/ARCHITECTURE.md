# Architecture

## 基本方針

KakeiMatch本体とActual Budgetを疎結合にします。

Actual Budgetをforkしたりiframeで埋め込んだりせず、家計簿エンジン・管理UIとして利用します。通常利用者にはKakeiMatchの簡単なWeb UIだけを提供します。

## 概念構成

```text
スマートフォン / PC
        |
        | HTTPS
        v
KakeiMatch Web App
        |
        +-- 認証・認可
        +-- レシート登録
        +-- Gemini連携
        +-- Jev分類
        +-- 明細import
        +-- Reconciliation
        +-- 要確認UI
        |
        +--------> KakeiMatch DB
        |            - user
        |            - receipt metadata
        |            - receipt attachment
        |            - import job
        |            - reconciliation state
        |            - audit / correction history
        |
        +--------> Actual Adapter
                         |
                         v
                 @actual-app/cli
               (採用済み・読み取り専用)
                         |
                         v
                  Actual Sync Server
                  self-hosted
                         |
                         +-- User A Budget
                         +-- User B Budget
                         +-- User C Budget
```

## ホスティング

MVPは自宅の常時稼働Linux上でセルフホストします。

外部から家族が利用するため、公開時には以下を必須とします。

- HTTPS
- 認証
- サーバーサイドでの認可
- 秘密情報をリポジトリへ保存しない
- バックアップ
- レシート画像への認可チェック
- Actual Budget管理画面を不用意にインターネット公開しない

具体的な公開方法は実装フェーズで決定します。

## Actual Budgetの責務

Actual Budgetに任せるもの:

- 家計簿取引
- 口座
- 支出カテゴリ
- 基本的な家計簿集計
- 管理者向けの詳細編集
- 家計簿データの基盤

KakeiMatchに持たせるもの:

- KakeiMatch利用者
- レシート画像
- OCR抽出結果
- AI分類の候補・confidence
- 明細importの原データ
- 照合候補
- 照合状態
- ユーザー確認結果
- Actual上の取引との対応ID

Actual内部DBへKakeiMatchから直接SQLを書かないでください。公開されたAPI・CLI等の境界を利用します。

## ユーザーとデータ分離

MVPは**本人だけ見える家計簿**です。

必須条件:

- すべてのKakeiMatchデータは所有者 `user_id` を持つ、または所有者を一意に辿れる
- APIはクライアントから渡された `user_id` を信用せず、認証セッションから所有者を決定する
- レシート画像取得時にも認可を行う
- import・reconciliation検索は必ずログインユーザーのスコープ内で行う
- 他ユーザーのActual上の取引IDを指定しても読み書きできないようにする

MVPでは原則として **KakeiMatchユーザー1人につきActual Budgetを1つ**割り当てます。KakeiMatch DBに `user_id -> Actual Sync ID` の対応を保持し、サーバーサイドだけがこの対応を解決します。

Actualは1インストール内に複数Budgetを保持できます。この分離方式により、同じBudget内でユーザー所有権を再実装するより、データ混在のリスクを小さくします。

Actualのserver password / session token / budget Sync IDはブラウザへ公開しません。

読み取り専用のActual Gatewayには、公式 `@actual-app/cli` の短命プロセスを採用しました。取引照会は1メソッドにつき1回のActualQL queryで実行します。Better Authセッションから得たユーザーIDだけでmappingを検索し、Sync IDとパスワードは子プロセスの環境変数として渡します。CLIへ渡す引数は配列で組み立て、JSON出力をZodで検証します。`@actual-app/api` はGatewayの実装に使用していません。[公式CLI資料](https://actualbudget.org/docs/api/cli/)と[ActualQL資料](https://actualbudget.org/docs/api/actual-ql/)を実装時に確認しました。

Gatewayのインターフェースは `getRecentTransactions({ limit? })`、`getTransactions({ startDate, endDate })`、`getTransactionById(id)`、`getMonthlySpending({ yearMonth })` です。取引の金額は符号付き整数円、今月の支出は正の整数円で返します。Gatewayは取引を支出・収入・口座間振替へ変換し、画面へActual固有の振替IDを渡しません。ID指定の照会は認証済みユーザーに紐付いたBudgetへ限定し、1件だけ取得します。ActualQLではsplit transactionの子を読む既定の `inline` 方式を使用します。集計ではparent、口座間transfer、収入を除外します。[ActualQLのsplit仕様](https://actualbudget.org/docs/api/actual-ql/)に従います。

CLIのキャッシュは `ACTUAL_CLI_DATA_DIR` の下にmapping IDとSync IDのハッシュで分離したディレクトリへ保存します。CLI自身のロックを有効なまま使用します。Composeではアプリ側の `/app/data/actual-cli` を使い、Actual Server側の `ACTUAL_DATA_DIR=/data` とは別のvolumeです。JPY設定の人工Budgetへ¥3,284の支出を登録してCLIのJSONが `-3284` を返すことを確認したため、Actualの整数値1単位を1円として変換します。[ActualのJPY通貨定義](https://github.com/actualbudget/actual/blob/master/packages/loot-core/src/shared/currencies.ts)とも一致します。

## レシート処理

```text
画像upload
  |
  v
安全な画像保存
  |
  v
Gemini
  |
  v
構造化データ
  - merchant
  - purchased_at
  - total_amount
  - items
  - tax 等
  |
  v
schema validation
  |
  +--> 既知ルール / 過去修正
  |
  +--> Jev分類
  |
  v
必要な場合のみ確認
  |
  v
Actualへ登録
```

AIの出力は必ずschema validationを通します。金額・日付など重要項目が不正な場合は自動確定しません。

## カテゴリ分類

優先順位:

1. 明確な固定ルール
2. 過去に確定したユーザー修正・merchant mapping
3. Jevによる分類
4. confidenceが低ければユーザー確認

LLMを毎回呼ぶことを前提にしません。

## 明細import

カード会社ごとにadapterを分離します。

```text
Raw File
   |
   v
Provider Adapter
   |
   v
Canonical Transaction
{
  source,
  external_id?,
  merchant,
  amount,
  used_at,
  posted_at?,
  raw
}
```

予定provider:

- SMBC
- Rakuten Card
- AEON Card
- PayPay

provider固有の列名や文字コードをreconciliationロジックに漏らさないでください。

## Reconciliation

照合はLLM中心にしません。

候補生成に利用可能な情報:

- 金額
- 利用日 / 計上日
- 店舗名
- 決済手段
- OCR情報
- 過去のmerchant alias

状態例:

- `matched`: 高信頼で一致
- `needs_review`: 候補はあるが要確認
- `unmatched_statement`: 明細側だけ存在
- `unmatched_receipt`: 家計簿/レシート側だけ存在
- `confirmed`: ユーザーが確認済み

スコアや閾値は一箇所で管理し、単体テスト可能にします。

## レシート画像

Issue #7ではレシート原本を `ReceiptStorage` 境界の背後に保存します。MVPの実装は `LocalReceiptStorage` です。保存先は `RECEIPT_STORAGE_DIR` で指定し、Composeでは公開ディレクトリの外にある `receipt-data` volumeを使います。UIとドメインはファイルシステムのパスを扱いません。将来S3/R2互換ストレージへ移す際は、この境界の実装を差し替えます。

- Git管理しない
- public directoryへ直接置かない
- UUID等でファイル名を生成する
- 元のアップロードファイル名を信用しない
- JPEG、PNG、WebPのMIME typeとファイル署名、10 MiBの容量上限をサーバー側で検証する
- 画像取得時は、認証セッションのユーザーIDとレシートIDを組み合わせてメタデータを検索し、認可後に配信する
- DBには所有者、保存キー、形式、容量、作成日時を保持する。絶対パスは保存しない

原本のEXIFやGPS情報は、この段階では削除しません。原本とDBは一緒にバックアップしてください。ユーザー削除でDBのレシート行がcascade削除された場合、画像は残り得ます。ユーザー削除時の画像一括削除と孤児画像の回収は後続の運用課題です。

## 外部AI

Actual Budgetをセルフホストしても、Geminiへ送信したレシート情報は外部サービスへ送られます。

レシート解析では、保存画像、content type、抽出promptだけをGoogleのGemini APIへ送信します。ユーザー名、email、Actual Budget情報、家計履歴、他のレシートは送信しません。Gemini Interactions APIでは `store: false` を指定し、Google Search、grounding、toolsを有効にしません。APIキーとモデル名はserver-onlyの `GEMINI_API_KEY` / `GEMINI_MODEL` で設定します。モデル既定値は `gemini-3.5-flash-lite` です。

解析endpointは、セッションユーザーとreceipt IDおよびownerで画像metadataを取得した後、`ReceiptStorage.get()` から画像を読み出します。解析に失敗しても保存済み画像を削除せず、ユーザーが再解析できます。Gemini APIが利用されることはREADMEと画面の案内で利用者に伝えます。

## 設計ルール

- YAGNI: 将来機能のためだけの抽象化を作らない
- provider integrationはadapter境界を持つ
- AI結果と確定データを区別する
- user correctionを追跡可能にする
- fallbackで誤魔化さず、失敗状態を明示する
- UIからインフラ実装を直接参照しない


## Actual Adapterの検証方針

実装の最初に、UIより先に小さなintegration spikeを行います。

確認項目:

1. 同一Actual Server上にテスト用Budgetを2つ作成する
2. KakeiMatchのテストユーザーA/Bへ別々のSync IDを割り当てる
3. CLI経由で各Budgetのaccount / category / transactionを取得できる
4. Aの操作でBのBudgetへアクセスしないことをテストする
5. transaction一覧取得とJPY金額変換を人工データで確認する
6. split transactionとtransferを支出集計から適切に処理する
7. CLI失敗時にstderrや秘密情報をそのままユーザーへ返さないことを確認する

Actual連携をdomain層へ直接書かず、`ActualGateway` 等の小さなinterfaceの背後に置きます。


## Hosting portability

自宅LinuxはMVPの**最初のデプロイ先**であり、アプリケーション仕様にはしません。

KakeiMatchは、Dockerを実行できる別環境へ移行できることを前提に設計します。

### Hostに依存させないもの

以下をコードへ埋め込まないでください。

- 自宅Linux固有の絶対パス
- LAN内IPアドレス
- 特定のreverse proxy
- 特定のDNS provider
- systemd固有の起動処理
- ホスト上のユーザー名
- localhost前提のActual URL

これらはenvironment / deployment configurationへ置きます。

### 状態を3つに分離する

KakeiMatchの永続状態を以下の境界で扱います。

1. **Application Database**
   - ユーザー
   - receipt metadata
   - import metadata
   - reconciliation state
   - Actual mapping

2. **Receipt Object Storage**
   - レシート画像
   - 必要に応じてimport元ファイル

3. **Actual Budget Data**
   - Actual Sync Serverの永続データ

アプリケーションコードはホスト上の具体的な保存場所を直接知りません。

### Storage abstraction

レシート画像は小さなinterfaceを通して扱います。

概念例:

```ts
interface ReceiptStorage {
  put(...): Promise<StoredReceipt>;
  get(...): Promise<ReadableStream | Buffer>;
  delete(...): Promise<void>;
}
```

MVP:

```text
LocalReceiptStorage
  -> mounted persistent volume
```

将来:

```text
S3ReceiptStorage
  -> S3 / R2 / S3-compatible object storage
```

domain/UIからローカルファイルパスを参照しないでください。

### Database portability

MVPでは少人数・単一インスタンスを優先しSQLiteを利用します。

ただし:

- SQLite固有SQLを必要以上にdomain層へ漏らさない
- ORM / repository境界を利用する
- DBファイルパスはenvironmentで与える
- backup/export手段を用意する
- 将来PaaS等で必要になればPostgreSQLへ移行できる余地を残す

「いつかPostgreSQLへ移行するかもしれない」という理由だけで、MVPをPostgreSQL化しません。

### Actual portability

Actual ServerはKakeiMatch containerと分離します。

KakeiMatchが知るのは:

- server URL
- credential
- user -> Sync ID mapping

だけです。

Actualの `/data` volumeを別ホストへ移せば、KakeiMatch本体を変更せず移行できる構造にします。

### Portable deployment contract

最低限、以下で起動できることを目標とします。

```text
Docker / OCI container runtime
+ environment variables / secrets
+ persistent database volume
+ persistent Actual volume
+ receipt storage backend
```

Docker Composeは自宅Linux向けのreference deploymentとして扱い、アプリ内部からComposeのservice name等へ強く依存しないでください。

### Backup / restore

将来のホスト移行もバックアップ/リストアの一種として扱います。

少なくとも以下を個別に復元できる構造にします。

- KakeiMatch DB
- receipt files
- Actual data
- environment/secretsは別途再設定

本番データをcontainer imageへ含めないでください。
