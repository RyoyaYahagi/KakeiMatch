# KakeiMatch iOS の土台

Issue #240 の Phase 1・2。`apps/pwa` の baseline `pwa-swift-migration-baseline`（`ae8c9b6`）を正解とします。各画面は **placeholder** です。画面用ドメイン型、Repository protocol、メモリ上のfixture、月次集計を用意しています。通常起動は端末内SQLiteへ永続保存します。PWAの `.kmb` 取り込みと変更前profileへの切り戻しをData層に用意しています（UIは未接続）。カメラ・API・`.kmb` 書き出しはありません。PWA / Worker は変更しません。

## 生成・ビルド・テスト

macOS / Xcode 26以上 / XcodeGen 2.44.1以上を使います。CIと揃える場合はXcode 26.2、iPhone 17 / iOS 26.2を選びます。

```sh
brew install xcodegen
sudo xcode-select --switch /Applications/Xcode_26.2.app/Contents/Developer
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

[`ios.yml`](../../.github/workflows/ios.yml) は既存CIと独立して生成→build→Swift Testing→XCUITestを実行します。失敗時もxcresultを `ios-test-results` に保存し、UIテストが保存した全タブ・追加シートのXCTAttachment（light/dark）をPNGとして `ios-reference-screenshots` artifactに含めます。`gh run download <run-id> -n ios-reference-screenshots -D /tmp/ios-results` で取得できます。PNGのUUIDと画面名の対応は `manifest.json` にあります。DEBUGビルドだけ `KM_UI_TEST_APPEARANCE=light|dark` を受け付け、UIテストでOS設定を変えずに外観を固定します。通常起動とReleaseはシステム設定に従います。

runnerの公式一覧にmacos-15 / Xcode 26.2 / iOS 26.2 / iPhone 17が掲載されていることを確認して選定しています。[runner-images (2026/10), macOS 15 / Xcode・Installed Simulators]

## 配置と後続PR

- `App/AppShell.swift`: 4タブと追加シート、入力の戻り先、本文のScrollViewを管理。画面ViewはVStack等で本文を返します。標準TabView / NavigationStack / List / Formによるナビ・余白の再解釈はしません。左右16pt・本文下32ptをshellが持ち、縦向きiPhoneではOSの上safe areaがPWAの `max(16px, safe-area-inset-top)` を満たすため16ptを重ねて足しません。下部ナビは本文と別に64pt＋OS下safe areaです。
- `Features/{Home,Records,Reconciliation,Settings}/<Name>View.swift`: 同名Viewを保って中身を置き換えます。shellの変更は不要です。
- `Features/{Receipt,ManualEntry,Income,Transfer}`: 追加から進むplaceholder。カメラや写真選択は未実装です。キャンセルで元タブの上に追加シートを開き直します。
- `Features/RecordChooser`: PWAと同じ選択肢・文言・2列配置。中央追加は選択中タブを変えません。
- `Data`: ドメイン型・Repository protocol・集計・fixture用in-memory実装・SQLite永続化・`.kmb` reader。使い方と未実装の境界は下記と [DATA_LAYER.md](docs/DATA_LAYER.md) を参照してください。`API` は `.gitkeep` のみです。
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
| `ReceiptRepository` | レシートsnapshot/原本の参照、下書き保存、未登録下書きの削除 |
| `StatementRepository` | 明細取込履歴と明細行の参照 |
| `ReconciliationRepository` | run計算・自動一致、手動一致・取消、候補却下、登録しない、支出/振替登録、失敗の再試行、判断参照、不正利用疑い |
| `BudgetRepository` | 月次予算集計、設定snapshotの取得/保存。plan変更は `KMMonthlyBudgetSettings` のhelperを利用 |
| `RecurringRepository` | 定期設定CRUD、選択した過去日分のnative取引生成、処理済み日の参照。生成と処理済み記録を一括保存 |
| `PayrollRepository` | 確認済み給与内訳snapshotの保存/参照（収入への反映はしない） |
| `CategoryLearningRepository` | `saveCategoryObservation` / `categoryObservations` で確認履歴を保存/参照。レシートID単位で置換し古い確認を無視。ルールは履歴から導出し、上書き・resetも保存 |
| `SettingsRepository` | テーマ/最終バックアップ時刻のsnapshot |

手入力の登録は `id: nil`、編集は既存IDを渡します。口座残高は読み取り用です。`saveAccount` は名称・種類・利用終了等だけを変更し、残高を直接上書きしません。振替は両口座の残高に反映し、一覧は出金側を1行だけ返します。検索は `KMTransactionQuery`、全履歴検索では `limit: nil`、記録一覧は `recordDays(matching:)` を使います（PWA同様、最近100件を取ってから種類で絞ります）。

ホームは `transactions.home(month:)` の `KMHomeSnapshot` に収支・カテゴリ内訳・予算・選択月内の最近3件をまとめます。記録一覧は日付降順・同日ID降順、検索は日付降順・同日ID昇順というPWAの違いも保持します。PWAと同様、月次集計は金額の符号で収支を分類し、振替/予算対象外口座/削除済み/開始残高/不正行と支出対象外を除きます。返金の単独正額は収入、分割子行の正額はカテゴリ支出と相殺します。日別見出しは種類で絞った後に集計し、振替と対象外の行も一覧には残します。カテゴリ使用回数は分割の同一カテゴリを1記録につき1回、振替は0回として数えます。

`saveReceipt` / `saveResolution` / `savePayrollRecord` はサービスが作ったsnapshotの保存契約です。写真のAI抽出、家計簿への登録、照合判断の適用/取消を実行するAPIではありません。照合の計算・適用/取消は別の `ReconciliationRepository` 操作を使います。手動判断・組の拒否・不正利用？の設定後はPWAと同じく以前のrunが古くなるため、再照合してから次の操作を行います。登録済みレシートの削除や通常取引APIによる分割/レシート編集は、未実装を隠さずthrowします。Viewで代替エンジンを作らないでください。

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

`-UITestFixture` はDebugだけ有効です。指定がない場合はApplication SupportのSQLiteを開きます。不明な名前/欠落/不正JSONはエラーを表示して起動を止め、空データへ黙って置き換えません。`referenceDate` はfixtureの `2026-10-14T03:30:00Z` なので、画面の「今日」「今月」に実時計を使わないでください。正常fixtureの表示はまだplaceholderのままで、データが画面へ描画済みとは扱いません。

同梱 `Data/InMemory/Fixtures/migration.json` はPR #279の `test/fixtures/ios-migration/fixture.json`（取得SHA `7daf6a839914131f3615d1ba339ee60e75f1fd55`）とJSON値が一致します。XcodeGenのアプリsources配下のJSONはresourceに含まれます。名前参照を安定したfixture IDに変換し、PWAが初期生成する基本カテゴリも補います。Actualが生成したUUIDそのものは再現しません。#279更新時は再fetchして形と内容を合わせてください。

`reconciliation.json` は既存TSエンジンの出力から固定した期待値です。再生成はNode 24で `node apps/ios/scripts/generate-reconciliation-fixture.mjs`。起動時はSwiftの照合サービスで入力から計算し、`LocalReconciliationTests.fixtureIsComputedAndEqualsPWAGolden` で期待値と比較します。入力・出力を変えたらRepositoryTestsの件数とPWAスクショ状態を同時に確認します。

### 後続Linux PRへの引き継ぎ

- 永続化: 通常起動は `KMSQLiteStore`。全Repositoryは同じprofileを共有し、変更はSQLite transaction内で確定します。削除Undo・登録状態の実遷移・複数scene/processのprofile排他はサービス統合時に追加してください。世代番号で古いsnapshotによる上書きを拒否します。
- `.kmb`: `repositories.localStore` の `importBackup(from:)` / `returnToPreviousProfile()` をバックアップUIから利用できます。画面側は利用者確認、security-scoped URL、エラー表示、成功後のsnapshot再取得を担当します。`originalArtifact(id:)` はCSV/画像、`importedRecords()` は後続projection用の元記録（現在の編集済み家計簿ではない）です。iOS→PWAのexportは提供しません（利用者決定 2026-10-26）。
- 決定的サービス: 照合の全操作・run入力snapshot・却下・別名・取消履歴、分類観測/上書き、定期設定/処理済み日、予算設定はSQLiteに保存し、再open後も利用できます。`catchUpRecurring(id:dates:through:at:)` は選択日を検証して生成し、処理済み日/登録IDで二重生成を防ぎます。削除した生成取引も自動で作り直しません。PWAの定期生成取消・編集行保持付き監査、Actual Schedule/Rule接続・自動タイマー実行、レシート確認からの学習呼出し、重複検出の取込経路接続は後続です。v1 DBはv2へ移行します。旧DB/`.kmb` のrun表示は保持しますが、Swiftの入力snapshotがないため判断前に再照合が必要です。
- API: AI抽出/分類、アカウント、問い合わせのtyped要求/応答と認証は別PR。Worker境界で検証し、秘密鍵を端末へ持たせない。
- 同期・MoneyForward・バックアップ・画面ロックの進行状態/操作protocolは、対応サービスができるまで未定義。空の将来用抽象化を追加していない。Mac側は仮のView用状態を保ち、不足APIをIssue #240へ報告する。

## PWAとの差分・検証範囲

- タブ内はplaceholderです。ホームの集計・記録一覧・照合・設定の本実装とデータ状態の比較は後続PRです。空データ状態を再現したとは扱いません。
- 下部ナビ・FAB・シート・toast/bannerの枠だけは指定されたLiquid Glassを使用。透明度、反射、影はPWAの不透明な面と異なりOS依存です。`.glassEffect(_:in:)` / `.tint(_:)` / `.interactive(_:)` はApple公式資料でiOS 26導入を確認しています。[Apple SwiftUI (2026/10), glassEffect / Glass]
- シートの出入りは透明なネイティブモーダルhostのアニメーションです。PWAの0.2秒のCSSアニメーションとは異なります。視差効果を減らす設定では停止します。背後のページは見たまま保持し、操作とアクセシビリティのフォーカスをOS側で遮断します。
- 時計・ホームインジケータ・safe areaはネイティブOSのもの。端末サイズが異なるため390pxのPWAスクリーンショットとの画素一致は主張しません。
- セグメントは36ptの見た目を44ptのヒット領域に中央配置します。下地の高さ44ptもPWAと一致させ、アクセシビリティのために外側の余白を増やしません。
- フォントの字形・改行はネイティブの組版に依存します。固定サイズをPWAに合わせた土台であり、Dynamic Typeの拡大対応は後続の検証課題です。
- 参考画像: `docs/screenshots/apricot-foundation-light-390-{home,chooser,records}.png`。実際に取得したCI画像との残差分・検証SHAはPR本文へ記録します。

## 参照資料

[runner-images, 2026/10] GitHub. "macOS 15 Readme"（確認時のcommitを固定）. https://github.com/actions/runner-images/blob/71a003a8ee93ec4165885a365ab607c6732c5078/images/macos/macos-15-Readme.md

[Apple SwiftUI, 2026/10] Apple. "glassEffect(_:in:)". https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:) / "Glass". https://developer.apple.com/documentation/swiftui/glass
