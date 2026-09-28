# Implementation Plan

## 方針

KakeiMatchは一度にMVP全部を実装しません。

機能を小さく分け、各段階で動作確認できる状態を保ちます。特にActual Budget連携とユーザー分離は、UI実装より先に技術検証します。

## Phase 0: Foundation / Integration Spike

目的: 後から作り直しになりやすい境界を先に確認する。

### 実施内容

- Next.js + TypeScriptを基盤にする
- Node.js runtimeを前提にする
- package managerを1つに固定する
- lint / typecheck / testを設定する
- SQLiteをKakeiMatch metadata DBとして採用する
- 認証の最低限の土台を作る
- Actual BudgetをDockerでセルフホストできる構成を作る
- KakeiMatchユーザー1人につきActual Budget 1つのmappingを作る
- Actual Adapterのintegration spikeを作る
- まず `@actual-app/cli` 方式を検証する
- CLIで不足がある場合のみ `@actual-app/api` 方式を比較する
- テストユーザーA/Bでデータ分離を確認する

### 完了条件

- Aで作成した取引をBから取得できない
- Actual上の取引をKakeiMatchから追加・一覧取得できる
- 秘密情報がブラウザへ露出しない
- ローカル起動手順がREADMEに記載されている

## Phase 1: Authentication + Personal Ledger Shell

目的: 各ユーザーが自分の家計簿だけを見られる最小Webアプリを作る。

### 画面

- ログイン
- ホーム
- 支出一覧
- 支出詳細
- 設定

### 要件

- サーバーサイド認可
- 他ユーザーのresource IDを直接指定しても403/404相当
- 今月の支出表示
- 最近の支出表示
- Actualから取得した取引表示

この段階ではレシートAIやカード明細照合を入れない。

## Phase 2: Receipt Capture

目的: スマートフォンからレシートを撮って保存できるようにする。

### 要件

- camera / photo upload
- MIME type / file size validation
- UUID等の安全なファイル名
- public directory外への保存
- ログインユーザーだけ画像を取得可能
- receipt metadataをSQLiteへ保存
- 画像アップロード後の状態表示

この段階ではGemini解析なしでも、画像保存とownershipを先に完成させる。

## Phase 3: Gemini Receipt Extraction

目的: レシート画像から家計簿登録に必要な情報を抽出する。

### 抽出候補

- merchant
- purchased_at
- total_amount
- tax（取得できれば）
- items（補助情報）
- extraction confidence / warnings（実装可能な範囲）

### 要件

- Geminiのstructured outputを使用する
- Zod等で再validationする
- 金額は整数で扱う
- 不正な日付・金額を自動確定しない
- Gemini失敗時もレシート画像を失わない
- 再解析可能にする

## Phase 4: Category Classification with Jev

目的: 基本カテゴリを自動提案する。

### 入力

Jevへ画像を直接渡さない。

Gemini等で構造化した以下の情報をstateとして使う。

- merchant
- items
- amount
- past confirmed merchant/category mapping（必要な範囲）

### Choice候補（暫定）

- food
- daily_goods
- transport
- medical
- clothing
- entertainment
- utilities
- communication
- other

### 要件

- Jev Choiceを利用する
- `other` を必ず含める
- confidence thresholdを設定可能にする
- confidenceが低い場合はユーザー確認
- ユーザー修正を次回のmerchant mappingに活かせる構造にする
- Jev API障害時は未分類で登録可能にする

## Phase 5: Receipt -> Actual Registration

目的: 確定したレシート情報をActualへ取引として登録する。

### 要件

- user -> Actual Sync IDをサーバー側で解決
- account/category/payee mapping
- transaction IDをKakeiMatch側へ保存
- 金額はActualのinteger amount仕様に合わせる
- 二重登録防止
- 登録失敗時にreceiptを消さない

## Phase 6: Statement Import

目的: カード・決済明細を取り込めるようにする。

### Adapter

- SMBC
- Rakuten Card
- AEON Card
- PayPay

各adapterは共通のcanonical schemaへ変換する。

```ts
type CanonicalStatementTransaction = {
  source: string;
  externalId?: string;
  merchant: string;
  amount: number; // integer minor unit / project-defined integer convention
  usedAt: string;
  postedAt?: string;
};
```

### 要件

- fixtureは人工データ
- raw fileはuser-scoped
- provider固有の文字コード・列名をadapter内部に閉じ込める
- 未知のフォーマットは勝手に推測して取り込まない

## Phase 7: Reconciliation

目的: 人間が確認する件数を減らす。

### 基本

AIを主判定器にしない。

候補スコア例:

- 金額一致
- 日付差
- merchant正規化後の類似度
- payment source
- merchant alias

### 結果

- matched
- needs_review
- unmatched_statement
- unmatched_receipt
- confirmed

### 要件

- thresholdを集中管理
- unit testを充実させる
- 同じ入力で結果が変わらない決定的ロジック
- なぜ候補になったかUIへ説明できる
- 未照合を「不正」と断定しない

## Phase 8: Review UX

目的: 要確認だけを短時間で処理できるようにする。

### 画面

- 照合サマリー
- 要確認一覧
- 照合詳細
- 「同じ支出」「別の支出」「自分の利用だがレシートなし」等の確認操作

正常なmatched transactionはデフォルトで折りたたむ。

## Phase 9: Deployment

### 自宅Linux

- Docker Compose
- KakeiMatch
- Actual Server
- persistent volumes
- HTTPS reverse proxy / secure exposure method
- backup

### 必須確認

- reboot後に自動復旧
- volumesの場所が明確
- backup / restore手順
- secretsをDocker imageやGitへ含めない
- Actual管理画面を必要以上に外部公開しない
- logsに個人情報が出ない

## テスト戦略

### Unit

- reconciliation
- merchant normalization
- provider parsers
- amount/date normalization
- Jev threshold logic
- schema validation

### Integration

- user -> Actual Budget mapping
- Actual Adapter
- receipt storage authorization
- transaction creation
- statement import

### E2E

MVP安定後、最低限:

1. login
2. receipt upload
3. extraction review
4. transaction save
5. statement import
6. reconciliation review

## 実装の優先順位

UXの完成度より先にデータ分離・保存・Actual連携を確認します。

ただしPhase 1以降のUI実装は必ず `docs/UX.md` と `docs/DESIGN.md` に従い、デスクトップ向け管理画面を先に作らないでください。
