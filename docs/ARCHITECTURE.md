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
                  @actual-app/api
                  (Node.js / server-side)
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

Actualのserver password / session token / budget Sync IDはブラウザへ公開しません。Actual操作はNode.jsサーバーサイドから `@actual-app/api` を利用します。

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

レシート画像は自宅Linux上へ保存します。

- Git管理しない
- public directoryへ直接置かない
- UUID等でファイル名を生成する
- 元のアップロードファイル名を信用しない
- MIME type / 容量を検証する
- ログインユーザーの認可後に配信する
- DBには保存先とmetadataを保持する

## 外部AI

Actual Budgetをセルフホストしても、Geminiへ送信したレシート情報は外部サービスへ送られます。

秘密情報や不要な家計データをAIへ送信せず、処理ごとに入力を最小化します。

## 設計ルール

- YAGNI: 将来機能のためだけの抽象化を作らない
- provider integrationはadapter境界を持つ
- AI結果と確定データを区別する
- user correctionを追跡可能にする
- fallbackで誤魔化さず、失敗状態を明示する
- UIからインフラ実装を直接参照しない
