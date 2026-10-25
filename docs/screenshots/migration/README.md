# iOS 移行用 PWA 基準画面

Issue #240 Phase 0。PWA を正解実装とし、**27状態・light/dark 各1枚、合計54枚**を保存する。依頼された状態の未撮影はない。iOS の画面を新たに設計する資料ではない。

## 再生成

リポジトリ直下で依存をインストールし、別のターミナルで `pnpm --dir apps/pwa exec vite --host 127.0.0.1 --port 5173` を起動する。合成データ専用のローカル環境だけを指定する。

```sh
PWA_E2E_URL=http://127.0.0.1:5173 pnpm --dir apps/pwa screenshots:migration
(cd docs/screenshots/migration && sha256sum --check SHA256SUMS)
```

生成スクリプト: `apps/pwa/scripts/migration-screenshots.mjs`。起動ごとに新しいブラウザー保存領域を作り、既存の画面操作でデータを投入する。PWA の `src` と既存 `ci.yml` は変更しない。画面を模造した HTML や画像の後加工は使用しない（アップロードする合成写真の描画だけはスクリプト内で行う）。

- viewport: **390×844 CSS px / DPR 3**（PNG は1170×2532 px）。スクロール先頭の viewport を撮る。画面全体の縦長キャプチャではない。
- locale: ja-JP、timezone: Asia/Tokyo、日時: `2026-10-14T03:30:00.000Z`（日本時間12:30）。
- 外観: `theme-settings.ts` と同じ localStorage 設定と `kakeimatch-theme-change` イベントで light/dark を切り替える。`data-theme` の反映を待つ。
- AI: session・利用枠・Gemini・Jev は固定応答。読み取り中は Gemini 応答をゲートで保留し、両テーマを撮った後に解放する。実際の外部AIには送信しない。
- reduced-motion を有効化し、フォント・描画・家計集計の完了を待つ。保存前に連続する2フレームの PNG 一致を確認する。
- ページと Actual の JavaScript Worker の乱数を固定する。ランダムなカテゴリIDによる色の変化と同日取引の並び順の変化を防ぐ。テスト専用であり、本番の乱数処理は変更しない。
- Chromium の描画を単一 raster thread に固定する。同じ Playwright/Chromium・OS・フォントで比較する。今回の検証環境は Playwright **1.58.2 / Chromium 145.0.7632.6**、Linux、Noto Sans CJK JP。別環境のフォント差まで一致を保証するものではない。

独立した2回の生成で、54枚すべての SHA-256 が一致した。基準値は [SHA256SUMS](SHA256SUMS)。確認手順は次のとおり。

```sh
(cd docs/screenshots/migration && find . -name '*.png' -print0 | sort -z | xargs -0 sha256sum) > /tmp/migration-first.sha256
PWA_E2E_URL=http://127.0.0.1:5173 pnpm --dir apps/pwa screenshots:migration
(cd docs/screenshots/migration && sha256sum --check /tmp/migration-first.sha256)
```

## fixture とバックアップ

正本は [`test/fixtures/ios-migration/fixture.json`](../../../test/fixtures/ios-migration/fixture.json)。iOS UI test もこの JSON を読み込む。金額は整数円、日付とタイムゾーンは明示する。店名・会社名・レシート・CSV はすべて人工データで、個人の家計情報は含まない。

以下の表では `F` をこの JSON とする。「基本家計」は `F.accounts`、基本支出カテゴリ、`F.incomeCategory`、`F.transactions` の11件、`F.budgetYen`。「照合後」は基本家計へ `F.statement` の7行を PayPayカード形式で取り込んだものを指す。

[`synthetic.kmb`](../../../test/fixtures/ios-migration/synthetic.kmb) は同じ生成コマンドの中で、照合後の家計に `F.receipt` の支出を1件追加し、PWA の「バックアップを書き出す」を操作して download イベントから保存する。**合成レシートPNG原本1枚とCSV原本1件**を含む。スクリーンショット用の空状態や入力中の下書きまで一括復元するファイルではない。再生成時に Actual の内部情報やZIPの日時が変わるため、`.kmb` 自体のバイト一致は要件としない。

`src/lib/ios-migration-fixture.test.ts` で PWA の `readPortableBackup` に通し、schema・チェックサム・原本所有関係、7件の明細と12件の記録メタデータを検証する。バックアップの形式はZIPではなく、`KMATCHB1` ヘッダ・JSON目録・Actual ZIP・端末データ・原本の順で構成される。

## 状態一覧

PWA ソース欄のパスはすべて `apps/pwa/src/` からの相対パス。再現手順は生成スクリプトで実行する順序に対応する。

| 画面 / 状態 | 再現手順 | fixture | 画像 light / dark | PWA ソース |
|---|---|---|---|---|
| home / empty | 新規保存領域で起動。取引を投入しない | F.now のみ | [light](home/empty-light.png) / [dark](home/empty-dark.png) | `local-monthly-dashboard.ts`, `local-ui.ts` |
| home / populated | 基本家計を登録しホーム | F.accounts, transactions, budgetYen | [light](home/populated-light.png) / [dark](home/populated-dark.png) | `local-monthly-dashboard.ts`, `record-row.ts` |
| home / budget-warning | 全体予算を20,000円へ下げ、24,730円の支出で超過を表示 | 基本家計 + F.warningBudgetYen | [light](home/budget-warning-light.png) / [dark](home/budget-warning-dark.png) | `local-monthly-dashboard.ts`, `local-monthly-budgets.ts` |
| home / attention | 予算を戻し、CSV取込後にホーム。「確認すること」3件 | 照合後 | [light](home/attention-light.png) / [dark](home/attention-dark.png) | `home-attention.ts`, `local-ui.ts` |
| records / populated | 照合後に記録タブ。日付ごとの一覧 | 照合後 | [light](records/populated-light.png) / [dark](records/populated-dark.png) | `records-list.ts`, `record-row.ts`, `local-ui.ts` |
| records / search | 検索を開き「スーパーみどり」で検索。2件 | 照合後 + F.searchKeyword | [light](records/search-light.png) / [dark](records/search-dark.png) | `local-transaction-search-ui.ts`, `records-list.ts` |
| entry / expense | 追加→支出を手入力 | 照合後、未入力 | [light](entry/expense-light.png) / [dark](entry/expense-dark.png) | `local-ui.ts`, `entry-form.ts` |
| entry / income | 追加→収入 | 照合後、未入力 | [light](entry/income-light.png) / [dark](entry/income-dark.png) | `local-transaction-ui.ts`, `entry-form.ts` |
| entry / transfer | 追加→口座間の振替 | 照合後、未入力 | [light](entry/transfer-light.png) / [dark](entry/transfer-dark.png) | `local-transaction-ui.ts`, `entry-form.ts` |
| entry / category-sheet | 支出入力→すべてのカテゴリから選ぶ | 照合後のカテゴリ使用履歴 | [light](entry/category-sheet-light.png) / [dark](entry/category-sheet-dark.png) | `category-picker.ts`, `local-ui.ts` |
| entry / recurrence | 支出入力で「くり返し」を毎月にする。未保存 | 照合後、当日の日付 | [light](entry/recurrence-light.png) / [dark](entry/recurrence-dark.png) | `entry-form.ts`, `entry-recurrence.ts`, `local-ui.ts` |
| receipt / initial | 新規家計にカードを追加し、合成写真を選択。AI実行前 | F.accounts[0], receipt（写真） | [light](receipt/initial-light.png) / [dark](receipt/initial-dark.png) | `local-ui.ts`, `local-receipts.ts` |
| receipt / ai-loading | AIで読み取る→Gemini応答を保留 | 同上 + 固定session/AI mock | [light](receipt/ai-loading-light.png) / [dark](receipt/ai-loading-dark.png) | `receipt-reading-progress.ts`, `local-ui.ts` |
| receipt / ai-result | 応答を解放し、カテゴリ分類完了後にカードを選ぶ | F.receipt の抽出値・固定Jev回答 | [light](receipt/ai-result-light.png) / [dark](receipt/ai-result-dark.png) | `local-ui.ts`, `local-receipts.ts` |
| receipt / items-tab | 品目一覧へ切替。7品目とカテゴリ別小計 | 同上 | [light](receipt/items-tab-light.png) / [dark](receipt/items-tab-dark.png) | `local-ui.ts`, `category-picker.ts` |
| reconciliation / empty | 新規保存領域で照合タブ | F.now のみ、明細なし | [light](reconciliation/empty-light.png) / [dark](reconciliation/empty-dark.png) | `local-ui.ts`, `reconciliation-ui.ts` |
| reconciliation / needs-review | 合成CSVを取込。要確認1件・記録なし2件・一致4件 | 照合後 | [light](reconciliation/needs-review-light.png) / [dark](reconciliation/needs-review-dark.png) | `local-ui.ts`, `local-reconciliation.ts`, `reconciliation-ui.ts` |
| reconciliation / matched | 同じ画面の「一致した内容を見る（4件）」を展開 | 照合後 | [light](reconciliation/matched-light.png) / [dark](reconciliation/matched-dark.png) | `local-ui.ts`, `reconciliation-ui.ts` |
| recurring / initial | 設定→定期登録。未保存なので一覧は空 | 照合後、定期登録なし | [light](recurring/initial-light.png) / [dark](recurring/initial-dark.png) | `local-recurring-ui.ts` |
| budget / initial | 設定→予算設定。毎月の基本予算80,000円 | 照合後 + F.budgetYen | [light](budget/initial-light.png) / [dark](budget/initial-dark.png) | `local-monthly-budgets.ts` |
| masters / initial | 設定→カテゴリ。支出カテゴリ一覧 | 照合後 | [light](masters/initial-light.png) / [dark](masters/initial-dark.png) | `local-master-ui.ts` |
| settings / initial | 設定タブ→入口一覧 | 照合後 | [light](settings/initial-light.png) / [dark](settings/initial-dark.png) | `main.ts`, `settings-ui.ts`, `local-ui.ts` |
| contact / initial | 設定→お問い合わせ。送信しない | 照合後、問い合わせ未入力 | [light](contact/initial-light.png) / [dark](contact/initial-dark.png) | `contact-ui.ts` |
| backup / initial | 設定→バックアップと復元。書出し前 | 照合後 | [light](backup/initial-light.png) / [dark](backup/initial-dark.png) | `local-backup-ui.ts`, `main.ts` |
| payroll / initial | 収入→AIで簡単入力→合成給与写真を選択。マスキング画面 | 照合後 + F.payroll（写真） | [light](payroll/initial-light.png) / [dark](payroll/initial-dark.png) | `payroll-ui.ts`, `local-transaction-ui.ts` |
| device-link / initial | 設定→ほかの端末と同期。開始前ダイアログ | 照合後、同期履歴なし | [light](device-link/initial-light.png) / [dark](device-link/initial-dark.png) | `device-link-ui.ts` |
| moneyforward / initial | 設定→バックアップと復元→マネーフォワードから移行。CSV選択前 | 照合後、MF CSV未投入 | [light](moneyforward/initial-light.png) / [dark](moneyforward/initial-dark.png) | `moneyforward-ui.ts` |

`matched` は PWA に実在する一致履歴の展開状態であり、要確認明細を架空に消した画面ではない。同期はランダムな接続コードを生成する前、給与はAI送信前、MF移行はファイル選択前を基準にした。それぞれ依頼された画面の初期状態を撮影しており、同期接続後・給与抽出後・MF取り込み後の追加状態は本PRの対象に含めない。

主要操作と共通 identifier は [flows.md](flows.md) を参照。
