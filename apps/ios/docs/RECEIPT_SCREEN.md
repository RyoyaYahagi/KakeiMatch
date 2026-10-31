# レシート画面（Issue #240・画面4）

## PWAで確認した状態と操作

基準は `pwa-swift-migration-baseline`。`local-ui.ts:receiptEditor`、`local-receipts.ts`、`receipt-reading-progress.ts`、`receipt-warnings.ts`、`receipt-image-viewer.ts` と migration/receipt の4状態を実装前に確認した。

| 状態 | 文言・順序・表示条件 |
| --- | --- |
| 撮影・写真選択 | 追加メニューから写真を保存し「レシートを登録する」へ。「全体」「品目一覧」。画像拡大、説明文、明示操作「AIで読み取る」、金額・店名・日付・カテゴリ・支払元・時刻/メモ・品目・集計除外の順 |
| 読み取り中 | 写真保存、文字読み取り、カテゴリ分類の3行。10秒で「品目が多いレシートは時間がかかります」へ。「待たずに手で入力する」、分類中は「分類を待たずに自分で選ぶ」。中止後の応答で入力を上書きしない |
| 成功 | 型検証済みのレシート抽出値だけを入力へ適用。レシート以外/不明は入力欄へ適用しない。カテゴリ分類に失敗しても抽出値を保持 |
| 警告 | 「画像と照らし合わせてほしいところがN件あります」。対象項目と日本語の理由。「確認した」または対象欄の修正で確認済みを保存。未知の警告コードを既知状態に読み替えない |
| 合計確認 | 全品目の金額がある時だけ比較。品目＋値引き/調整が合計と一致、または正の外税を足すと一致なら「✓ 一致」。それ以外は「△ 差額あり」。入力金額を保持 |
| 失敗 | 「! 写真から読み取れませんでした」、撮り直し、手入力。通信等の一時失敗では再試行。認証・利用枠・画像上限等では再試行を勧めない |
| 保存 | 確認値の下書き保存後に台帳登録。「登録しました。」。snapshotを再取得。登録失敗後は同じIDで再試行 |

## 接続と境界

`KMReceiptModel` が入力と非同期操作を管理する。`KMReceiptPresentation` は警告表示、合計照合、抽出値検証、待機文言、再試行可否の純関数。金額は整数円、日付は既存の `KMDate`（Asia/Tokyo）。警告確認の書き込みは直列化する。

撮影/写真選択の直後、AI送信前に `ReceiptRepository.saveReceiptImage` が原本を検証し、pendingレシートとartifactを同じtransactionで保存する。レシートIDとblob IDはPWAと同じ `receipt-image:<id>` 形式。撮り直しは置換前のpendingレシートと下書きを同じtransactionで消して新しいIDへ移る。既存画像は `ReceiptRepository.receiptImage` で読み出す。入力中の値は `saveReceiptDraft` が350 msのdebounceで確認値と別に保存し、再open時に `receiptDraft` から復元する。登録・登録済み編集・未登録削除で下書きも同じtransaction内に消える。AIは `KMWorkerAPI.readReceipt` / `classify` のみ。既定のnativeモードが `/api/native/ai/*` を使用する。秘密鍵・独自HTTP通信・PWA認証への切り替えは追加しない。新規は `saveReceipt` → `registerReceipt`、登録済みは `editReceipt`（読み込み時の `updatedAt` を渡す）。保存後は `KMCategoryLearningService.observation` を `categoryLearning.saveCategoryObservation` へ渡す。金額配分・親子取引の生成はRepositoryに任せる。

## PWAとの差分と不足操作

### 実装済み: 画像保存と下書き

- 画像はPWA `saveImage` と同じく、選んだ直後に元bytesを端末へ保存する。10 MiB以下・JPEG/PNG/WebP・宣言形式と先頭bytesの一致を検証し、条件を満たさない画像はレシートもartifactも作らない。画像付きのpendingレシートは再起動後も `receiptImage` で開ける。登録済みレシートの削除では画像を残す（PWAの削除意味論と同じ）。
- 未完成入力は店名・日付・時刻・金額文字列・カテゴリ・支払元・品目・値引き/調整・税額・メモ・集計除外を、確認値と別recordに350 msで保存する。空文字や不正な金額文字列も保持する。`merchant`・正の金額・品目のいずれかがある場合だけ復元し、確認待ち一覧から開き直すと続きを編集できる。登録・登録済み編集の成功時は下書きを残さない。
- 再起動後の復元はSQLite、UIテストはin-memory（`-UITestFixture`）で確認する。UIテストのfixtureも実Repository経由で合成画像を保存する。

### 未実装
- 学習ルールの適用と、登録・登録済み編集時の分類学習保存は接続済み。分類失敗時のカテゴリ修正も品目一覧で行える。
- 品目・カテゴリ・値引きの編集/追加/削除、全品目へのカテゴリ一括設定は品目一覧で接続済み。カテゴリ/支払元の新規追加は未対応。未分類品目を登録できない場合はRepositoryの検証エラーを示す。登録済みレシートは記録詳細の行から同じ編集画面を開く（カテゴリ行は品目一覧を先に開く）。
- PWAの読み取り走査線、入力欄の仮の帯、今日/昨日のショートカット、カテゴリ別小計の帯は未実装。
- 入力中の行の強調下線・項目直下のエラー、保存後の記録一覧への自動移動は未実装。エラーは固定ボタン上、保存完了は「登録しました。」と「記録一覧へ」で示す。登録状態がfailed/processingの保存済みsnapshotに対する専用再試行も未接続（pendingの登録失敗後の同一ID再試行は対応）。
- 失敗時のアカウント確認画面への直接導線は未接続。既存認証資格情報がない時は入力を保持して手入力を案内する。

### OS固有の代替

- 撮影は `UIImagePickerController`、写真はOSの写真ピッカー。撮影画像はJPEGへ変換。写真選択は元形式を要求し、JPEG/PNG/WebP以外（HEICを含む）は拒否する。
- 日付はAsia/Tokyo指定のOS日付ピッカー。カテゴリ/支払元は既存マスタを選ぶOSメニュー。画像拡大は画面幅で表示し、タップ位置を中心に2.5倍、再タップで全体表示。ピンチも可能。横長画像のプレビュー領域にも高さ280ptを確保する（PWAは画像に合わせた高さ）。登録済みレシートは記録詳細の行から編集画面を開き、そこにある画像プレビューから同じ拡大表示を使う（PWAと同じ導線）。
- App Attest非対応ではAIを利用せず失敗表示と手入力導線を提供する。native認証の利用は実機で別途確認が必要。

### 未検証

- 署名済み実機の撮影/権限拒否、実写真ライブラリの各形式、App Attestと実Workerでの成功、実AI分類、ネットワーク中断後の挙動。
- VoiceOverの実機読み上げ、最大Dynamic Type、長い値の全組合せ。

### Repository/APIへの要望

1. 画像保存は `saveReceiptImage(data:contentType:replacingReceiptId:at:)` で接続済み。同じpendingレシートへの再送は新しい画像を保存し直し、置換前の画像を残さない。
2. 未完成入力は `saveReceiptDraft` / `receiptDraft` で接続済み。
3. 抽出・分類・警告確認を古さ検査付きで更新する操作。現状は画面でsnapshotを再取得して確認するが、`saveReceipt`との間を原子的に保証できない。登録済みレシートの警告確認は専用操作がないため、編集画面では警告帯を表示しない。
4. PWA相当の学習ルール適用→未分類だけAI分類→確認履歴保存をまとめるサービス。画面で学習エンジンを代替しない。

## 画面5への引き継ぎ

`KMReceiptModel.items` / `adjustments` / `categoryId` / `tax` が現在の確認入力。`pane == "items"` が表示の入口。品目IDと調整IDはreceipt ID＋抽出index由来で保持する。行のidentifierは `receipt.row.<stableID>`。入力欄はPWA DOM id（`receipt-amount`等）、PWAにDOM idがない操作は `receipt.itemsTab` 等を使用する。

品目カテゴリ編集は同じ入力モデルで接続済みで、未分類・複数カテゴリ・値引き対象・税額・金額不一致を扱う。台帳登録・登録済み編集の配分処理は引き続きRepositoryを使う。品目の警告対象は抽出indexなので、並べ替え/削除時の対応を保持する必要がある。登録済み編集の保存は `editReceipt` が古い `updatedAt` を拒否し、失敗時は画面の入力を残して台帳を変更しない。

## 調査中に見つけたドキュメントとコードの食い違い

- `apps/ios/README.md`「配置と後続PR」は手入力/収入/振替をplaceholderと説明していた。`Features/ManualEntry/ManualEntryView.swift:KMEntryFormView` は実装済み。既存の入力検証・金額部品・ボタン・状態管理の書き方に従い、READMEを修正した。
- 同節は本文ScrollViewと左右余白をshellが持つと説明していた。`App/AppShell.swift` の手入力分岐では、`KMEntryFormView` がScrollViewと左右余白を持ち、登録ボタンを固定する。レシートもこの既存分岐に従い、shellの構造変更を避けて最小限の接続を追加した。
- `apps/ios/HANDOFF.md` 2節末尾の「各画面（3節）: 未着手」は、mainの手入力 `KMEntryFormView`（#307）の実装と一致しない。未着手という記述に従って作り直さず、実装済みコードを参照した。担当表全体の更新はこのPRに含めない。

- `docs/UX.md`「読み取り中」は、利用上限等の再試行しない失敗で主要ボタンを「手で入力して続ける」にすると説明する。一方、基準PWAの `local-ui.ts:readPhoto` の非retry分岐は「登録する」を表示したまま、失敗帯の中に手入力ボタンを置く。本実装もPWAのコードに従う。

- `CONTRIBUTING.md`「テスト」はDraft PRではCIを実行しないと説明する。一方、`.github/workflows/ios.yml` はDraft除外がなく `pull_request` でiosジョブを実行する（#308でも実行を確認）。文書の説明でCI停止を前提にせず、実際のworkflowとチェック状態を確認する。

## 合成fixtureと検証

`-UITestFixture receipt -ReceiptScenario initial|loading|result|warnings|failure` はDebugのみ。メモリRepositoryの既存合成抽出結果を使い、架空レシートの画像をメモリで描く。読み取り中/失敗は表示状態の注入であり、実AI/画像永続化の成功を示すものではない。画像が未保存である表示もそのまま撮影する。

Swift Testingは `ReceiptPresentationTests` / `ReceiptModelTests`。XCUITestは `ReceiptFlowTests`。追加メニュー・警告修正と登録反映・確認待ちからの全画面編集・画像拡大と読み取りの継続・非対応時の手入力を検査する。対象実行は `scripts/test-local.sh --only <identifier>`。全suiteはCIに任せる。

撮影に必要なカメラの用途説明だけを `project.yml` に追加した。ターゲット構成、entitlements、署名設定は変更していない。画像の永続化が未接続のため、用途説明の「入力に使う」は手入力で画像を照合する用途を含む。

## ローカル検証の記録

- Xcode 27.1 / iPhone Air / iOS 26.2。対象を `scripts/test-local.sh --only` で限定した。全suiteは実行していない。
- Swift Testing 13件（純関数5件、入力/保存8件）成功。結果: `/tmp/KakeiMatch-20261028-213623-10175-888338F6-C5A5-4FCE-9D52-636E7002128E.xcresult`。
- XCUITest 4件: 確認待ちの編集、警告修正と登録反映、light/darkの状態・品目表示・画像拡大・中断/手入力。13件の単体テストと同時に確認待ち/警告の2件を再実行し成功。
- スクリーンショットは `docs/screenshots/migration/ios/receipt/`。未加工PNGを12枚保存した。PWA比較表はPR本文にコミット固定URLで載せる。
- ローカルの同時テスト数を確認し、実行枠が空くまで待った。画像拡大検証に使ったagent-deviceセッションは終了した。iPhone Air Simulatorは撮影完了後に停止した。

最終の撮影テスト2件も成功（失敗帯の見出しが画面内にあることを検査）。結果: `/tmp/KakeiMatch-20261028-214006-14373-F87B6CAD-7C33-4F33-B904-B0A2B8170535.xcresult`。
