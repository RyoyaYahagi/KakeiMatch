# KakeiMatch iOS の土台

Issue #240 の Phase 1・2。`apps/pwa` の baseline `pwa-swift-migration-baseline`（`ae8c9b6`）を正解とします。各画面は **placeholder** です。保存・カメラ・API・家計機能はありません。PWA / Worker は変更しません。

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

[`ios.yml`](../../.github/workflows/ios.yml) は既存CIと独立して生成→build→Swift Testing→XCUITestを実行します。失敗時もxcresultを保存し、UIテストが保存した全タブ・追加シートのXCTAttachmentをPNGとして `ios-test-results` artifactに含めます。`gh run download <run-id> -n ios-test-results -D /tmp/ios-results` で取得できます。

runnerの公式一覧にmacos-15 / Xcode 26.2 / iOS 26.2 / iPhone 17が掲載されていることを確認して選定しています。[runner-images (2026/10), macOS 15 / Xcode・Installed Simulators]

## 配置と後続PR

- `App/AppShell.swift`: 4タブと追加シート、入力の戻り先だけを管理。標準TabView / NavigationStackによるナビ再解釈はしません。
- `Features/{Home,Records,Reconciliation,Settings}/<Name>View.swift`: 同名Viewを保って中身を置き換えます。shellの変更は不要です。
- `Features/{Receipt,ManualEntry,Income,Transfer}`: 追加から進むplaceholder。カメラや写真選択は未実装です。キャンセルで元タブの上に追加シートを開き直します。
- `Features/RecordChooser`: PWAと同じ選択肢・文言・2列配置。中央追加は選択中タブを変えません。
- `Data` / `API`: 今は `.gitkeep` のみ。永続化・認可・API設計を先回りしません。
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
| `KMBottomSheet(title:isPresented:content:)` | shell最上層へ配置し、背後を `accessibilityHidden` にする。外側タップ、ヘッダ/つまみの80pt超の下スワイプで閉じる |
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

## PWAとの差分・検証範囲

- タブ内はplaceholderです。ホームの集計・記録一覧・照合・設定の本実装とデータ状態の比較は後続PRです。空データ状態を再現したとは扱いません。
- 下部ナビ・FAB・シート・toast/bannerの枠だけは指定されたLiquid Glassを使用。透明度、反射、影はPWAの不透明な面と異なりOS依存です。`.glassEffect(_:in:)` / `.tint(_:)` / `.interactive(_:)` はApple公式資料でiOS 26導入を確認しています。[Apple SwiftUI (2026/10), glassEffect / Glass]
- 時計・ホームインジケータ・safe areaはネイティブOSのもの。端末サイズが異なるため390pxのPWAスクリーンショットとの画素一致は主張しません。
- セグメントの見た目はPWAの36ptですが、44ptのヒット領域確保のため下地の高さがPWAより8pt高くなります。
- フォントの字形・改行はネイティブの組版に依存します。固定サイズをPWAに合わせた土台であり、Dynamic Typeの拡大対応は後続の検証課題です。
- 参考画像: `docs/screenshots/apricot-foundation-light-390-{home,chooser,records}.png`。実際に取得したCI画像との残差分・検証SHAはPR本文へ記録します。

## 参照資料

[runner-images, 2026/10] GitHub. "macOS 15 Readme"（確認時のcommitを固定）. https://github.com/actions/runner-images/blob/71a003a8ee93ec4165885a365ab607c6732c5078/images/macos/macos-15-Readme.md

[Apple SwiftUI, 2026/10] Apple. "glassEffect(_:in:)". https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:) / "Glass". https://developer.apple.com/documentation/swiftui/glass
