# KakeiMatch iOS の土台

Issue #240 の Phase 1・2。`apps/pwa` の baseline `pwa-swift-migration-baseline`（`ae8c9b6`）を正解とします。画面ごとの接続状況は [HANDOFF.md](HANDOFF.md) とこのREADMEの各節を参照してください。記録一覧の残件は下の「記録一覧の接続範囲」を参照してください。画面用ドメイン型、Repository protocol、メモリ上のfixture、月次集計を用意しています。通常起動は端末内SQLiteへ永続保存します。PWAの `.kmb` 取り込みと変更前profileへの切り戻しに加え、iOS専用`.kmib`の書き出し・iOS同士の復元をData層に用意しています。設定の「バックアップと復元」画面から `.kmib` の書き出しと `.kmb` / `.kmib` の復元を利用できます。iOSからPWAへの書き出しは提供しません。カメラと画面からのAPI接続は未実装です。APIクライアントの境界は [API_LAYER.md](docs/API_LAYER.md) にあります。PWA / Worker は変更しません。

## 生成・ビルド・テスト

macOS / Xcode 26以上 / XcodeGen 2.44.1以上を使います。CIと揃える場合はXcode 26.2、iPhone 17 / iOS 26.2を選びます。

ローカルでは対象を指定して `scripts/test-local.sh --only KakeiMatchTests/HomePresentationTests` を実行します。`--only` は複数指定でき、`--skip`、`--device <simulator udid>`、`--derived-data <path>`、`--no-build` も使えます。Simulator上で `KakeiMatchTests` の全suiteを実行するときは `--all` を指定してください。既定で除外するバックアップテストは `--all` で含められます。全体の成否はCIで判断します。

FoundationまたはCryptoKitだけで動く計算ロジックは、リポジトリrootで `swift test --package-path apps/ios` を実行します。iOS Simulatorの起動は不要です。Packageのdeployment targetはmacOS 15です。

```sh
brew install xcodegen
sudo xcode-select --switch /Applications/Xcode_26.2.app/Contents/Developer
swift test --package-path apps/ios
cd apps/ios
xcodegen generate
open KakeiMatch.xcodeproj

DESTINATION='platform=iOS Simulator,name=iPhone 17,OS=26.2'
xcodebuild -project KakeiMatch.xcodeproj -scheme KakeiMatch \
  -destination "$DESTINATION" -derivedDataPath DerivedData \
  build-for-testing CODE_SIGNING_ALLOWED=NO
xcodebuild -project KakeiMatch.xcodeproj -scheme KakeiMatch \
  -destination "$DESTINATION" -derivedDataPath DerivedData \
  -only-testing:KakeiMatchTests -resultBundlePath UnitTests.xcresult \
  test-without-building CODE_SIGNING_ALLOWED=NO
xcodebuild -project KakeiMatch.xcodeproj -scheme KakeiMatch \
  -destination "$DESTINATION" -derivedDataPath DerivedData \
  -only-testing:KakeiMatchUITests -parallel-testing-enabled NO \
  -resultBundlePath UITests.xcresult test-without-building CODE_SIGNING_ALLOWED=NO
xcrun xcresulttool export attachments --path UITests.xcresult --output-path /tmp/ios-screenshots
```

構成の正本は [`project.yml`](project.yml) です。Linux上でpbxprojを手書きして不整合を持ち込まないため、XcodeGenで生成する `KakeiMatch.xcodeproj` はgitignoreにしています。署名は既定で無効です。実機で使う場合はローカルの署名設定を指定してください。

[`ios.yml`](../../.github/workflows/ios.yml) はbuild jobでmacOS上のpackageテストをSimulatorなしで実行し、1回の `build-for-testing` の成果物を共有して、残りのSwift Testingと4つのUIテストshardを並列実行します。シミュレーターはバックグラウンドで起動し、テスト直前に起動完了を待って外観を設定します。最後の `ios` checkは全ジョブの成功を確認します。

UIテストは `scripts/shard-ui-tests.mjs` が `KakeiMatchUITests/*.swift` の `XCTestCase` サブクラスの `test` メソッドを自動検出し、過去の実測時間が長いメソッドから見積時間の短いshard（分割先）へ割り当てます。未計測のメソッドは30秒として扱います。各メソッドがちょうど1回割り当てられることを、ビルドジョブと各shardで検査します。新しいテストを手作業で一覧に追加する必要はありません。matrixの分割先一覧も同じ割り当て結果から生成します。

Pull Requestでは、画面を開いて参照スクリーンショットを撮るだけのテスト（`shard-ui-tests.mjs` の `screenshotOnly`）を飛ばします。mainへのpushと手動実行（`gh workflow run ios.yml --ref <branch>`）では全テストを実行し、統合した `ios-reference-screenshots` を作ります。スクリーンショット専用のテストを追加・改名したら `screenshotOnly` も直してください。一覧に存在しないテスト名があるとビルドジョブが失敗します。

artifact（CIの保存成果物）は次のとおりです。

| 名前 | 内容 | 保存期間 |
| --- | --- | --- |
| `ios-test-products` | 実行権限・シンボリックリンクを維持した `DerivedData/Build/Products` のtar。`.xctestrun` とアプリ・テストバンドルを含む | 1日 |
| `ios-build-results` | `Build.xcresult` | 14日 |
| `ios-test-results` | Simulatorで実行したSwift Testingの `UnitTests.xcresult` | 14日 |
| `ios-test-results-shard-0`〜`3` | 各shardの `UITests.xcresult` とテスト割り当て `shard-tests.txt` | 14日 |
| `ios-reference-screenshots-shard-0`〜`3` | 各shardのPNGと `manifest.json` | 14日 |
| `ios-reference-screenshots` | 全shardのPNGと統合した `manifest.json`。従来の取得手順との互換用。mainへのpushと手動実行で全テストが成功したときに作成 | 14日 |
| `parity-report` | Swift Testingの添付から集めた互換性検査のJSON。名前・形式は従来どおり | 14日 |

成功した実行では、従来どおり `gh run download <run-id> -n ios-reference-screenshots -D /tmp/ios-results` で全PNGと統合manifestを取得できます。失敗した実行のスクリーンショットは `gh run download <run-id> --pattern 'ios-reference-screenshots-shard-*' -D /tmp/ios-results` で取得できます。artifactごとのディレクトリを保ち、PNGのUUIDと画面名は同じディレクトリの `manifest.json` で確認します。manifestを上書きするため、複数shardを同じディレクトリへ展開しないでください。失敗時も各ジョブのxcresultと取得できた添付を保存します。

DEBUGビルドだけ `KM_UI_TEST_APPEARANCE=light|dark` を受け付け、UIテストでOS設定を変えずに外観を固定します。通常起動とReleaseはシステム設定に従います。

runnerの公式一覧にmacos-15 / Xcode 26.2 / iOS 26.2 / iPhone 17が掲載されていることを確認して選定しています。[runner-images (2026/10), macOS 15 / Xcode・Installed Simulators]

## 配置と後続PR

- `App/AppShell.swift`: 4タブと追加シート、入力の戻り先、通常タブの本文ScrollViewを管理。通常タブの画面ViewはVStack等で本文を返します。手入力とレシートは各入力ViewがScrollView・左右16pt・固定の登録ボタンを持ちます。標準TabView / NavigationStack / List / Formによるナビ・余白の再解釈はしません。通常タブの左右16pt・本文下32ptをshellが持ち、縦向きiPhoneではOSの上safe areaがPWAの `max(16px, safe-area-inset-top)` を満たすため16ptを重ねて足しません。下部ナビは本文と別に64pt＋OS下safe areaです。
- `Features/Records/`: 記録一覧・全期間検索・詳細・編集・削除/取り消しをRepositoryへ接続しています。画面内の表示状態は `RecordsModel.swift`、表示用の純関数は `RecordsPresentation.swift`、検索と詳細は専用Viewへ分けています。
- `Features/{Home,Reconciliation,Settings}/<Name>View.swift`: 同名Viewを保って中身を置き換えます。shellの変更は別PRで行います。
- `Features/{ManualEntry,Income,Transfer}`: 実装済みの `KMEntryFormView` を共有します。入力画面がScrollView・左右余白・固定の登録ボタンを持ちます。
- `Features/Receipt`: 撮影/写真選択、全体/品目表示、警告確認、既存画像のAI読み取りと台帳登録。画像新規保存・品目編集等の不足は [RECEIPT_SCREEN.md](docs/RECEIPT_SCREEN.md) を参照してください。キャンセルで元タブの上に追加シートを開き直します。
- `Features/RecordChooser`: PWAと同じ選択肢・文言・2列配置。中央追加は選択中タブを変えません。
- `Data`: ドメイン型・Repository protocol・集計・fixture用in-memory実装・SQLite永続化・`.kmb` reader。使い方と未実装の境界は下記と [DATA_LAYER.md](docs/DATA_LAYER.md) を参照してください。APIクライアントは別の境界として実装済みです（[API_LAYER.md](docs/API_LAYER.md)）。
- `Assets.xcassets`: `ui-icons.ts` のSVG pathをそのままtemplate imageに移植。ナビをSF Symbolsに置き換えません。AppIconはPWAの `public/icon.svg` から角のマスクを外して1024pxで生成しています。再生成はworkspace依存をインストール後に `node apps/ios/scripts/render-app-icon.mjs`（必要なら `PWA_BROWSER_PATH` を指定）。PWAファイルは変更しません。

### 共通部品のAPI

| View / 型 | 呼出し側の責任 |
| --- | --- |
| `KMBottomNavigation(selection:reviewCount:add:)` | 選択タブ、確認が必要な件数、追加操作を渡す。0件はバッジなし |
| `KMRecordRow(record:identifier:open:)` | UI専用 `KMRecordSummary` と安定ID、詳細を開く処理を渡す。DB型ではない |
| `KMAmount(yen:kind:size:)` | 整数円。kind省略は符号なし、指定時はPWA `signedAmount` と同じ規則 |
| `KMButtonStyle(role:)` | primary / secondary / text / destructive。本文の主要ボタンにはGlassを使わない |
| `KMStatusLabel` / `KMCompletedStamp` | 記号と文言で状態を伝える。成功は朱の済、要確認は藍、記録なしは紫、失敗は深紅 |
| `KMInputRow(label:value:identifier:hint:isAmount:error:)` | 入力Binding・検証結果。フォーカスの下線を部品が描く |
| `KMSegmentedControl(options:selection:identifier:)` | 安定したoption IDと選択Binding |
| `KMBottomSheet(title:isPresented:content:)` | 透明な `.fullScreenCover` 内に置く。OSがモーダルのフォーカスを隔離し、部品がPWA形状・scrim・内容に合った高さを描く。外側タップ、ヘッダ/つまみの80pt超の下スワイプで閉じる |
| `KMToast(message:actionTitle:action:)` | Undoの期限（PWAでは10秒）・処理はfeature側。部品は表示のみ |
| `KMBanner(status:title:detail:actionTitle:action:)` | 失敗理由と再試行操作を渡す |

### Token対応

CSS px → SwiftUI ptは1:1です。元ファイルは `apps/pwa/src/style.css` と `category-tone.ts`。

| PWA | iOS |
| --- | --- |
| `--bg`, `--surface`, `--text`, `--primary`, `--income` 等 | `KMColor.bg`, `.surface`, `.text`, `.primary`, `.income` |
| `--border-strong`, `--on-primary`, `--primary-press` | `.borderStrong`, `.onPrimary`, `.primaryPress` |
| `--success[-soft]`, `--warning[-soft]`, `--missing[-soft]`, `--danger[-soft]` | `.success[Soft]`, `.warning[Soft]`, `.missing[Soft]`, `.danger[Soft]` |
| `--c-food[-soft]` 等7色 | `.cFood[Soft]`, `.cDaily[Soft]`, `.cTransport[Soft]`, `.cFun[Soft]`, `.cUtil[Soft]`, `.cComm[Soft]`, `.cOther[Soft]` |
| `--scrim` | `KMColor.scrim`（light .45 / dark .6） |
| `--space-1/2/3/4/5/6/8` | `KMSpacing.space1/2/3/4/5/6/8` |
| `--radius-sm/md/lg/xl/sheet/full` | `KMRadius.sm/md/lg/xl/sheet/full` |
| `--font-body` | `KMTypography.body`: system font。PWAのiOS上の `-apple-system` と同等 |
| `--font-num` | `KMTypography.number`: system monospaced（SF Mono）、tabular数字 |
| `.page-header h2` 1.375rem / `.record-note` .8125rem / ナビ .75rem | `headingSize=22` / `noteSize=13` / `navSize=12` |
| `.entry-row .amount-input` 1.875rem / `.record-title` 500 / `.record-amount` 600 | `inputAmountSize=30` / `.medium` / `.semibold` |
| `--nav-height`, `.record-row`, `.record-icon`, `.entry-row` | `KMLayout`（64 / 60 / 36 / 52pt、safe area別） |

色は動的UIColorでlight/darkを切り替えます。全色ペアをSwift Testingで固定値と照合します。カテゴリの既知名・UInt32 wrapping hashもPWAに合わせます（未知カテゴリは現行コードに従い6色から選びます）。DESIGNにある「順番」ではなくbaseline実装が正解です。

`--shadow` / `--shadow-raised` は今回の適用先である下部ナビ・FAB・シートではLiquid GlassのOS描画に置換します。行・金額には適用しません。将来 `design-tokens.json` を正本にしてCSS/Swift両方を生成する案はありますが、現時点では生成器や共有JSONを追加しません。

## Data層と画面からの使い方

### 構成と型の約束

- `Data/Domain/`: 取引・口座・カテゴリ/グループ・支払先・レシート/品目/警告・明細・照合run/結果/判断・定期・予算・給与・分類学習・設定。各型のコメントに対応するTS型/スキーマの場所があります。
- `Data/Repositories/Repositories.swift`: 画面が依存するprotocol。下の一覧を参照してください。
- `Data/Aggregation/`: PWAの月次集計・日別グループ。予算集計は `Data/Budget/MonthlyBudgetService.swift` に委譲します。
- `Data/Ledger/`: 手入力・支払先master・振替対・レシート登録/分割編集・削除/10秒Undo・口座/カテゴリ/グループの管理・照合更新。すべて既存のsnapshot/SQLite世代検査を共有します。画面上の意味論とActual内部の対象外は [DATA_LAYER.md「書き込みの意味論」](docs/DATA_LAYER.md) を参照してください。
- `Data/{Reconciliation,CategoryLearning,Recurring,Budget}/`: TSの決定的サービス。照合採点・判断適用/取消、分類履歴の導出・適用根拠、定期日付/補完計画、予算要約を計算します。両Repository実装で同じ処理を使い、SQLiteでは取引とサービス状態を同じtransactionで保存します。採点のbinary64演算だけは `KMJSNumber` でTSの丸めを再現し、金額は整数円のままです。
- `Data/InMemory/`: 全protocolを共有する `KMInMemoryStore` と `KMFixtureLoader`。プロセス終了で全変更が消えます。通常起動では使わず、明示的なfixture/Previewだけに使います。
- `Data/Store/`: SQLite直接利用の永続化adapter。`Data/Backup/`: manifest/record strict検証、SHA-256、Actual ZIPのreadonly取り込み、staging/切替。設計・対応記録・書き出しを保留する理由は [DATA_LAYER.md](docs/DATA_LAYER.md) を参照してください。
- `App/KMRepositories.swift`: **依存注入点はここだけ**です。同じ家計簿の各Repositoryをまとめ、`EnvironmentValues.repositories` で渡します。未注入時はnilで、暗黙のサンプルデータはありません。

金額は `Int` の円です。`KMTransaction.amountYen` はActualと同じ符号付き（流出は負、流入は正）です。手入力/振替の入力型とレシート/明細の合計は正額です。JSの安全整数の範囲を超える集計はthrowします。数量・比率は `Decimal` です。

`KMDate` はAsia/Tokyoのグレゴリオ暦日（`YYYY-MM-DD`）、`KMYearMonth` は年月です。未知の入力には `try KMDate(string)` / `try KMYearMonth(string)`、JSONにはCodableを使います。`init(rawValue:)` は検証済み定数用です。不正値はprecondition違反になります。`Date` は作成時刻等の瞬間だけに使います。保存JSONの日時には `KMJSON.decoder()` / `.encoder()` を使ってください（ISO8601、offset・小数秒に対応）。通常のJSONDecoderのDate既定値は互換ではありません。

状態enumのrawValueはPWAに合わせています。`Codable` は将来のデコードの土台であり、`.kmb` 全体の検証/移行器ではありません。未知キーの拒否、nullable必須キーと欠落の区別、IDの参照整合性、AI応答の完全なschema検証は後続の取り込み/API境界で行います。これらの型へdecodeできただけでAI応答を保存してはいけません。

`KMAccount` の明細サービスと `KMCategory` の色トーン・使用件数/順序は、ActualとKakeiMatch記録を合わせた画面用projectionです。`KMTransaction.splits` もActual子行をまとめたprojectionで、保存JSONへそのまま追加するフィールドではありません。色未指定時の見た目は既存 `KMCategoryTone.visual(name:id:)` を使います。Data層はSwiftUIへ依存しません。テーマは端末設定で、家計簿バックアップ・同期に含めません。画面ロックの秘密情報やCloud credentialsはこの型に持たせません。

### protocolと実装境界

全protocolとin-memory実装は **`@MainActor`、全操作は `async throws`** です。ViewもMainActor上で呼び、エラーを表示してください。永続化adapterは別actorでI/Oを実行してからsnapshotを返せます。集計関数と値型はactor非依存・Sendableです。画面へ返す値はsnapshotなので、保存後は再取得します。ライブBindingや自動通知を仮定しません。

| protocol | 主な用途 |
| --- | --- |
| `TransactionRepository` | 検索、記録取得、日別グループ、ホーム集計、手入力/振替の保存、対象外フラグ、削除 |
| `AccountRepository` | 残高込みの一覧、追加/変更/利用終了、未使用口座の削除 |
| `CategoryRepository` | 使用順/件数込みの一覧、グループ、追加/変更/非表示、未使用カテゴリの削除 |
| `PayeeRepository` | 支払先候補の一覧 |
| `ReceiptRepository` | レシートsnapshot/原本の参照、下書き保存、未登録下書きの削除、確認値からの台帳登録/既存取引編集 |
| `StatementRepository` | 明細CSVの原本/履歴/行の一括保存、MoneyForwardの確認・取り込み・対応ルール・履歴と取消 |
| `ReconciliationRepository` | run計算・自動一致、手動一致・取消、候補却下、登録しない、支出/振替登録、失敗の再試行、判断参照、不正利用疑い |
| `BudgetRepository` | 月次予算集計、設定snapshotの取得/保存。plan変更は `KMMonthlyBudgetSettings` のhelperを利用 |
| `RecurringRepository` | 定期設定CRUD、過去分のプレビューと選択生成、自動到来分の処理、生成snapshotの履歴・選択削除・未編集分の一括取消（編集行は保持） |
| `PayrollRepository` | 確認済み給与内訳snapshotの保存/参照（収入への反映はしない） |
| `CategoryLearningRepository` | `saveCategoryObservation` / `categoryObservations` で確認履歴を保存/参照。レシートID単位で置換し古い確認を無視。ルールは履歴から導出し、上書き・resetも保存 |
| `SettingsRepository` | テーマ/最終バックアップ時刻のsnapshot |

手入力・振替の登録は `id: nil`、編集は既存IDを渡します。同じimportedIdの同値再送は同じ取引を返し、異値は既存を上書きせずthrowします。手入力編集はinputのimportedIdで既存識別子を置き換えません。cleared/reconciledを保ち、振替編集は入金側IDを渡しても両側を更新します。支払先は操作ごとのPWA/Actual規則で照合しmasterへ保存します。口座残高は読み取り用で、日本時間の今日までを合計します。`accounts(asOf:includeClosed:)` では固定日を渡せます。`createAccount(_:startingBalanceYen:startingDate:)` は日付付き開始残高を残高だけへ計上します。`saveAccount` は名称・種類・利用終了等だけを変更し、残高を直接上書きしません。残高のある利用終了と、有効な取引行のある完全削除を拒否し、空口座も利用終了→再開できます。振替は両口座の残高に反映し、一覧は出金側を1行だけ返します。検索は `KMTransactionQuery`、全履歴検索では `limit: nil`、記録一覧は `recordDays(matching:)` を使います（PWA同様、最近100件を取ってから種類で絞ります）。

ホームは `transactions.home(month:)` の `KMHomeSnapshot` に収支・カテゴリ内訳・予算・選択月内の最近3件をまとめます。記録一覧は日付降順・同日ID降順、検索は日付降順・同日ID昇順というPWAの違いも保持します。PWAと同様、月次集計は金額の符号で収支を分類し、振替/予算対象外口座/削除済み/開始残高/不正行と支出対象外を除きます。返金の単独正額は収入、分割子行の正額はカテゴリ支出と相殺します。日別見出しは種類で絞った後に集計し、振替と対象外の行も一覧には残します。カテゴリ使用回数は分割の同一カテゴリを1記録につき1回、振替は0回として数えます。

`saveReceipt` / `saveResolution` / `savePayrollRecord` はサービスが作ったsnapshotの保存契約です。写真のAI抽出、家計簿への登録、照合判断の適用/取消を実行するAPIではありません。照合の計算・適用/取消は別の `ReconciliationRepository` 操作を使います。手動判断・組の拒否・不正利用？の設定後はPWAと同じく以前のrunが古くなるため、再照合してから次の操作を行います。通常取引APIによる分割/レシート編集はthrowします。レシートの登録は `receipts.registerReceipt(id:at:)`、編集は `editReceipt(id:value:expectedUpdatedAt:at:)` を呼びます。品目・値引き・税の配分と親子の組み替えはサービス内で行います。`saveReceipt`で登録済みsnapshotを直接置換せず、編集前に読み込んだupdatedAtを渡してください。画像ありの0円支出も扱います。分類学習の確認時呼出しはまだ未接続です。Viewで代替エンジンを作らないでください。

削除は `transactions.deleteTransaction(id:expected:at:)` が `KMTransactionDeletion` を返します。expectedは任意の古さ検査用root＋振替peer（分割子はroot.splits内）です。`transactionDeletions()` は再起動後も履歴を返し、`undoTransactionDeletion(id:at:)` は削除履歴IDで10秒未満の取り消しを行います。従来の `deleteTransaction(id:)` も削除印を使いますが、Undo用のIDと期限が必要な画面は戻り値のあるAPIを使ってください。取引・対・親子・関連レシートを一括で消し、Undoは同じIDを復元します。画像/品目/確認値は残します。toastの表示と期限管理は画面側です。

### 明細・移行・マスタ・定期の保存

- 明細は `statements.importStatement(data:provider:at:)`。#281パーサで検証して原本/履歴/行を一括保存します。再取り込みは同じimport IDを使い、既存明細や判断を増やしません。支払元0件でも利用でき、取引は照合判断後に作ります。
- MoneyForwardは `previewMoneyForward(rows:mappings:choices:at:)` → `importMoneyForward(id:rows:mappings:choices:rememberMappings:at:)`。同じ金額/カテゴリで±3日の候補には `.keep(transactionId:)` / `.separate` の判断が必要です。`rememberMappings` はPWAと同じく利用者が選び、batch履歴には常に対応を保存し、チェック時だけ次回用ルールにも保存します。`moneyForwardHistory` / `moneyForwardRules` で保存結果を取得し、`undoMoneyForward` は今回登録した取引だけを削除します。原CSVは保存しません。SQLiteでは途中成功がないため、失敗時は同じbatch IDで全体を再送します。
- カテゴリは `saveCategory` / `deleteCategory`、グループは `saveCategoryGroup` / `deleteCategoryGroup` / `reorderCategoryGroups` / `reorderCategories`。使用中は削除拒否して非表示を案内します。グループの非表示も選択肢へ反映します。グループ編集の画面はPWAにないため追加しません。
- 定期画面は `previewRecurringCatchUp(_:through:)` で過去分を確認し、複数件なら全件/今月分/キャンセルを選びます。`saveRecurringForCatchUp(_:at:)` は設定と次回日を保存し、到来分を自動生成しません。選択日は `catchUpRecurring` で生成します。従来の `saveRecurring(_:at:)` は保存時に自動到来分を処理し、家計簿を開いた時/復元後の `runRecurring(through:at:)` も維持しています。`recurringGenerations` で履歴を表示し、`undoRecurringGeneration(id:dates:at:)` のdates:nilは未編集分だけの一括取消、日付配列は選択削除です。独立した同内容の手入力と編集済み生成行を保持します。削除済み日は再生成しません。
- v4の `master-writes` に日付付き開始残高・定期監査/生成snapshot・移行履歴を保存します。v1/v2/v3は一括移行します。有効schedule付き `.kmb` と、旧PWAのMoneyForward履歴のnative投影は未対応です。境界と理由は [DATA_LAYER.md](docs/DATA_LAYER.md) を参照してください。

### UI test / Previewのfixture

```swift
// Screen (MainActor). The host injects the container.
@Environment(\.repositories) private var repositories
// Inside an async load action:
// guard let repositories else { ... show configuration error ...; return }
// let month = KMDate(instant: repositories.referenceDate).yearMonth
// let snapshot = try await repositories.transactions.home(month: month)

#Preview {
    KMFixturePreview("migration") { HomeView() }
}

// XCUITest (Debug only)
// app.launchArguments += ["-UITestFixture", "reconciliation"]
```

`KMFixtureLoader.load(named:)` はPreview/Swift Testingからも共通で使えます。独自の空/エラー/長い名前等は `KMInMemoryStore(...)` に値を渡し、`KMRepositories(inMemory:)` を注入してください。

| 名前 | 状態 |
| --- | --- |
| `migration` / `populated` | 共通fixtureの取引11件、基本カテゴリ15件＋給与、口座3件、全体予算80,000円。今月支出24,730円 |
| `empty` | 空の家計簿（固定時計のみ共通） |
| `budget-warning` | 同じ取引、全体予算20,000円で4,730円超過 |
| `receipt` | 同じ家計簿＋未登録の抽出済みレシート/7品目。原本画像は含まない |
| `reconciliation` | 明細7件からSwiftで計算。要確認1・記録なし2・一致4をTSの固定run/適用済み判断と全値比較 |
| `payroll` | 同じ家計簿＋給与内訳の確認snapshot。収入への反映前、写真なし |

`-UITestFixture` はDebugだけ有効です。指定がない場合はApplication SupportのSQLiteを開きます。不明な名前/欠落/不正JSONはエラーを表示して起動を止め、空データへ黙って置き換えません。`referenceDate` はfixtureの `2026-10-14T03:30:00Z` なので、画面の「今日」「今月」に実時計を使わないでください。記録一覧はfixtureの取引・日別収支・要確認表示を描画します。他の画面はplaceholderのままです。

同梱 `Data/InMemory/Fixtures/migration.json` はPR #279の `test/fixtures/ios-migration/fixture.json`（取得SHA `7daf6a839914131f3615d1ba339ee60e75f1fd55`）とJSON値が一致します。XcodeGenのアプリsources配下のJSONはresourceに含まれます。名前参照を安定したfixture IDに変換し、PWAが初期生成する基本カテゴリも補います。Actualが生成したUUIDそのものは再現しません。#279更新時は再fetchして形と内容を合わせてください。

`reconciliation.json` は既存TSエンジンの出力から固定した期待値です。再生成はNode 24で `node apps/ios/scripts/generate-reconciliation-fixture.mjs`。起動時はSwiftの照合サービスで入力から計算し、`LocalReconciliationTests.fixtureIsComputedAndEqualsPWAGolden` で期待値と比較します。入力・出力を変えたらRepositoryTestsの件数とPWAスクショ状態を同時に確認します。

### 後続Linux PRへの引き継ぎ

- 永続化: 通常起動は `KMSQLiteStore`。全Repositoryは同じprofileを共有し、変更はSQLite transaction内で確定します。取引の削除Undo・レシート登録状態の実遷移は専用APIに接続済みです。複数scene/processのprofile排他は後続です。世代番号で古いsnapshotによる上書きを拒否します。
- `.kmb` / `.kmib`: `repositories.localStore` の `importBackup(from:)` はmagicでPWA `.kmb` とiOS専用 `.kmib` を振り分けます。`exportNativeBackup()` は一時`.kmib`のURLを返します。どちらも復元後に `returnToPreviousProfile()` で切り戻せます。画面側は利用者確認、共有/Files保存、security-scoped URL、エラー表示、成功後のsnapshot再取得を担当します。`originalArtifact(id:)` はCSV/画像、`importedRecords()` は後続projection用の元記録（現在の編集済み家計簿ではない）です。`.kmib`はiOS同士でのみ復元でき、iOS→PWAの書き出しは提供しません（利用者決定 2026-10-26）。
- 決定的サービス: 照合の全操作・run入力snapshot・却下・別名・取消履歴、分類観測/上書き、定期設定/処理済み日、予算設定はSQLiteに保存し、再open後も利用できます。`catchUpRecurring(id:dates:through:at:)` は選択日を検証して生成し、処理済み日/登録IDで二重生成を防ぎます。削除した生成取引も自動で作り直しません。定期生成取消・編集行保持付き監査、明細/MoneyForwardの取り込み、口座/カテゴリ管理、照合の共通台帳経路は接続済みです。Actual Schedule/Rule互換取り込み、レシート確認からの学習呼出しは後続です。v1/v2/v3 DBはv4へ移行します。削除印/編集履歴は同じSQLite transaction内のledger-writes singletonに保存します。旧DB/`.kmb` のrun表示は保持しますが、Swiftの入力snapshotがないため判断前に再照合が必要です。
- API: AI抽出/分類、アカウント、問い合わせのtyped要求/応答と認証は別PR。Worker境界で検証し、秘密鍵を端末へ持たせない。
- 同期・画面ロックの進行状態/操作protocolは、対応サービスができるまで未定義。MoneyForwardは上記 `StatementRepository`、バックアップは `localStore` を使います。空の将来用抽象化を追加していない。Mac側は仮のView用状態を保ち、不足APIをIssue #240へ報告する。

## 記録一覧の接続範囲

`RecordsFlowTests` は種類の切り替え、スーパーみどりの検索（2件・合計−¥5,700）、詳細、メモ編集、保存、削除と取り消し、検索条件を保った復帰を検査します。`RecordsPresentationTests` は日付表示・表示文言・検索条件の検証・合計を、`RecordsModelTests` はRepositoryへの保存と再取得、失敗時の入力保持、振替対の削除/取り消しを検査します。

未接続・未検証の範囲は次のとおりです。

- 「口座・残高を見る」は口座画面への共通遷移がないため表示しません。shellと口座画面の別PRで接続します。
- 確認待ちは一覧・未登録下書きの削除・「確認する」からレシート登録画面を開く導線を接続しています。
- 登録済みレシートは基本項目の編集・画像/品目/値引き/分類理由の閲覧を接続しています。品目別カテゴリの編集と給与内訳の表示は未接続です。画像の拡大操作も未接続です。
- 日付入力は `YYYY-MM-DD` の文字入力です。カテゴリ・口座はOSの選択メニュー、削除確認はOSのダイアログです。支出集計の対象外はOSのスイッチを使います。
- 削除の取り消し表示は記録画面が残っている間だけです。別タブでも残す共通の通知表示はshellの別PRが必要です。
- 実機、Dynamic Type、VoiceOverによる手動操作、横向き、永続DBの画面経由の再起動復元は未検証です。Repositoryの単体検証とは区別します。

## PWAとの差分・検証範囲

- 記録一覧以外のタブ内はplaceholderです。ホームの集計・照合・設定の本実装とデータ状態の比較は後続PRです。記録一覧は空状態と種類別の空状態も表示します。
- 下部ナビ・FAB・シート・toast/bannerの枠だけは指定されたLiquid Glassを使用。透明度、反射、影はPWAの不透明な面と異なりOS依存です。`.glassEffect(_:in:)` / `.tint(_:)` / `.interactive(_:)` はApple公式資料でiOS 26導入を確認しています。[Apple SwiftUI (2026/10), glassEffect / Glass]
- シートの出入りは透明なネイティブモーダルhostのアニメーションです。PWAの0.2秒のCSSアニメーションとは異なります。視差効果を減らす設定では停止します。背後のページは見たまま保持し、操作とアクセシビリティのフォーカスをOS側で遮断します。
- 時計・ホームインジケータ・safe areaはネイティブOSのもの。端末サイズが異なるため390pxのPWAスクリーンショットとの画素一致は主張しません。
- セグメントは36ptの見た目を44ptのヒット領域に中央配置します。下地の高さ44ptもPWAと一致させ、アクセシビリティのために外側の余白を増やしません。
- フォントの字形・改行はネイティブの組版に依存します。固定サイズをPWAに合わせた土台であり、Dynamic Typeの拡大対応は後続の検証課題です。
- 参考画像: `docs/screenshots/apricot-foundation-light-390-{home,chooser,records}.png`。実際に取得したCI画像との残差分・検証SHAはPR本文へ記録します。

## 参照資料

[runner-images, 2026/10] GitHub. "macOS 15 Readme"（確認時のcommitを固定）. https://github.com/actions/runner-images/blob/71a003a8ee93ec4165885a365ab607c6732c5078/images/macos/macos-15-Readme.md

[Apple SwiftUI, 2026/10] Apple. "glassEffect(_:in:)". https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:) / "Glass". https://developer.apple.com/documentation/swiftui/glass
