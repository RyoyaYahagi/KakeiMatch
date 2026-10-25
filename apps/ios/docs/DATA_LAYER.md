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
    household.sqlite            # Native SQLite schema version 1
```

- `objects(collection,id,ordinal,json)`：Repository用の型付きsnapshot。`id` はcollection内の格納位置で、**ドメインIDはJSON内に元の値を保持**する。配列順を維持する。現段階ではSQLで家計集計せず、読み出した作業用snapshotで既存のCRUD/集計を共有する。
- `artifacts(id,metadata,payload)`：レシート画像とCSV原本。metadataはportable manifestの情報、payloadは元のbytes。archiveのpathを端末のpathへ使わない。
- `control(id,revision)`：snapshotの世代。読み込みはtransaction内で一貫した版を取得し、保存transaction内で再検査する。別のwriterが先に保存していたら古いsnapshotの上書きを拒否する。
- `provenance(id,payload)`：検証済みの元 `manifest.json`、`local-data.json`、`actual-budget.zip`。対応済みrecord kindはすべて原形のまま保持する。**現在の家計簿のexportではない**。iOSの編集をここへ逆投影したとは扱わない。

保存時には使い捨ての作業用snapshotを変更し、`BEGIN IMMEDIATE` → 全collection更新 → `COMMIT` とする。失敗時はrollbackし、画面に成功を返さない。原本のない記録は残す。下書きレシートの削除では対応する原本も同じtransactionで削除する。SQLやファイルの例外は上位へ返す。SQLiteエラー本文や家計値はログへ出さない。

DBは暗号化していない。OSのアプリsandbox内に置き、Cloudログイン・API token・画面ロック情報を保存しない。このPRは独自の暗号化やKeychain認証を実装しない。

### 版と移行

| 境界 | 現在 | 方針 |
| --- | --- | --- |
| iOS端末DB `PRAGMA user_version` | 1 | 0（未作成/空DB）から1へtransaction内で作成。既存の不正な構造は作り直さない。2以上は更新案内を返し、家計操作を開始しない |
| `.kmb` 外側 | 1 | `KMATCHB1` + manifest長（4byte big-endian）+ UTF-8 manifest + 宣言順のentry bytes |
| portable端末記録 | 2 | `records` / `blobs`。未来版・未知kind/fieldは拒否する |
| Actual内部DB | API 26.9.0の検証範囲 | 同梱fixtureのmigration最大値1787013118115まで。必要なtable/columnがないDB、新しい版、未対応の定期登録は明示的に拒否。内部DBのmigrationは実行しない |

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
| `payroll-record` | `payroll`。確認済み内訳だけ。画像は持ち込まない |
| 月次予算/支出除外/口座metadata/不正利用疑い/ルール上書き/最終backup日時 | 対応するRepository snapshotへ反映 |
| `receipt-extraction` / `category-state` / `merchant-mapping` / `reconciliation-result` / `correction-audit` / その他許可済みapp-settings | schema検証し元JSONを `provenance` へ損失なく保存。専用サービスのprojection/APIへは未接続。カテゴリ学習・判断適用・定期登録をこのPRで実行しない |

参照元は `src/lib/actual-browser-ledger.ts` のmapping/集計、`local-backup-format.ts` のrecord schema、導入済みActual APIのSQL/view定義。closed口座も残高計算に残す。[PWA (2026/10), Actual adapter] [Actual API (26.9.0), schema / migrate / cloud-storage]

## `.kmb` 取り込みと互換性

呼び出し口：`try await repositories.localStore?.importBackup(from: fileURL)`。これはUI操作ではない。呼び出し側は利用者の確認・security-scoped URLの取得/解放・エラー表示・表示snapshotの再取得を担当する。元に戻す操作は `returnToPreviousProfile()`。原本は `originalArtifact(id:)`、画像は既存の `ReceiptRepository.receiptImage(blobId:)` で取得する。

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

## iOS → PWA書き出しの調査結果

**今回は `.kmb` 書き出しを実装しない。** ZIPを作ること自体は可能だが、native snapshotをActual内部DBとして安全に再構成したとは保証できない。

調査したActual API 26.9.0では、`exportBuffer()` は `db.sqlite` のcacheを除き、`metadata.json` に `resetClock=true` を付けてZIP化する。`importBuffer()` はこの2entryを同じdirectoryから取得し、家計簿を開く際にmigration一覧の一致、mapping、rule、CRDT clock等を処理する。`resetClock` はnode IDの更新であり、native snapshotを正しいActual DBへ変換するAPIではない。[Actual API (26.9.0), `exportBuffer` / `importBuffer` / `checkDatabaseValidity` / `loadClock`]

iOSのprojectionだけから、未対応のrule/schedule・migration・削除履歴・mapping・CRDTの整合性を作り直すのは危険である。元ZIPを返すだけではiOSの編集が消え、成功したように見えるため、その「書き出し」も提供しない。

当面の代替は **元のPWAと `.kmb` を外部へ保管し、iOS→PWAへ戻す用途には元バックアップを使う**こと。iOSの新規変更はそれに含まれない。後続でActual公式APIを使う変換経路（native snapshot→検証済み公式API→exportBudget→PWA復元E2E）を別途実装・検証する必要がある。同期も現段階では受信のstaging/切替だけを再利用可能で、相互同期が完成したとは扱わない。

## 検証・既知の制約・後続への申し送り

- `LocalStoreTests`：再open後のCRUD/設定/残高、SQLite triggerによる途中失敗とrollback、0→1の作成・未来版の非破壊拒否、実際のPWA生成 `.kmb` の移行、破損・未知kind/field・path・サイズ・旧portable版・nullable必須キー等の拒否、Actual未来版のstaging失敗と既存データ保持。
- 共通fixtureはPR #279の合成データ。`synthetic.kmb` には `fixture.json` の11取引に加えて画像付きレシート登録分2,138円があり、12取引・支出26,868円になる。レシートは登録済み11＋空下書き1、明細7、照合一致4/要確認1/記録なし2、予算80,000円を確認する。fixtureの7品目は `.kmb` では確認値に保存されていないため、品目を捏造しない。
- 通常起動だけpersistentへ注入する。Debug `-UITestFixture` とPreviewは従来のin-memoryで、利用者のDBへ触れない。
- 閲覧・既存Repositoryの保存/検索/集計/復元はオフライン。AI抽出/分類、Cloud認証、問い合わせは別のAPI境界。ログアウトやアカウント削除からこのDBを消さない。
- 既存protocolにないレシート画像の新規保存、明細インポートの書き込み、照合判断の適用/取消、削除Undo、定期実行/分類学習は後続サービスの責任。読み取りだけのrecordを動作済み機能と説明しない。
- I/O・検証は現段階でMainActor直列。busy中の再入要求はエラーとし、自動再試行しない。大容量での実機メモリ/応答性、アプリ強制終了/容量不足、複数scene/process間の排他は未検証。API/同期の統合前に専用I/O actorと家計簿lockを導入する。UIのprogressだけで非同期化済みとしない。
- backupUIはエラーを表示し、復元成功後は全snapshotを再取得する。端末間同期はこのprofile切替を使い、受信全体hash・session所有権・元version・利用者同意を上位で検証する。JSONやSQLだけを直接上書きしない。
- nativeのraw provenanceは監査/後続projection用。iOS編集後の正本と混同しない。端末からの全削除/原本整理は認証情報と分離して別途実装する。

## 参照資料

[PWA, 2026/10] KakeiMatch. [`local-backup-format.ts`](../../../src/lib/local-backup-format.ts)、[`local-backup.ts`](../../../apps/pwa/src/local-backup.ts)、[`local-data.ts`](../../../src/lib/local-data.ts)、[`Actual adapter`](../../../src/lib/actual-browser-ledger.ts)。入力hashは `backup-validator-sources.txt`。

[Actual API, 26.9.0] Actual Budget. 導入済み `@actual-app/api/dist/index.js` の `loot-core/src/server/{schema,cloud-storage,util/zip,migrate/migrations}.ts`、同bundleのSQL migration群。https://github.com/actualbudget/actual

[GRDB, 2026/10] GRDB.swift. “README / What is GRDB?” https://github.com/groue/GRDB.swift

[ZIPFoundation, 0.9.20] Thomas Zoechlingほか. “Archive+Reading.swift / Entry.swift.” https://github.com/weichsel/ZIPFoundation/tree/0.9.20
