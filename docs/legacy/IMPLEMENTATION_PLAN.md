# Implementation Plan

> Historical server-centric implementation plan preserved during Issue #39. Its phase status and deployment requirements are not current production instructions. See the [current implementation plan](../IMPLEMENTATION_PLAN.md).

## 方針

KakeiMatchは一度にMVP全部を実装しません。

機能を小さく分け、各段階で動作確認できる状態を保ちます。特にActual Budget連携とユーザー分離は、UI実装より先に技術検証します。

この計画のPhase 0〜9は、移行前のNext.jsサーバー中心実装に対する履歴と要件を含みます。現在の主アプリはIssue #35の `apps/pwa` です。Next.js実装はlegacyとして削除せずIssue #39まで保持します。PWAの現在状態は[ローカル保存フロー](../LOCAL_FIRST_FLOW.md)を参照してください。

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

legacy Next.jsの実装済み機能: `/receipts/[id]` で店名・日付・整数円金額・本人Budgetの支払元口座を確認し、カテゴリを確定してから登録します。公式CLIと `receipt_registration` を使うサーバー側方式です。現在のPWAは別に、端末内IndexedDBへレシートと登録状態を保存し、ブラウザーのActual adapterへ安定したimported IDで登録します。どちらの方式も実Actual Serverを使ったライブ登録は未確認です。PWAの状態は[ローカル保存フロー](../LOCAL_FIRST_FLOW.md)に記載します。

### 要件

- user -> Actual Sync IDをサーバー側で解決
- account/category/payee mapping
- transaction IDをKakeiMatch側へ保存
- 金額はActualのinteger amount仕様に合わせる
- 二重登録防止
- 登録失敗時にreceiptを消さない

## Phase 6: Statement Import

目的: カード・決済明細を取り込めるようにする。

legacy Next.js APIのIssue #11ではPayPayの公式13列headerを厳密に検証し、購入・返金と既知の対象外行を区別します。現在のPWAのPayPay adapterも同じ限定的な対応形式を端末内で解析します。楽天カードの実exportではUTF-8 BOMと11列headerを確認しましたが、継続行・部分行と金額列の意味を確認できないため取り込みを拒否します。三井住友カードの実exportはCP932でheaderがなく、列の意味が未確定です。イオンカードは形式未確認です。各社の確認状況は[STATEMENT_FORMATS.md](../STATEMENT_FORMATS.md)に記録します。

### Adapter

- SMBC
- Rakuten Card
- AEON Card
- PayPay

各adapterは共通のcanonical schemaへ変換する。

```ts
type CanonicalStatementTransaction = {
  provider: "smbc_card" | "rakuten_card" | "aeon_card" | "paypay";
  externalId: string | null;
  kind: "purchase" | "refund";
  usedDate: string;
  usedTime: string | null;
  postedDate: string | null;
  merchant: string;
  amountYen: number; // positive integer yen
  paymentMethod: string | null;
  sourceFingerprint: string;
  duplicateOrdinal: number;
};
```

### 要件

- fixtureは人工データ
- raw fileはuser-scoped
- provider固有の文字コード・列名をadapter内部に閉じ込める
- 未知のフォーマットは勝手に推測して取り込まない

## Phase 7: Reconciliation

照合engineの原実装はlegacy Next.js側にあります。PWAでは同じ決定的な照合engineを利用し、IndexedDBのconfirmed receiptとPayPay canonical statementだけを照合します。Gemini/JevやCSV原本は照合判定に使いません。候補の閾値と状態は実装共通のruleに従います。

legacy Next.js APIはsession user単位でsnapshotを返します。PWAはrun、候補、明細・レシート結果、ユーザー判断、Actual反映状態を端末のIndexedDBにsnapshotとして保存し、以前のrunを上書きしません。判断済みの明細、使用済みレシート、拒否済み候補を次のrunから除外します。

## Phase 8: Review UX

目的: 要確認だけを短時間で処理できるようにする。

legacy Next.jsの画面と保存方式については従来の記録を残します。PWAの照合画面では自動一致・要確認・記録なし・明細待ちの件数を示します。候補に対して「同じ支出」「別の支出」を選べます。候補がない明細は支払元とカテゴリを指定してActualへ登録できます。失敗したActual反映は判断状態を端末に残し、同じ安定IDで再試行します。

### 画面

- 照合サマリー
- 要確認一覧
- 照合詳細
- 「同じ支出」「別の支出」「自分の利用だがレシートなし」等の確認操作

正常なmatched transactionはデフォルトで折りたたむ。

## Phase 9: Deployment

自宅Linuxは最初のデプロイ先であり、アプリ仕様ではありません。詳細は `docs/DEPLOYMENT.md` に従います。

### 自宅Linux reference deployment

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
- reconciliation synthetic evaluation (auto-match precision, coverage, needs-review rate, unmatched counts)
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


## Portability gate

各Phaseで以下を壊していないか確認します。

- host固有pathをsource codeへ埋め込んでいない
- Actual Server URLをenvironmentから変更できる
- persistent dataがcontainer imageから分離されている
- filesystem accessがUI/domainへ漏れていない
- 別Linux hostへDocker構成を移せる
