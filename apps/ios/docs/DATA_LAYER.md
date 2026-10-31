# iOS local-first データ層（Issue #240 Phase 7・8）

## 決定と対象

**SQLite を直接利用する。** Cloud account・session・ネットワークに依存せず、端末内の1つの家計簿を Repository protocol 経由で操作する。既存の画面移植・決定的サービス・APIクライアントとは分離する。本PRはデータ層だけであり、バックアップ画面やファイル選択UIは追加しない。

| 候補 | 今回の判断 |
| --- | --- |
| SQLite 直接利用 | 採用。Actual の既存 SQLite を読み取る境界にも同じ小さなSQLラッパーを使える。外部DB依存を増やさず、transaction・版の拒否・失敗注入を明示できる。ただしSQL・binding・migrationの保守責任を持つ |
| GRDB | SQL生成、並行処理、移行機能があり有力な候補。今回は少数のcollectionとsnapshotの保存だけに限定し、そのための依存追加を避ける。SQL検索・監視が必要になったら再検討する。[GRDB (2026/10), README] |
| SwiftData | 今回は不採用。既存のCodableドメイン型とActual SQLとの間に別の永続モデルを増やす設計を避ける。これは本アプリの境界に対する判断であり、SwiftDataの一般的な優劣ではない |

SPMで追加するのは ZIPFoundation **0.9.20固定**だけ。ZIP展開の用途に限定する。SQLite3・CryptoKit・JavaScriptCoreはSDKのものを使う。`project.yml` が正本。第三者ライセンスは `KakeiMatch/Data/Backup/Resources/ThirdPartyLicenses.txt` に同梱する。

## 保存場所とschema

```text
Application Support/KakeiMatch/
  active.json                   # current UUID / previous UUID。1回のatomic writeで切り替える
  <profile UUID>/
    household.sqlite            # Native SQLite schema version 4
```

- `objects(collection,id,ordinal,json)`：Repository用の型付きsnapshot。`id` はcollection内の格納位置で、**ドメインIDはJSON内に元の値を保持**する。配列順を維持する。現段階ではSQLで家計集計せず、読み出した作業用snapshotで既存のCRUD/集計を共有する。
- `artifacts(id,metadata,payload)`：レシート画像とCSV原本。metadataはportable manifestの情報、payloadは元のbytes。archiveのpathを端末のpathへ使わない。
- `control(id,revision)`：snapshotの世代。読み込みはtransaction内で一貫した版を取得し、保存transaction内で再検査する。別のwriterが先に保存していたら古いsnapshotの上書きを拒否する。
- `objects` の `service-state` singleton：照合の入力 snapshot・別名・候補却下・手動再確認・取消履歴、分類観測、定期の処理済み日。取引等の全 collection と同じ transaction で保存する。v2 はこの collection を追加し、table/column の追加はない。
- `objects` の `ledger-writes` singleton：削除済みの印つき取引snapshot、分割編集で除いた子、削除/Undo履歴、編集前後の履歴。`transactions` は有効取引だけのprojectionとし、削除時も完全な取引値はtombstone領域に保持する。削除印を外すUndoは同じ親・子・振替対IDを復元する。原本・確認値を捨てない。
- `objects` の `master-writes` singleton（v4）：日付付き開始残高/不正行の残高、定期設定監査・生成snapshot/取消結果、MoneyForwardの移行履歴/対応ルール。取引・明細・CSV原本の新規書き込みも同じ世代検査付きtransactionで確定する。
- `provenance(id,payload)`：検証済みの元 `manifest.json`、`local-data.json`、`actual-budget.zip`。対応済みrecord kindはすべて原形のまま保持する。**現在の家計簿のexportではない**。iOSの編集をここへ逆投影したとは扱わない。

保存時には使い捨ての作業用snapshotを変更し、`BEGIN IMMEDIATE` → 全collection更新 → `COMMIT` とする。失敗時はrollbackし、画面に成功を返さない。原本のない記録は残す。下書きレシートの削除では対応する原本も同じtransactionで削除する。SQLやファイルの例外は上位へ返す。SQLiteエラー本文や家計値はログへ出さない。

DBは暗号化していない。OSのアプリsandbox内に置き、Cloudログイン・API token・画面ロック情報を保存しない。このPRは独自の暗号化やKeychain認証を実装しない。

### 版と移行

| 境界 | 現在 | 方針 |
| --- | --- | --- |
| iOS端末DB `PRAGMA user_version` | 4 | 0から4へ作成。1/2/3→4は1つのtransactionで既存collectionを維持し、欠けている `service-state` / `ledger-writes` / `master-writes` を追加する。v3までの無日付開始残高は保存済みActual ZIPから日付を回復し、合計一致を検査して移す。provenanceがない既存基礎残高はそのまま保持する。世代とversionも一括更新。移行失敗は旧版のままrollback、5以上は非破壊で拒否する |
| `.kmb` 外側 | 1 | `KMATCHB1` + manifest長（4byte big-endian）+ UTF-8 manifest + 宣言順のentry bytes |
| portable端末記録 | 2 | `records` / `blobs`。未来版・未知kind/fieldは拒否する |
| Actual内部DB | API 26.9.0の検証範囲 | API packageから生成した59件のmigration一覧（最大1787013118115）のprefixとの一致を検証。必要なtable/columnがないDB、新しい版、未知のmigration、未対応の定期登録は明示的に拒否。内部DBのmigrationは実行しない |

将来のnative DB移行は `KMStoreDatabase` に旧版→新版の処理を追加し、構造・値・versionを1つのtransactionで更新する。破壊的な変更では新profileへの移行を使う。portable schema版を端末DB版の代わりに使わない。

PWAのrepository primitiveは旧schema 1の `entries` を2へ変換できるが、**現行 `.kmb` readerはschema 2のみを受け付ける**。iOSも同じ拒否条件とし、schema 1の `.kmb` を独自に受け付けない。旧データは対応PWAで移行・再書き出しする。[PWA (2026/10), `local-data.ts` / `local-backup-format.ts`]

## Actualと独自記録の対応

ActualのUUIDとKakeiMatchの参照IDは変更しない。金額は符号付き整数円（安全整数範囲）、日付はAsia/Tokyoのグレゴリオ暦日。時刻のある作成日時はISO8601の瞬間として保持する。

| 元の概念/記録 | native collection / 扱い |
| --- | --- |
| Actual `accounts` | `accounts`。利用終了・集計対象外・口座種類・明細サービスを保持。開始残高は基礎残高へ、通常取引と振替両側を残高へ加算 |
| `categories` / `category_groups` | `categories` / `groups`。収支区分・非表示・グループ順を維持。基本カテゴリを再生成しない |
| `payees` / mapping | `payees`。元のIDを保持。取引の支払先とカテゴリは `payee_mapping.targetId` / `category_mapping.transferId` を通す |
| `transactions` | `transactions`。`financial_id`→`importedId`、`notes`→memo。レシートの `registration.actualTransactionId`、判断の `actualTransactionId` を同じIDへ対応させる |
| 振替 | `transferred_id` で相互リンクした2行。残高には両側を反映、一覧には出金側だけ。集計からは除外 |
| 分割 | 親を1記録として返し、子を `splits` へ。親子合計・口座・日付・参照を検証。二重集計しない |
| 開始残高/不正行/削除行/集計対象外 | PWAの集計境界に合わせ、削除行はprojectionへ出さない。開始残高/不正行は月次集計へ出さず、残高だけに反映。offbudget口座と支出対象外取引は集計から除外 |
| `zero_budgets` / tracking方式の `reflect_budgets` | `native-budgets`。KakeiMatchの月次設定と分離 |
| `receipt-metadata` | `receipts`。画像のID・抽出・確認値・登録状態を保持。画像は `artifacts` |
| `statement-import` / `statement-transaction` | `imports` / `statements`。CSVも `artifacts`。CSVを再解析して行を生成しない |
| `reconciliation-run` / `reconciliation-resolution` | `runs` / `resolutions`。保存済み結果を表示する。取り込み時に照合や判断の再適用はしない |
| `payroll-record` | `payroll`。確認済み内訳だけ。給与登録時は手取りの収入取引と同じSQLite transactionで保存し、画像は持ち込まない |
| 月次予算/支出除外/口座metadata/不正利用疑い/ルール上書き/最終backup日時 | 対応するRepository snapshotへ反映 |
| 学習観測 / 照合別名・候補却下・手動再確認・取消履歴 / 定期 create 監査の全予約日（取消済みも含む） | `service-state` へ投影。元JSONもprovenanceに保持。取り込み時に照合や生成を再実行しない |
| `receipt-extraction` / `category-state` / 分類用merchant mapping / `reconciliation-result` / その他の監査・app-settings | schema検証し元JSONを `provenance` へ損失なく保存。専用サービス未接続の記録を実行済み機能と扱わない |

参照元は `src/lib/actual-browser-ledger.ts` のmapping/集計、`local-backup-format.ts` のrecord schema、導入済みActual APIのSQL/view定義。closed口座も残高計算に残す。[PWA (2026/10), Actual adapter] [Actual API (26.9.0), schema / migrate / cloud-storage]

## Home の表示集計

Home の画面は `TransactionRepository.homeDashboard(month:today:)` を1回だけ呼ぶ。戻り値の `KMHomeDashboard` に、月次snapshot（収支・予算・最近3件）、要確認の件数/一致件数/最大3行、カテゴリ内訳、予算の日の目盛りが入る。Viewは値を受け取って描画するだけで、件数・優先順・割合・目盛りを計算しない。既存の `home(month:)` はParity等の呼び出し向けに残し、`homeDashboard` が同じsnapshotに表示用集計を加える。

- 要確認: `KMHomeAttention` が `local-ui.ts` / `home-attention.ts` と同じ優先順（反映未完了→不正利用？→要確認→記録なし）で件数・一致件数・最大3行を作る。runがない場合は取込案内だけを返す。
- カテゴリ内訳: `KMHomeCategoryBreakdown` が `local-monthly-dashboard.ts` と同じ安定順、上位3件、重複しない色、「その他」、小数1桁の割合を作る。全カテゴリ一覧用の行も同じ関数の割合を使う。金額は整数円、割合のbinary64境界は `KMJSNumber`/`Decimal` で再現する。
- 日の目盛り: `KMHomeBudgetScale` が月の日数、経過日、予算に対する塗り、目安との差、超過を作る。
- カテゴリ色の名前/ハッシュ対応は Data の `KMCategoryTone` に置き、SwiftUIの色は `DesignSystem` の extension にする。Data層はSwiftUIへ依存しない。
- 純関数は `KakeiMatchCoreTests/HomeAggregationTests.swift`、両adapterの取得結果は `KakeiMatchTests/HomeDashboardTests.swift`（in-memory/SQLiteを同じ入力で実行）が検査する。

## 明細取り込みと照合の呼び出し順

`StatementRepository.importStatement` は原本・取り込み履歴・明細行を保存するAPIであり、照合runを更新しない。PWAも `LocalStatementService.importFile` では保存だけを行い、`apps/pwa/src/local-ui.ts` の送信処理がその後に `reconciliation.run()` を呼ぶ。iOSで「取り込んで照合」を再現する呼び出し側は、`importStatement` の成功後に `ReconciliationRepository.runReconciliation(id:at:)` を明示的に呼ぶ。再取り込みで追加0件でも照合を実行する。

比較テスト #294（`f0c9de5`）のCSVシナリオはiOS側でこの後半を呼んでいない。追加された `Parity CSV`（2026-10-15、4,321円）は保存されるが、比較用 `ParitySnapshot.read` は最新runの結果も有効な判断もない明細を除外する。そのため比較上は明細7件・記録なし2件のままとなる。PWAと同じ操作列にすれば保存済み明細8件・記録なし3件になる。mainへの追従だけではこの呼び出し不足は直らない。#294の再現手順に照合呼び出しを追加する必要がある。

`LocalStoreTests.statementReimportAndExplicitReconciliationPreserveAllRows` は既存の合成 `.kmb` と同じCSV入力で、保存直後の8件・旧run維持、照合後の記録なし3件、再取り込みの重複判定・再照合・SQLite再open後の保持を検査する。CSV取り込みは台帳取引の `imported_id` を生成せず、明細IDは下表のprovider由来の規則を使う。

## 書き込みの意味論（Issue #240、監査 #2〜#10・#14〜#17）

一致の基準は **KakeiMatchの画面で同じ操作をしたとき同じ結果が見えること**。ActualのDB形式・CRDT・sync自体を再実装しない。正本は `src/lib/actual-browser-ledger.ts` のcreate/updateTransaction、import/editReceipt、create/updateTransfer、delete/restoreTransactionTree、PWA側の `local-transaction-ui.ts`、`local-receipts.ts`、`local-transaction-deletions.ts`。Actual API 26.9.0の `accounts/{payees,sync}.ts`、`transactions/transfer.ts`、`db/index.ts` も確認した。以下のPWA側の操作契約はこれらの実装を根拠とし、右欄がiOS側の実装である。[PWA (2026/10), Actual adapter / local-receipts / local-transaction-deletions] [Actual API (26.9.0), accounts / transactions / db]

| 操作 | PWAから見える結果とiOSの契約 | API / 対応 |
| --- | --- | --- |
| 支払先 | 新規の通常手入力/レシートはtrim＋Actualのtitle-caseを通す。Unicode lowercase完全一致で同名masterを再利用し、元の表示名/IDを保つ。**NFKCによる統合ではない**。通常取引の編集だけPWAのNFKC・空白集約・ASCII A–Z小文字化で先に照合する。レシート編集は完全一致→Actualの同名照合 | `payee-normalization.json` はActual同梱sourceから固定生成。`KMPayeeNormalization`、`KMLedgerWrites`。新規masterは取引と一括保存 |
| 手入力の作成・再送 | 符号は支出が負、収入が正。同じimportedId・同じ画面入力は同じIDを返し二重に残高へ加算しない。異なる日付/金額/内容/category/account/memoなら既存を保持してエラー。再送ではcleared/reconciled等の読取専用状態を比較しない。成功後にmasterが閉じられた/非表示になった再送も既存値を確認して返す | `transactions.saveManual(input,id:nil)` |
| 給与明細の登録 | 勤務先・支給日・手取り・内訳を確認し、手取りだけを収入に登録する。控除から支出は作らない。安定した給与IDで再送し、収入取引と確認済み内訳snapshotを一つのSQLite transactionで保存する。失敗時は両方をrollback | `payroll.registerPayrollRecord(_:income:)`。既存Worker APIのtyped応答を検証し、画像は保存しない |
| IDのない既存取引との照合 | ActualのstrictIdCheckingどおり、同じ口座・金額・±7日・importedIdなしを対象とし、同名支払先、次に日付の近さで照合する。既存の値を優先し、画面入力とのreadbackが一致する場合だけIDを引き継ぐ。別のimportedIdがある記録は統合しない | 手入力/レシートの新規登録経路。給与/定期の明示追加は既存どおり別扱い |
| 通常取引の編集 | 種類を変えず日付・金額・支払先・category・口座・memoを更新。既存の取引ID/importedId/cleared/reconciledを保持する。分割・レシート・振替は専用経路に限定 | `saveManual(input,id:existingId)`。input.importedIdは編集では書き換えに使用しない |
| レシート登録 | 確認値から単一取引、またはcategoryごとの親＋子を作る。子はsigned円で親合計と一致、親はcategoryなし、集計/残高で二重計上しない。基本category IDはPWAと同じ名称対応で解決し、同じ実categoryへ再集約する。画像のある0円支出は単一取引、画像なし手入力は1円以上 | `receipts.registerReceipt(id:at:)`。`saveReceipt`は下書きsnapshot保存だけ。appliedは同じ結果、deletedは再登録拒否 |
| 品目・値引き・税 | 単一categoryは印字総額を優先。複数categoryは対象付き値引き→対象なし調整の金額比按分→外税を金額比按分。端数は最大剰余、同率は品目登場順。内税を二重加算しない。不明金額・不正対象・合計不一致・負のcategory小計・安全整数超過は拒否 | `KMReceiptAllocation`。UIntの全幅乗除算でTS BigIntと同じ整数商/剰余を計算し、Doubleは使わない |
| レシート編集・分割の組み替え | 同じ親ID/importedId/cleared/reconciledを維持。子IDは順番に再使用し、不足分だけ作り、余分な子はsnapshot付きの削除印として保持。通常→分割→通常を扱う。古いupdatedAtは拒否。履歴は追加し、以前の履歴を上書きしない | `receipts.editReceipt(id:value:expectedUpdatedAt:at:)`。取引・確認値・編集履歴を一括保存 |
| 振替 | 両側に相互IDを持つ対を作り、sourceだけにimportedIdを持たせる。出金/入金の符号は逆、一覧は出金だけ、両口座残高に反映、月次集計から除外。同じIDの同値再送は対を再作成せず、異値は拒否。片側IDからの編集も両側を一括更新する | `saveTransfer(input,id:nil/existingId)`。対のID・importedId・cleared/reconciledを維持 |
| 予算内外の振替category | Actualは両口座のoffbudgetが同じときcategoryを消し、境界をまたぐと元のcategoryを保持する。ただし **KakeiMatchは振替にcategoryを入力しない** ため新規も編集も両側nil。境界をまたいでも支出を作らない。Actualで作成したcategory付き振替の編集はPWA同様拒否 | 振替の全口座組み合わせ。category入力を勝手に追加しない |
| 削除 | rootと振替対、または分割の親子全体を削除印付きsnapshotとして保持。有効一覧・検索・集計・残高・使用回数から除く。関連レシートはdeletedにするが画像・品目・確認値は残す。古いexpected snapshot、不完全な対、登録/照合結果確認中は拒否 | `deleteTransaction(id:expected:at:)` → `KMTransactionDeletion`。従来の `deleteTransaction(id:)` も同じ処理 |
| Undo | 削除完了から10秒未満だけ開始でき、同じ全ID・分割配分・対リンク・照合状態・関連レシートsnapshotを復元。ID/importedIdの衝突・master消失は拒否。削除/復元履歴とtombstoneは再open・`.kmib`復元後も保持 | `transactionDeletions()`、`undoTransactionDeletion(id:at:)`。10秒ちょうどは期限切れ。toastの表示/期限管理はshellの `KMDeletionNoticeModel` が持つ |
| 明細CSV | provider由来の取引番号、なければfingerprint＋同一行ordinalで重複を判定。IDは同じJSON配列のSHA-256。口座を要求せず、台帳支出をまだ作らない。同じファイルの再取込は元のimport ID/旧accountIdを維持し、欠けた行だけ回復。番号の同じ異値明細は全体を拒否 | `statements.importStatement(data:provider:at:)`。#281 parser→原本/取込履歴/明細行を一括保存。fatal error時は原本も保存しない |
| 外部取引/imported_id | 全口座のrootを検索し、既存IDは既存値を返してスキップする（手入力の異値再送エラーとは別）。未分類はnil、新規はcleared=false。payeeは完全名→ActualのUnicode小文字一致、fuzzy照合や振替対生成をしない | `transactions.importExternalTransaction`。`addTransactions(learnCategories:false, runTransfers:false)` 相当 |
| MoneyForward | parser出力とカテゴリ/口座の一括対応を受ける。全口座のimported ID重複とファイル内重複をスキップ。±3日・同じ符号付き金額/変換後カテゴリの既存記録は統一/別登録の明示判断が必要。将来日付/振替/計算対象外/指定除外は登録しない。新規masterは同名を再利用、未設定口座は「移行元未設定」 | `previewMoneyForward` → `importMoneyForward(id:rows:mappings:choices:rememberMappings:at:)`。原CSVは保存しない。batch履歴には対応ルールと元の空欄内容を保持し、`rememberMappings` がtrueの場合だけ次回用ルールにも保存する。失敗時は全体rollback、同じbatch IDで再送できる |
| MoneyForward取消 | 今回createdの取引IDだけ削除（後日の編集も削除対象）。duplicate/統一先の既存取引は残す。追加した口座/カテゴリ/対応ルールは残す | `undoMoneyForward(id:at:)`。現在のroot/対/分割を既存の削除経路で削除印にする |
| 口座作成・残高 | 名前/種類を保存しtransfer payeeを作る。開始残高は一覧/月次収支に出さず残高だけに反映。現在残高は**日本時間の今日まで**の取引＋日付付き基礎残高。振替の両側も加算し、分割を二重加算しない | `createAccount(_:startingBalanceYen:startingDate:)`（PWA通常フォームは0円）。`accounts(asOf:includeClosed:)` は固定時計の検証用、通常の `accounts` は今日を使う |
| 口座終了・再開・削除 | 利用終了は現在残高と全日付残高が0円の場合だけ。空口座も消さずclosedにする。再開は同じID。完全削除は有効取引/開始残高行なし・残高0円だけ。名称/種類変更で残高を上書きしない | `saveAccount` のclosed遷移、`deleteAccount`。Actual `closeAccount` 内部の全日付残高条件も確認。操作直前のsnapshotを検査 |
| カテゴリ/グループ | 追加/名前変更/並び替え/非表示/再表示。カテゴリ追加は同じ収支区分の利用中グループを再利用し、なければ作る。グループhiddenを選択可否に反映。使用中カテゴリは未来日/閉口座/分割子も調べ、削除せず非表示を案内 | `saveCategory` / `saveCategoryGroup` / `reorderCategories` / `reorderCategoryGroups`。使用中は `deleteCategory` を拒否。空でないグループの削除も拒否。グループ編集/任意並び替えはPWA画面にはなく、Repository管理操作のみ |
| 照合確定・取消 | 同じ支出は金額/clearedだけを更新し、ID/importedId/カテゴリ/品目/メモ/reconciledを保持。分割の金額変更は拒否。未記録支出/振替は手入力/振替と同じpayee・対生成経路を通し出金側をclearedにする。取消は変更前の金額/clearedへ戻し判断履歴を残す | `Data/Ledger/KMLedgerReconciliation` と `storeReconciliation`。判断エンジンの結果を作業用copy上で既存台帳APIへ適用し、SQLiteでは取引/判断/履歴を一括保存 |
| 定期設定・自動実行 | 固定額の毎月/毎週/毎年、カテゴリ/口座/開始日/自動登録。名前の重複と未対応予定の編集を拒否。編集は過去取引を変更せず、設定削除も生成済み取引を残す。家計簿を開く際の明示呼出しで到来分を処理（バックグラウンドtimerなし）。保存時に自動処理する従来APIも維持 | `saveRecurring(_:at:)` は保存後に到来分も処理する。画面用 `saveRecurringForCatchUp(_:at:)` は定期設定と次回日だけを保存する。`runRecurring(through:at:)` は家計簿を開いた時/復元後に呼び、従来どおり到来分を処理する |
| 定期の追いつき登録・取消 | 選択日とmasterを再検査、安定imported IDで明示追加。**同じ内容の独立した手入力は統合も削除もしない**。日別snapshotを保存し、一括取消は未編集分だけ削除、編集済みはretainedとして残す。比較はPWAのnative取引snapshotに合わせ、カテゴリ/支払先の表示名変更と別保存の支出集計除外だけでは編集済みにしない。選択削除は古いsnapshotなら全体拒否。削除後も処理済み日を維持し自動再生成しない | `previewRecurringCatchUp(_:through:)` で計画を計算し、当月選択はAsia/Tokyoの`KMDate`から導く。`catchUpRecurring` / `recurringGenerations` / `undoRecurringGeneration(id:dates:at:)` を使う。自動登録OFFでも追いつき登録可能。SQLiteは操作単位でatomicに保存するため、PWAの永続pending/retry intentは持たない。既存 `recurringOccurrences` は旧DB/portableの消費済み日を含む |

### 意図的に対象外としたActual内部挙動

- Actual画面でしか作成できないtransaction/payee rule、categoryの自動学習rule、schedule ruleの高度な条件（可変金額/終了条件/休日調整等）の実行は対象外。[Actual API (26.9.0), accounts/sync / transactions/transaction-rules] KakeiMatchの分類学習とは別物で、通常画面から設定できないため。本PRはこれらが存在するActual家計簿での書き込み結果一致を保証しない。元のruleは取り込みprovenanceに残す。
- CRDT、同期メッセージ、Actualのsort_order・APIイベント・内部table配置は画面結果に不要なため再現しない。削除済み取引は独自の `ledger-writes` に保存し、active projectionから除く。Actual DBを再生成できるという意味ではない。
- PWAはActual/IndexedDBの別保存先を更新するのでprocessing/failed intentと再起動回復が必要。iOSは1つのSQLite transactionで成功かrollbackになるため、中間intentの再実行を追加しない。読み戻し不一致・SQL失敗は全体をrollbackする（Actual側だけ更新されたPWAの内部的な途中状態は再現しない）。
- Actual Schedule/RuleのDB再生成・高度な条件（可変金額/終了条件/休日調整/複数条件）の実行は対象外。`.kmb` 取り込みでは、PWAが作成・編集できる基本形（payee/account/date/amountの4条件、`link-schedule`、`set category`、毎月/毎週/毎年・interval 1・endMode never）の有効scheduleだけをnative定期へ投影する。複雑なrule、名前のないschedule、閉口座・非表示カテゴリを参照するscheduleは取り込み全体を明示拒否し、元PWAを保持する。`schedules_next_date` が古い/欠けている場合は、既存の生成取引（`schedule`列または `kakeimatch:schedule:<id>:<date>` のimported ID）を処理済み日として登録し、最後の生成日の翌日以降へ次回日を進める。これにより取り込み直後の `runRecurring` がPWA生成済みの日を二重生成しない。旧portable定期監査は処理済み日として保持するが、旧生成snapshotの取消UIへの投影は未接続。
- MoneyForwardのPWA `settings:moneyforward-import` は、完了・部分完了・取消途中・取消済みのbatchと対応ルールをnativeの `moneyForwardHistory` / `moneyForwardRules` へ投影する。`planned`/`processing`/`undoing` と `pending`/`importing`/`failed` 行はPWA側で状態が動いているため投影しない。`created` 行でも、PWAのsnapshotのID・imported IDとnativeの取引のimported IDが一致する場合だけ削除対象のsnapshotを保持する。duplicate/excluded、対象取引が消えている行、IDが食い違う行は削除対象を持たないため、`undoMoneyForward` はPWA由来でない取引を消さない。元recordはprovenanceに保持する。
- 比較テスト担当の `test/ios-pwa-parity` / `KakeiMatchTests/Parity` は変更しない。単体テストは画面接続やPWA実行との総合比較完了を意味しない。

`LedgerWriteTests` は両adapterの同じ入力で登録・編集・再送・衝突・削除Undo・再open・SQLite失敗rollback・v2→v3・native backupを検査する。`ReceiptAllocationTests` は `src/lib/local-receipts.test.ts` の按分入力/期待値を移植し、64bit積を超える金額の端数処理も検査する。支払先規則の再生成は依存導入後 `node apps/ios/scripts/generate-payee-normalization.mjs`。Actualライセンスは `Data/Ledger/ActualLicense.txt` に同梱する。

## `.kmb` 取り込みと互換性

呼び出し口：`try await repositories.localStore?.importBackup(from: fileURL)`。これはUI操作ではない。呼び出し側は利用者の確認・security-scoped URLの取得/解放・エラー表示・表示snapshotの再取得を担当する。元に戻す操作は `returnToPreviousProfile()`。端末の外観選択は取り込み・切り戻しで引き継ぎ、バックアップの設定で上書きしない。原本は `originalArtifact(id:)`、画像は既存の `ReceiptRepository.receiptImage(blobId:)` で取得する。

1. regular fileの全長と12byte headerを検査する。
2. manifestの厳密schema・version・entry件数・全path/宣言sizeを検査する。payloadを読む前に上限を検査する。
3. entry順・長さ・SHA-256・末尾余剰・必須entry・raw manifestの一対一対応を確認する。
4. portable JSONをPWAと同じZod strict schema/refinementで検査する。未知kind/field、重複ID、nullable必須キーの欠落、未来版、口座/予算scope不一致等を拒否する。SwiftのCodableだけで検証済みとしない。
5. 原本ID・owner・contentType・サイズ・SHA-256とmissing manifestの順序を検証する。
6. 新しいUUIDのprofileへActual ZIPを展開し、SQLiteをreadonlyで検査・projection化する。ZIPの全entry名/重複/展開sizeを事前検査し、symlinkは拒否する。出力先は固定名に限定し、展開中の実サイズとCRC32も確認する。
7. 新profileのDBに保存し、全projectionと原本bytesを読み戻す。両方の成功後だけ `active.json` をatomicに置き換える。
8. 失敗時はpointerを変更せずstagingを削除する。削除にも失敗した場合はその事実を返す。成功前のprofileは削除せず、元に戻す操作で切り替えられる。

### 上限

TSと同じ外側上限：manifest 2 MiB、端末記録64 MiB、entry 128 MiB、entry合計256 MiB、最大10,000 entries、record＋blob最大10,000。raw metadataの配列もそれぞれ最大10,000。pathは256文字以内の小文字ASCII安全path。Actual ZIPの展開合計/単一entryは500 MiBまで。[PWA (2026/10), portable format] [Actual API (26.9.0), `safeUnzip`]

追加の安全側制約：Actual ZIPのentry数10,000、metadata 2 MiB、symlink拒否、未対応のActual DB/定期登録の拒否、明示的にJPY以外の `defaultCurrencyCode` が設定された家計簿の拒否。通貨設定がないPWAの `.kmb` は整数円のportable契約に従う。PWAで読める全Actual ZIPを受け付けるとは主張しない。

### スキーマ共有の生成

`node apps/ios/scripts/generate-backup-validator.mjs` で、referenceの `manifestSchema` と `validateLocalData` を依存するZod/refinementごとbundleする。実行にActual engine・ブラウザー・ネットワークは不要。生成物と入力SHA-256一覧をコミットする。JavaScriptCoreへ渡すのはJSON文字列だけで、取り込みデータをプログラムとして評価しない。

TS側のスキーマが変わったら再生成し、migration fixtureと拒否テストを確認する。PWAの既存ソースは変更しない。別担当の決定的サービスがこれらの独自記録を扱う際は、元JSONから対応するprojectionを追加する。

## iOSバックアップの書き出し・復元

利用者決定（2026-10-26）により、**iOSからPWAへ戻す書き出しは提供しない**。PWAからiOSへの移行は従来どおり `.kmb` 取り込みを使う。機種変更・再インストール・誤操作からiOSの変更を守るため、iOS同士で復元できる専用バックアップを追加する。

### iOS専用形式 `.kmib`

`.kmib` は非圧縮・非暗号化の独自containerで、PWA `.kmb` と別形式である。先頭magicは `KMIOB001`、manifestの `format` は `kakeimatch-ios-native-backup`、format versionとmanifestのschemaVersionは1（containerのschema）、内部SQLiteのuser_versionは4。旧DBのversion 1/2/3は復元時に移行する。PWA `.kmb` は従来どおり `KMATCHB1`、`.kmb`、portable schema version 2を使う。どちらも拡張子だけでなくmagicを検査し、iOS readerはmagicにより`.kmb`を既存のPWA取り込みへ、`.kmib`をnative復元へ振り分ける。PWA readerが`.kmib`を`.kmb`として受理することはない。

manifestには生成日時と各entryのpath・size・SHA-256を含める。`household.sqlite` は稼働中のSQLite接続上で `VACUUM INTO` を実行して作った一貫したDB snapshotである。レシート画像・CSV原本も `artifacts/` entryとして同梱し、DB内の原本との対応を復元時に照合する。snapshotと原本は同一snapshot DBから取得する。format/schemaの未来版、未知manifest field、危険なpath、重複path、size/checksum/lengthの不一致、上限超過、余分なpayloadを拒否する。上限はmanifest 2 MiB、entry 128 MiB、entry合計256 MiB、最大10,000 entries。暗号化・改ざん検知は行わず、SHA-256は破損検出用である。ファイルを他人へ渡さないよう画面で案内する。

`try await repositories.localStore?.exportNativeBackup()` は一時 `.kmib` のURLを返す。共有シートやFilesへの保存は画面側の責任である。生成日時は設定へ記録するが、利用者がファイルを保存できたことを意味しない。復元は専用manifestとDB schemaを検証した後、新profileへsnapshotをstageし、全collection・原本の読み戻しとfingerprint検証に成功した場合だけprofile pointerを切り替える。失敗時は現profileを保持し、成功後も従来の `returnToPreviousProfile()` で戻せる。

iOSバックアップはPWAへ取り込めない。PWAからiOSへは既存の `.kmb` 取り込みを継続する。PWAへの一方向の移行と、iOS間の保護用バックアップを混同しない。

## 検証・既知の制約・後続への申し送り

- `LocalStoreTests`：再open後のCRUD/設定/残高、SQLite triggerによる途中失敗とrollback、0→4の作成・1/2/3→4移行・未来版の非破壊拒否、実際のPWA生成 `.kmb` の移行、破損・未知kind/field・path・サイズ・旧portable版・nullable必須キー等の拒否、Actual未来版/非円通貨/複雑な定期登録/不正分割のstaging失敗と既存データ保持。原本欠損の許可、振替/分割/開始残高/offbudget/旧native予算のprojection、ZIP traversal/symlink拒否も確認する。基本形scheduleの投影・PWA生成済み日の処理済み登録・古い次回日からの二重生成防止・複雑なscheduleの拒否、PWA MoneyForward履歴の投影と作成行だけの取消も、SQLiteとin-memoryの両方で確認する。
- 共通fixtureはPR #279の合成データ。`synthetic.kmb` には `fixture.json` の11取引に加えて画像付きレシート登録分2,138円があり、12取引・支出26,868円になる。レシートは登録済み11＋空下書き1、明細7、照合一致4/要確認1/記録なし2、予算80,000円を確認する。fixtureの7品目は `.kmb` では確認値に保存されていないため、品目を捏造しない。
- 通常起動だけpersistentへ注入する。Debug `-UITestFixture` とPreviewは従来のin-memoryで、利用者のDBへ触れない。
- 閲覧・既存Repositoryの保存/検索/集計/復元はオフライン。AI抽出/分類、Cloud認証、問い合わせは別のAPI境界。ログアウトやアカウント削除からこのDBを消さない。
- 照合の7操作は `KMSQLiteStore` から共通ドメイン処理へ委譲する。取引・口座・判断と `service-state`（prepared snapshot、別名、却下、手動確認、取消履歴）を一括保存する。SQLite失敗は全体をrollbackするため、外部Actual I/Oのprocessing状態からの回復とは異なる。
- 学習観測はレシートID単位で置換し古い確認時刻を無視する。ルールは保存履歴から導出する。定期補完は選択日・masterを検証し、安定登録IDの取引と処理済み日を同時保存する。取引を削除しても処理済み日は残す。
- 旧v1/portable runにはSwiftのprepared snapshotがない。結果・判断は維持するが、次の判断には再照合を要求する。TSのfingerprintをSwiftで有効と推測しない。
- `MasterWriteTests`：両adapterで明細再取込/欠損行回復、全口座imported ID重複、開始残高/未来日cutoff、空口座close→reopen、使用中カテゴリ削除拒否/グループhidden、MoneyForward候補確認/重複/所有取引限定取消、定期自動登録/複数設定の編集保持/独立手入力保持/編集行保持取消/表示名変更後の取消、照合の同一台帳経路/取消/振替対と両口座残高、v3→v4失敗rollback、CSV原本と移行/定期履歴のSQLite失敗rollback/backup復元後の取消を検査する。
- レシート画像の新規保存、レシート確認時の学習呼出し、Actual Schedule/Ruleの高度な条件の実行は後続。`.kmb` の基本形scheduleと旧PWAのMoneyForward履歴は取り込み時に投影済み。レシートの台帳登録/編集、取引削除Undoは上記専用APIを使う。
- I/O・検証は現段階でMainActor直列。busy中の再入要求はエラーとし、自動再試行しない。大容量での実機メモリ/応答性、アプリ強制終了/容量不足、複数scene/process間の排他は未検証。API/同期の統合前に専用I/O actorと家計簿lockを導入する。UIのprogressだけで非同期化済みとしない。
- backupUIはエラーを表示し、復元成功後は全snapshotを再取得する。端末間同期はこのprofile切替を使い、受信全体hash・session所有権・元version・利用者同意を上位で検証する。JSONやSQLだけを直接上書きしない。
- nativeのraw provenanceは監査/後続projection用。iOS編集後の正本と混同しない。端末からの全削除/原本整理は認証情報と分離して別途実装する。

## 参照資料

[PWA, 2026/10] KakeiMatch. [`local-backup-format.ts`](../../../src/lib/local-backup-format.ts)、[`local-backup.ts`](../../../apps/pwa/src/local-backup.ts)、[`local-data.ts`](../../../src/lib/local-data.ts)、[`Actual adapter`](../../../src/lib/actual-browser-ledger.ts)。入力hashは `backup-validator-sources.txt`。

[Actual API, 26.9.0] Actual Budget. 導入済み `@actual-app/api/dist/index.js` の `loot-core/src/server/{schema,cloud-storage,util/zip,migrate/migrations}.ts`、同bundleのSQL migration群。https://github.com/actualbudget/actual

[GRDB, 2026/10] GRDB.swift. “README / What is GRDB?” https://github.com/groue/GRDB.swift

[ZIPFoundation, 0.9.20] Thomas Zoechlingほか. “Archive+Reading.swift / Entry.swift.” https://github.com/weichsel/ZIPFoundation/tree/0.9.20
