# 手入力画面の iOS 比較画像

Issue #240 の画面3について、PWAの基準画像とiOS実装を照合するための記録です。PWAの基準画像は変更していません。

## 撮影条件

- iPhone 17 Pro Simulator、iOS 26.2。PNGは1206×2622 pxです。
- `EntryFlowTests` が撮影した未加工のXCUITest添付画像です。家計データは合成fixture `migration`、基準日は日本時間2026年10月14日です。
- `light` / `dark` は `KM_UI_TEST_APPEARANCE` で固定しました。
- iOS画面は402×874pt、PWA画面は390×844 CSS pxです。端末の表示領域・フォントが異なるため、画素一致ではなく、文言・項目順・操作・色・余白を比較します。

## PWA / iOS の画面比較

| 状態 | PWA light | iOS light | PWA dark | iOS dark |
| --- | --- | --- | --- | --- |
| 支出 | ![PWA 支出 light](../../entry/expense-light.png) | ![iOS 支出 light](expense-light.png) | ![PWA 支出 dark](../../entry/expense-dark.png) | ![iOS 支出 dark](expense-dark.png) |
| 収入 | ![PWA 収入 light](../../entry/income-light.png) | ![iOS 収入 light](income-light.png) | ![PWA 収入 dark](../../entry/income-dark.png) | ![iOS 収入 dark](income-dark.png) |
| 振替 | ![PWA 振替 light](../../entry/transfer-light.png) | ![iOS 振替 light](transfer-light.png) | ![PWA 振替 dark](../../entry/transfer-dark.png) | ![iOS 振替 dark](transfer-dark.png) |
| カテゴリ選択 | ![PWA カテゴリ light](../../entry/category-sheet-light.png) | ![iOS カテゴリ light](category-sheet-light.png) | ![PWA カテゴリ dark](../../entry/category-sheet-dark.png) | ![iOS カテゴリ dark](category-sheet-dark.png) |
| 毎月の繰り返し | ![PWA 毎月 light](../../entry/recurrence-light.png) | ![iOS 毎月 light](recurrence-light.png) | ![PWA 毎月 dark](../../entry/recurrence-dark.png) | ![iOS 毎月 dark](recurrence-dark.png) |

## 差分の分類

- **一致させた内容:** 支出・収入・振替の入力項目、カテゴリ・口座の選択、日付の今日/昨日操作、任意のメモ、支出除外、繰り返し設定、登録CTAをPWAの操作順と文言に合わせました。
- **iOSに合わせた表示差:** 日付はiOSのコンパクトな日付選択、カテゴリは下から開くシート、繰り返しはOSメニューを使います。下部ナビとステータスバーもiOSの領域です。
- **検証した保存:** 支出を手入力し、登録完了文言「登録しました。」をXCUITestで確認しました。収入と振替は画面表示を確認し、Repository経由の保存処理を実装しています。
- **Repository/APIの追加要求:** ありません。支出は既存のレシート保存・登録操作、収入は手入力取引、振替は振替保存を利用しています。カテゴリ・口座の追加と定期登録も既存操作に接続しています。

## Home画面の下端確認

[`../home/home-bottom-light.png`](../home/home-bottom-light.png) と [`../home/home-bottom-dark.png`](../home/home-bottom-dark.png) は、最後の記録までスクロールした状態です。`HomeBottomInsetTests` は両外観で最後の記録と下部ナビの間隔を確認し、間隔が0pt以上48pt以下であることを検証します。実測は既存の32pt余白の範囲内で、#295・#300適用後の二重余白は確認されなかったため、余白修正の別PRは作りません。

## 再撮影

リポジトリ直下でXcodeプロジェクトを生成し、専用のDerivedData（ビルド生成物の保存先）と結果バンドルを指定します。

```sh
cd apps/ios && xcodegen generate && cd ../..
xcodebuild -project apps/ios/KakeiMatch.xcodeproj -scheme KakeiMatch \
  -destination 'platform=iOS Simulator,id=AB556D29-AF1D-4D66-A56B-D6A770C552E3' \
  -derivedDataPath /tmp/KakeiMatch-Entry-DerivedData \
  -resultBundlePath /tmp/KakeiMatch-EntryScreenshots.xcresult \
  -parallel-testing-enabled NO \
  -only-testing:KakeiMatchUITests/EntryFlowTests \
  test CODE_SIGNING_ALLOWED=NO
xcrun xcresulttool export attachments \
  --path /tmp/KakeiMatch-EntryScreenshots.xcresult \
  --output-path /tmp/KakeiMatch-entry-attachments
```

出力された `manifest.json` で `suggestedHumanReadableName` と `exportedFileName` を照合してPNGを配置します。
