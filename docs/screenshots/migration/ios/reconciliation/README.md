# iOS「明細照合」の比較画像

`ReconciliationFlowTests` が保存した、加工していない Simulator 画像です。家計データは既存の合成 fixture だけを使います。

- 環境：Xcode 27.1、iOS 26.2、iPhone 17（402×874pt、PNG は1206×2622px）。時計表示を12:30に固定しています。
- `empty-{light,dark}.png`：fixture `empty`。CSVを選ぶ前です。
- `needs-review-{light,dark}.png`：fixture `reconciliation`。要確認1件、記録なし2件、一致4件、明細待ち2件です。
- `matched-{light,dark}.png`：同じ fixture の自動一致4件の履歴を開いた状態です。手動一致後の5件とは区別します。
- `comparison-light.png`：青空食堂の明細880円と記録860円を比較する、判断前の状態です。

PWA の比較対象は `../../reconciliation/` の同名画像です。PWA は390×844 CSS px、Linux Chromiumのフォントです。iOSでは上部の時計とsafe area、下部のLiquid Glass、字形・行間・折り返しが異なります。画像の画素一致や、差分画像による自動判定は行っていません。

## 再撮影

リポジトリ直下で実行します。端末IDと出力先は環境に合わせてください。

```sh
(cd apps/ios && xcodegen generate)
xcodebuild -project apps/ios/KakeiMatch.xcodeproj -scheme KakeiMatch \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.2' \
  -derivedDataPath /tmp/KakeiMatch-Reconciliation-DerivedData \
  -only-testing:KakeiMatchUITests/ReconciliationFlowTests \
  -parallel-testing-enabled NO -resultBundlePath /tmp/Reconciliation.xcresult \
  test CODE_SIGNING_ALLOWED=NO
xcrun xcresulttool export attachments --path /tmp/Reconciliation.xcresult \
  --output-path /tmp/reconciliation-attachments
```

出力された `manifest.json` で、名前が `reconciliation-` から始まる PNG と実ファイル名を対応付けます。prefix と添付のUUIDだけを除いて、このディレクトリへコピーします。CIの `ios-reference-screenshots` にも同じテストの添付が含まれます。
