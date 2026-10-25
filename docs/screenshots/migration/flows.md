# PWA / iOS parity flows

Identifier は iOS `accessibilityIdentifier` として共用する。表の PWA selector は現行 DOM の id または role/name。PWA コードは変更していない。

| Flow / 操作 | 共通 identifier | PWA selector |
|---|---|---|
| レシート登録: 追加シートを開く | `receipt.openAdd` | `#record-tab` → button「記録を追加」 |
| レシート画像を選ぶ | `receipt.imageInput` | `#record-sheet input[type=file]` |
| AI読み取りを開始 | `receipt.aiButton` | button「AIで読み取る」 |
| 読み取り結果の合計を確認/編集 | `receipt.totalField` | `#receipt-amount` |
| 全体タブへ | `receipt.overviewTab` | button「全体」 |
| 品目一覧タブへ | `receipt.itemsTab` | button「品目一覧」 |
| 品目カテゴリを修正 | `receipt.itemCategory` | `.receipt-item` 内のカテゴリ選択UI |
| レシートを登録 | `receipt.saveButton` | button「登録する」 |
| 登録結果を記録一覧で確認 | `records.tab` | `#receipt-tab` |
| 手入力を開始 | `entry.openManual` | button「支出を手入力」 |
| 支出金額・店名・日付 | `entry.amountField`, `entry.payeeField`, `entry.dateField` | `#manual-transaction-amount`, `#manual-transaction-payee`, `#manual-transaction-date` |
| カテゴリ・支払元を選択 | `entry.categoryPicker`, `entry.accountPicker` | `#manual-transaction-category`, `#manual-transaction-account` |
| 手入力を保存 | `entry.saveButton` | button「登録する」 |
| 収入入力を開始/保存 | `entry.income`, `entry.saveButton` | button「収入」 / button「登録する」 |
| 振替入力を開始/保存 | `entry.transfer`, `entry.saveButton` | button「口座間の振替」 / button「登録する」 |
| 明細CSV取り込み欄を開く | `reconciliation.importCsvButton` | `summary`「明細CSVを取り込む」 |
| サービスとCSVを指定 | `reconciliation.provider`, `reconciliation.csvInput` | `#statement-provider`, `#statement-file` |
| 取り込んで照合 | `reconciliation.importButton` | button「取り込んで照合」 |
| 要確認明細を開く | `reconciliation.reviewItem` | `details.review-item > summary` |
| 候補を同じ支出として確定 | `reconciliation.confirmMatch` | button「同じ支出」 |
| 一致履歴を開く | `reconciliation.matchedGroup` | `.reconciliation` 内一致履歴の開閉 summary |

PWA の既存 selector を優先して列挙しました。カテゴリ選択シートや一致履歴の DOM selector は画面状態で異なり、安定した専用 `data-testid` は見当たらないため、画面表示名を併記しています。追加の定期・予算・マスタ・バックアップ parity 操作は各 PWA E2E（`browser-entry-recurrence.mjs`、`browser-monthly-budgets.mjs`、`browser-masters.mjs`、`browser-backup.mjs`）を参照してください。

## 主なシナリオ

1. **レシート**: `receipt.openAdd` → `receipt.imageInput` → `receipt.aiButton` → `receipt.overviewTab` → `receipt.itemsTab` → `receipt.itemCategory` → `receipt.saveButton` → `records.tab`。
2. **手入力**: `entry.openManual` → 金額・店名・日付 → カテゴリ・支払元 → `entry.saveButton` → 記録一覧で登録結果を確認。収入・振替も種別を選び対応項目を入力して保存。
3. **照合**: `reconciliation.importCsvButton` → provider/CSV指定 → `reconciliation.importButton` → 要確認行を展開 → 候補比較 → `reconciliation.confirmMatch`。一致件数と折りたたみ済み履歴を確認。
