# 記録一覧のiOS比較画像

Issue #240 作業Bの画面確認用です。PWAの既存画像は変更していません。

## 撮影条件

- iPhone 17 Pro（402×874pt、PNGは1206×2622px）、iOS 26.2、Xcode 27.1。
- `RecordsFlowTests` がアプリを操作して保存した未加工のXCTAttachmentです。light/darkは `KM_UI_TEST_APPEARANCE` で固定しています。
- 家計データは合成fixture `reconciliation`。基準日は日本時間2026年10月14日です。OSの時計表示だけを12:30に固定しています。
- `empty-dark` は `empty` fixture、`transfer-empty-light` は `reconciliation` の種類を振替にした状態です。

| 状態 | iOS | 既存PWA |
| --- | --- | --- |
| 一覧・ライト | [populated-light](populated-light.png) | [populated-light](../../records/populated-light.png) |
| 一覧・ダーク | [populated-dark](populated-dark.png) | [populated-dark](../../records/populated-dark.png) |
| 検索・ライト | [search-light](search-light.png) | [search-light](../../records/search-light.png) |
| 検索・ダーク | [search-dark](search-dark.png) | [search-dark](../../records/search-dark.png) |
| 詳細・ライト/ダーク | [light](detail-light.png) / [dark](detail-dark.png) | 同じ状態の既存画像なし。`local-ui.ts` の `transactionDetail` を参照 |
| 空状態 | [empty-dark](empty-dark.png) / [transfer-empty-light](transfer-empty-light.png) | 同じ状態の既存画像なし |

検索条件は「スーパーみどり」。2件・合計−¥5,700で、詳細は2026年10月11日の−¥2,416を開いています。

## 比較時に区別する差分

- PWAは390×844 CSS pxです。iOSはOSの時計・safe areaを含みます。字形と字幅も異なるため、画素一致は主張しません。
- WebKitで親担当が撮影した `/tmp/km240/webkit-references/records/*` も目視比較しました。これらの一時画像はコミットしていません。
- 同日の並び順はRepositoryのID降順を維持しています。PWA参照画像の生成UUIDとiOSの固定fixture IDが異なるため、10月10日はカフェ・給与の順になります。
- 「口座・残高を見る」は口座画面への共通遷移がなく、表示していません。
- 下部ナビの3件バッジと、本文がナビ下へ描画される問題の共通修正は別PRです。本PRにshellの変更は含めていません。下部ナビのLiquid GlassもPWAとは異なります。
- 検索条件のボタンは見た目36pt・タップ領域44ptです。OSによる文字の高さと合わせて、PWAと縦方向の位置が少し異なります。
- 詳細の日付は文字入力、カテゴリ・口座はOSの選択メニュー、対象外はスイッチ、削除確認はOSのダイアログです。レシートの品目編集など残る範囲は [iOS README](../../../../../apps/ios/README.md#記録一覧の接続範囲) に記載しています。

## 再撮影

`apps/ios` で `xcodegen generate` を実行してから、専用のDerivedData（生成物の保存先）を指定します。

```sh
xcodebuild -project apps/ios/KakeiMatch.xcodeproj -scheme KakeiMatch \
  -destination 'platform=iOS Simulator,id=AB556D29-AF1D-4D66-A56B-D6A770C552E3' \
  -derivedDataPath /tmp/KakeiMatch-Records-DerivedData \
  -parallel-testing-enabled NO -only-testing:KakeiMatchUITests/RecordsFlowTests \
  -resultBundlePath /tmp/RecordsScreenshots.xcresult test CODE_SIGNING_ALLOWED=NO
xcrun xcresulttool export attachments --path /tmp/RecordsScreenshots.xcresult \
  --output-path /tmp/records-attachments
```

コマンドはリポジトリ直下で実行します。出力された `manifest.json` の `suggestedHumanReadableName` と `exportedFileName` を照合してPNGを配置します。
