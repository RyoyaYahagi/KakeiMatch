# PWA / iOS 共通の操作フロー

共通 identifier は iOS の `accessibilityIdentifier` に割り当てる**対応表**であり、PWA に同名の `data-testid` が実装済みという意味ではない。PWA の `src` は変更しない。PWA 列は実在する id・data属性、または Playwright の role/name locator。`button("…")` は `getByRole('button', { name: '…', exact: true })` を表す。

fixture 正本: [`test/fixtures/ios-migration/fixture.json`](../../../test/fixtures/ios-migration/fixture.json)。日付は Asia/Tokyo、金額は整数円。画像の生成・状態別の基準は [README.md](README.md) を参照する。

## 1. レシート登録 → AI読取 → 全体 → 品目 → カテゴリ修正 → 登録 → 記録一覧

初期条件: 空の保存領域に `accounts[0]` を作る。`receipt` から描いた合成画像を使い、Gemini/Jev は固定応答にする。

| 順 | 操作・確認 | 共通 identifier | PWA selector / 操作 |
|---|---|---|---|
| 1 | 追加シートを開く | `receipt.openAdd` | `#add-record` をクリック |
| 2 | 合成写真を選ぶ | `receipt.imageInput` | `#record-sheet input[type=file]` の先頭に `setInputFiles` |
| 3 | AIを開始し、読み取り中を確認 | `receipt.aiButton` | `button("AIで読み取る")`。`#receipt-merchant` の入力画面で実行 |
| 4 | 全体を表示 | `receipt.overviewTab` | `button("全体")` |
| 5 | 合計・店名・日付を確認 | `receipt.totalField` / `receipt.merchantField` / `receipt.dateField` | `#receipt-amount` / `#receipt-merchant` / `#receipt-date` |
| 6 | 支払元を選ぶ | `receipt.accountPicker` | `#receipt-account` にカードのラベルで `selectOption` |
| 7 | 品目一覧へ | `receipt.itemsTab` | `button("品目一覧")` |
| 8 | 対象品目を開く | `receipt.item.<index>.open` | `[data-receipt-item]` を品名で絞り、その `summary` をクリック |
| 9 | カテゴリを修正 | `receipt.item.<index>.category` | 開いた `[data-receipt-item]` 内の `[data-item-category]` に `selectOption({ label: '日用品' })` 等 |
| 10 | 登録する | `receipt.saveButton` | `button("登録する")`。`#message` の「登録しました。」を待つ |
| 11 | 記録一覧へ | `records.tab` | `#receipt-tab` |
| 12 | 登録結果を開く | `records.row.<fixtureKey>` | `#local-view` 内の button を「スーパーみどり · …」の accessible name で絞る |

`<index>` は fixture の品目順（0始まり）。PWA の生成UUIDを iOS identifier に埋め込まない。PWA は品目を `details.receipt-item[data-receipt-item]` で表示し、カテゴリは `[data-item-category]` の select で編集する。カテゴリの札を架空のシート selector に読み替えない。

根拠: `apps/pwa/src/main.ts`（`#add-record`）、`apps/pwa/src/local-ui.ts`（`receiptEditor`、`drawItems`、`readItems`）、`apps/pwa/test/browser-receipt-items.mjs`（品目編集の操作）。

## 2. 手入力（支出・収入・振替）

初期条件: 基本家計。支出・収入の金額・日付・店名・カテゴリ・口座は JSON の対象行を使う。

| 順 | 操作・確認 | 共通 identifier | PWA selector / 操作 |
|---|---|---|---|
| 1 | 追加シート | `entry.openAdd` | `#add-record` |
| 2 | 支出 / 収入 / 振替を選ぶ | `entry.openManual` / `entry.income` / `entry.transfer` | `#record-sheet` 内の `button("支出を手入力")` / `button("収入")` / `button("口座間の振替")` |
| 3 | 金額 | `entry.amountField` | `#manual-transaction-amount` |
| 4 | 店名または入金内容 | `entry.payeeField` | `#manual-transaction-payee`（振替では入力しない） |
| 5 | 日付 | `entry.dateField` | `#manual-transaction-date` |
| 6 | カテゴリシートを開く | `entry.categorySheet` | `button("すべてのカテゴリから選ぶ")`（支出・収入のみ） |
| 7 | カテゴリを選ぶ | `entry.categoryPicker` | `.category-sheet[open] [role="radio"]` をカテゴリの accessible name で選ぶ。E2Eで値を直接入れる場合は `#manual-transaction-category` |
| 8 | 支払元 / 入金先 / 振替元 | `entry.accountPicker` | `#manual-transaction-account`（振替元の label は「振替元口座」） |
| 9 | 振替先 | `entry.destinationPicker` | `#manual-transaction-destination`（振替だけ） |
| 10 | くり返し（任意） | `entry.recurrence` | `#manual-transaction-recurrence` に `selectOption({ label: '毎月' })`（支出・収入） |
| 11 | 登録・完了待ち | `entry.saveButton` | `button("登録する")` → `#message` の登録完了 |
| 12 | 一覧で確認 | `records.tab` | `#receipt-tab` → 対象行 |

支出の手入力は PWA のレシート共通 editor を使用し、画像なしでは `manual-transaction-*` id になる。収入・振替は `local-transaction-ui.ts`。表は同じ id の対応であり、内部実装が同じという意味ではない。

根拠: `apps/pwa/src/local-ui.ts`（`inputId`）、`apps/pwa/src/local-transaction-ui.ts`、`apps/pwa/src/category-picker.ts`（radio・シート）、`apps/pwa/src/entry-form.ts`（くり返し）、`apps/pwa/test/browser-entry-masters.mjs`、`browser-entry-recurrence.mjs`、`browser-transfers.mjs`。

## 3. 明細CSV → 照合 → 要確認 → 一致履歴

初期条件: `transactions` と `statement`。PayPay CSV はスクリプトが JSON の7行から組み立て、端末内で取り込む。青空食堂の20円差を手動確認する。

| 順 | 操作・確認 | 共通 identifier | PWA selector / 操作 |
|---|---|---|---|
| 1 | 照合タブ | `reconciliation.tab` | `#reconciliation-tab` |
| 2 | 取込欄を開く | `reconciliation.importCsvButton` | `summary` を「明細CSVを取り込む」で絞り、閉じている場合にクリック |
| 3 | サービスを選ぶ | `reconciliation.provider` | `#statement-provider` → `paypay_card` |
| 4 | CSVを指定 | `reconciliation.csvInput` | `#statement-file` に合成CSVを `setInputFiles` |
| 5 | 取り込んで照合 | `reconciliation.importButton` | `button("取り込んで照合")`。7件の取込完了と要確認1・記録なし2・一致4を待つ |
| 6 | 要確認の明細を開く | `reconciliation.reviewItem.<index>` | `#reconciliation-pending details.review-item` を「青空食堂」で絞り、その直下 `summary` |
| 7 | 明細と候補の差分を確認 | `reconciliation.candidate.<index>` | 開いた `.review-item` 内の `.compare-candidate`（日付・店名・金額の比較） |
| 8 | 同じ支出として確定 | `reconciliation.confirmMatch` | 対象候補内の `button("同じ支出")`。反映完了まで待つ |
| 9 | 一致履歴を開く | `reconciliation.matchedGroup` | `#reconciliation-matched > summary` |
| 10 | 対象の一致内容を確認 | `reconciliation.matchedItem.<index>` | `#reconciliation-matched > .review-list > li > details > summary` を対象店名で絞る |

この操作フローの手動一致後は一致が5件になる。基準画像 `reconciliation/matched` は、手動判断前の自動一致4件の履歴を展開した状態なので区別する。`<index>` は fixture 内の行順を使い、PWAの生成IDを共通仕様にしない。

根拠: `apps/pwa/src/local-ui.ts`（`reviewPage`、`#statement-provider`、`#reconciliation-pending`、`#reconciliation-matched`、`sameExpense`）、`apps/pwa/src/reconciliation-ui.ts`、`apps/pwa/test/browser-reconciliation.mjs`。

## その他の基準画面への入口

| 画面 | 共通 identifier | PWA selector / 操作 |
|---|---|---|
| 設定 | `settings.tab` | `#settings-tab` |
| 定期登録 | `settings.recurring` | 設定→`button("定期登録")` |
| 予算 | `settings.budget` | 設定→`button("予算設定")` |
| マスタ | `settings.categories` | 設定→`button("カテゴリ")` |
| 問い合わせ | `settings.contact` | 設定→`button("お問い合わせ")` |
| バックアップ | `settings.backup` / `backup.export` | 設定→`button("バックアップと復元")` → `#backup-export` |
| 同期 | `settings.deviceLink` | 設定→`button("ほかの端末と同期")` |
| MF移行 | `settings.moneyforward` | バックアップと復元→`button("マネーフォワードから移行")` → `#moneyforward-file` |
| 給与 | `payroll.open` | 収入→`button("AIで簡単入力")` の filechooser で写真を指定 → `.payroll-mask` |

既存E2Eの操作を参照し、実在する selector を grep と実行で確認した。PWA に `#record-tab`、架空の `.reconciliation` コンテナ、共通 identifier と同名の `data-testid` は追加していない。
