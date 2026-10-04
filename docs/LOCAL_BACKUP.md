# 端末内データのバックアップと復元

KakeiMatch PWAは、Actual Budgetの家計簿とKakeiMatchの端末内記録・残っている原本を1つの `.kmb` ファイルへ書き出します。復元では新しい端末内profileとActualの保存先を用意し、両方の読み戻しを確認した後で現在の家計データを切り替えます。[実装: `local-backup.ts`](../apps/pwa/src/local-backup.ts) [実装: `local-backup-format.ts`](../src/lib/local-backup-format.ts)

## ファイル形式と上限

`.kmb` はKakeiMatch独自の非圧縮・非暗号化containerです。format version 1のmanifestと、Actual Budget ZIP、schema version 2の端末記録JSON、存在する画像・CSV原本を別entryとして格納します。manifestにはentry path、用途、size、SHA-256値と原本のmetadataを記録し、原本が欠けていればmissingとして表現します。SHA-256値はファイル破損の検出に使います。改ざん検知や暗号化を行うものではありません。[実装: `local-backup-format.ts`](../src/lib/local-backup-format.ts)

外側containerの制限は次のとおりです。

| 対象 | 上限 |
| --- | ---: |
| entry全体の合計サイズ | 256 MiB |
| 1 entryのサイズ | 128 MiB |
| 端末記録JSON | 64 MiB |
| manifest | 2 MiB |
| manifest内entry数 | 10,000 |

Actual ZIP entryは外側形式の制限により圧縮後128 MiBまでです。Actualの公式 `@actual-app/api` 26.9.0はZIP読み込み時にarchive、単一entry、展開後合計それぞれ500 MiBを上限とします。このため圧縮率の高いActual ZIPは最大500 MiBまで展開される場合があります。[Actual API package (26.9.0), `dist/index.js`: `MAX_ZIP_SIZE` / `safeUnzip`]

entry sizeとentry数はファイルを読み込む前に検査します。生成と検証ではBlobをentry単位に処理し、外側containerはentry Blobを連結して作ります。JSON中のbase64で画像やCSVを複製しません。readerは未来version、未知のrecord kind/field、重複ID/path、危険なpath、schema不一致、サイズ超過、checksum不一致を拒否してからrestore層へデータを渡します。[実装: `local-backup-format.ts`](../src/lib/local-backup-format.ts)

Actualの公式APIはブラウザーbuildをexperimental featureとして説明しています。Actualのブラウザー版は家計簿をIndexedDBへ保存し、`dataDir` はworker内の仮想ファイルシステム上の保存先として使います。[Actual API (2026/09), Using the API > Using the API in a Browser]

## 書き出されるデータ

Actual Budgetの取引・口座・カテゴリはActual公式の `exportBudget()` を通してZIPへ書き出します。KakeiMatchはActualの内部データベースを直接読みません。Actual公式APIは `exportBudget()` と `importBudget()` を提供します。[Actual API Reference (2026/09), `exportBudget` / `importBudget`]

KakeiMatchのJSONには、receipt metadata、receipt extraction、category draft、merchant mapping、statement import、statement transaction、reconciliation run/result/resolution、correction audit、許可したapp settingsを保存します。残っているレシート画像と取込元CSVはJSONへbase64変換せず、別entryとして保存します。[実装: `local-backup-format.ts`](../src/lib/local-backup-format.ts)

画像またはCSV原本が既に削除されている場合、対応する家計記録は保持し、原本が欠けていることをmanifestへ記録します。原本のないレシートでは画像の再表示・再解析ができません。取込元CSVのない明細でも、保存済みcanonical明細行と照合結果は復元対象です。[実装: `local-backup-format.ts`](../src/lib/local-backup-format.ts)

KakeiMatch設定に保存しているActual `budgetId` と端末固有の `dataDir` は独自データのJSONへ含めません。Actual公式ZIP内の家計簿IDは変更せず維持します。復元時には別の保存先を使い、独自データとActual取引のID対応を維持します。Cloud account、Passkey、session、AI利用量、支払情報も含みません。家計データとCloud認証は別々の保存境界です。[実装: `local-backup.ts`](../apps/pwa/src/local-backup.ts) [実装: `local-data.ts`](../src/lib/local-data.ts)

## 書き出しと復元

書き出しは利用者が設定画面で明示的に開始します。PWAはActual ZIPと端末データを生成してから、最終書き出し生成日時を端末へ記録します。この日時はファイルをFilesなどへ保存できたことを示しません。生成した `.kmb` は利用者が端末外の安全な場所へ保存してください。ファイルは暗号化されていないため、他人に渡さないでください。[実装: `local-backup.ts`](../apps/pwa/src/local-backup.ts)

復元時はmanifest、checksum、version、entry名、件数、個別・合計サイズ、すべての端末record schemaを検証してから保存先を作ります。Actual Budgetは新しいActual `dataDir` へ読み込み、KakeiMatchのrecordと原本は新しいlocal profileへ一時復元します。両方の読み戻し確認後にだけlocal profile pointerを切り替えます。成功後も切替前のデータは端末に残り、設定画面から切替前の家計データへ戻せます。切り替えると、同じ端末の別のタブはその後の書き込みを拒否し、再読み込みを促します（[端末側の一貫性](DEVICE_SYNC.md)）。[実装: `local-backup.ts`](../apps/pwa/src/local-backup.ts) [実装: `actual-browser-ledger.ts`](../src/lib/actual-browser-ledger.ts)

復元失敗時は、現在のprofile pointerを切り替えません。復元先の後片付けに失敗した場合は、その保存先を記録します。Actualの公開APIが認識できる家計簿は、設定画面の全消去で削除を再試行できます。取り込みが家計簿IDを返す前に失敗した場合は、列挙できない残存データの可能性を否定できないため、全消去を停止します。[実装: `local-backup.ts`](../apps/pwa/src/local-backup.ts)

## 原本の整理と端末データの消去

ID返却前に失敗した不完全復元の印がある間は、新しい`.kmb`復元と単独家計簿ZIP読込も停止します。元のデータの閲覧・書き出しは続けられます。再読み込みで印を消さず、追加の一時保存先を作りません。公開APIの調査根拠と復旧手順は [不完全復元の調査](ACTUAL_RESTORE_CLEANUP.md) を参照してください。[実装: `local-backup.ts`](../apps/pwa/src/local-backup.ts)

利用者が設定画面から原本を削除できます。レシート画像はActual登録済みで確認値とActual取引IDがあるレコードだけを対象にします。CSV原本は取込情報とcanonical明細行を検証し、除外行とファイル内重複を除いた件数が保存済み明細行数と一致する場合だけを対象にします。別ファイルとの重複により保存行数が少ないCSVは、安全側に残します。削除しても確認値、明細行、照合結果、利用者判断、履歴は残ります。未確認・登録待ち・失敗・再試行待ちのレシート画像は削除対象にしません。原本の自動削除はしません。[実装: `local-data-lifecycle.ts`](../apps/pwa/src/local-data-lifecycle.ts)

「この端末の家計データをすべて削除」は、IndexedDB内の全local profile、Actualの `/documents` 保存先、アプリが追跡しているrestore保存先を削除します。Actual公式APIが認識できるbudgetは公開API経由で削除します。Cloud account、Passkey、session、AI利用権限にはアクセスしません。[実装: `local-backup.ts`](../apps/pwa/src/local-backup.ts) [実装: `actual-browser-ledger.ts`](../src/lib/actual-browser-ledger.ts)

通常の全消去では、IndexedDB内の全profile、Actualの既知budget、追跡済み復元先を削除します。復元中にActualの取り込みが家計簿IDを返す前に失敗した場合、その保存先を記録して全消去を停止します。Actual APIはその孤児budgetを列挙・完全削除できる保証がないため、アプリからの全消去を続けると削除できたように誤認させるおそれがあるためです。元の家計データのバックアップを保存したうえで、ブラウザーのサイトデータ削除を利用してください。サイトデータの削除は、このoriginに保存された他のブラウザーデータやログイン状態にも影響することがあります。この残存データの可能性を公式APIだけで否定する方法は未解決です。[実装: `local-backup.ts`](../apps/pwa/src/local-backup.ts)

## ブラウザー検証とiPhone実機確認

2026年9月30日、Chromiumで合成レシート2件と旧形式PayPay取引履歴2行を使い、Actual取引と端末記録の書き出し、新しい保存先への復元、再読込、元データへの切り戻し、破損ファイルの拒否、原本整理、原本欠損状態の再復元、ログアウト状態の全消去を確認しました。確認値、canonical明細行、照合結果、同一支出判断、組み合わせ拒否、店舗対応、設定の保存内容を比較しています。組み合わせ拒否はKakeiMatch側の合成fixtureを使用しています。[ブラウザー試験: `browser-backup.mjs`](../apps/pwa/test/browser-backup.mjs)

設定画面の390px幅の表示は[スクリーンショット](screenshots/issue-37-mobile.png)で確認できます。

同日、利用者からiPhone実機で合成レシート写真と合成CSVを入力し、それらの原本を含むバックアップの復元まで確認したとの報告がありました。利用者はそれ以外のiPhone項目も問題なかったと報告しています。機種・OS版と個別操作の記録はありません。Actualの不完全取り込みを発生させる試験や `navigator.storage.persist()` が `false` を返す場合の表示など、失敗条件別の確認結果はこの報告からは判断しません。[確認先: Issue #37 preview](https://kakeimatch-issue-37-kakeimatch-issue-37-preview.yhgry.workers.dev) [PWA確認記録: `LOCAL_FIRST_FLOW.md`](LOCAL_FIRST_FLOW.md)

## 出典

[Actual API (2026/09), Using the API] Actual Budget. “Using the API.” Actual Budget documentation. https://actualbudget.org/docs/api/

[Actual API Reference (2026/09)] Actual Budget. “API Reference.” Actual Budget documentation. https://actualbudget.org/docs/api/reference/

Actual公式APIのZIP上限と危険なentry名の検査は、導入済み `@actual-app/api` 26.9.0の `dist/index.js` 内にある `MAX_ZIP_SIZE`、`safeUnzip()`、`importBuffer()` に基づきます。依存versionは [`apps/pwa/package.json`](../apps/pwa/package.json) で確認できます。
