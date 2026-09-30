# PWAのローカル保存フローとiPhoneでの合成データ確認

現在の主アプリは `apps/pwa` のPWA（Progressive Web App、ブラウザーからホーム画面へ追加できるWebアプリ）です。家計データを端末に保存し、Cloud accountはAIの認証・利用量・プランにだけ使います。Next.jsアプリはlegacy実装としてIssue #39まで残し、この移行作業では削除しません。

Issue #35のpreviewは[こちら](https://kakeimatch-issue-35-kakeimatch-issue-35-preview.yhgry.workers.dev)です。iPhone実機での確認と外部AI providerへの実要求は、まだ検証していません。Chromiumでは、実際の家計簿エンジンと代替AI応答を使った主要フロー・オフライン再起動・手入力登録の自動試験が通っています。専用previewのD1と仮想Passkeyを使った登録・ログイン・セッションからのAI認証・ログアウトも確認しています。以下の確認にはテスト専用のブラウザプロファイルと合成データを使います。実際の家計簿を含むBudgetを開いたり変更したりしないでください。

## 端末内のデータと状態

Actual Budgetのブラウザ用データベースとKakeiMatchのIndexedDB（ブラウザーの端末内データベース）は、このサイト用のブラウザー領域に保存されます。KakeiMatchは端末内profile IDを使います。Cloud accountの利用者IDを端末の家計データ所有者には使いません。現在のPWAはブラウザー内のActual Budgetデータを使い、Actual Sync Serverとの同期は実装していません。

AI要求を始める前に、レシート画像とレシートrecordを端末へ保存します。画像は10 MiBまで保存できます。AI Gatewayが受け付ける上限は6 MiBです。6 MiBを超える画像も端末に残り、手入力に使えますが、AIへ送信できません。Geminiから受け取った抽出JSONはPWAがreceipt schemaで検証してから保存します。AIの提案と利用者が確認した値は別々に保存され、再解析しても確認値を上書きしません。

カテゴリ提案では、過去に利用者が確定した店舗mappingを最初に調べます。mappingがなければ、Jevへ店舗名、合計金額、最大30件の商品名と金額だけを送信します。Jevへレシート画像、receipt ID、Actualのデータ、明細内容、家計履歴は送りません。応答が不正、または提案の確度が不足する場合は、利用者がカテゴリを選びます。

PayPay CSVはブラウザー内で解析します。元ファイル、canonical行、import情報、照合run、候補、利用者の判断、候補の却下、Actualへの反映状態を端末に保存します。取引の意味を確認できていない他社形式は取り込みません。照合には確認済みレシートとcanonical明細を使います。AIは照合に関与しません。自動一致はActualへ反映し、判断が必要な明細は確認画面に残します。

レシート登録状態は `pending`、`processing`、`applied`、`failed` で管理し、登録後はActualの取引IDを保存します。再試行では同じ `kakeimatch:${receiptId}` imported IDを使います。Actualへの反映結果が不明な失敗後は、再試行で状態を回復するまで確認値を変更できません。Web Locks APIを使い、複数タブから同じレシートを同時更新しないようにします。

## Cloud accountとログアウト

端末内の家計表示、レシート入力、PayPay import、照合にCloud account sessionは不要です。GeminiとJevの要求は同一originの `/api/ai/token` で取得する短時間有効なBearer tokenを使います。このrouteは認証sessionからaccountを特定し、PWAはuser IDを送信しません。GatewayがGeminiへ画像と抽出promptを送り、TypeSafeへ検証済みの最小Jev stateを送ります。account用D1には認証record、entitlement、月間AI利用量だけを保存し、家計データは保存しません。

ログアウトするとCloud account sessionを終了し、メモリ上のAI tokenを消します。Actualのブラウザ用データベース、端末profile、レシート画像、明細、照合データは端末に残ります。次のAI要求には再ログインが必要ですが、通常の家計操作には不要です。

## iPhoneで合成データを確認する手順

実際の家計簿を含まないテスト専用iPhoneプロファイルを使ってください。既存の家計簿profileとデータをそのまま保ちます。以下の `Synthetic` 値だけを使い、実レシートや実明細を使わないでください。

1. Safariでpreview URLをオンライン表示します。ホーム画面へ追加し、一度起動してアプリ画面をキャッシュします。
2. このテスト用profileに作成された空のBudgetを選び、設定画面を開きます。`Synthetic cash` という支払元を追加し、基本カテゴリを用意します。実家計簿のActual ZIPを読み込まないでください。
3. レシート画面で手入力を選び、店名 `Synthetic Cafe`、日付 `2026-09-28`、金額 `3284`、カテゴリ `食費`、口座 `Synthetic cash` を入力します。確認値を保存して取引を登録します。
4. 下記の完全一致PayPay headerと合成購入行を使い、UTF-8 CSVを作成します。オンラインまたはオフラインで取り込みます。CSVの解析と保存は端末内で行います。

```csv
取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,変換レート（円）,利用国,取引内容,取引先,取引方法,支払い区分,利用者,取引番号
2026/09/28 12:34,"3,284",,,,,,支払い,Synthetic Cafe,PayPay残高,一回払い,本人,synthetic-35-001
```

5. 照合画面を開いて実行します。同じ日付・店名・金額の合成データが一致することを確認します。金額または店舗名を変えた別の行も試し、要確認・記録なし画面を確認します。合成明細を実際のActual Budgetへ反映しないでください。
6. 機内モードにしてホーム画面アプリを終了し、再起動します。Budget、レシート、取り込んだ明細、照合状態が残っていることを確認します。AI要求はオフラインを案内し、端末保存済み画像と入力値が引き続き使えることを確認します。
7. テスト用Cloud accountにログインしている場合は、設定画面からログアウトします。端末データを保持した旨が表示され、家計画面を引き続き使えることを確認します。AI利用には再ログインが必要です。
8. iOSとSafariのversion、各手順の結果、表示されたエラー文を記録します。backup機能ができるまではSafariのWebサイトデータやテストprofileを削除しないでください。

この手順で確認できるのはクライアント側の挙動です。GeminiやTypeSafeへの実要求、Actual Sync Serverとの同期、iPhone実機上での動作は確認済みになりません。これらは未確認のままです。

## Backupと移行の状態

KakeiMatchの端末recordとレシート画像をまとめてexport/restoreする機能はまだありません。Issue #37で実装する予定です。Actual BudgetのZIP importは初回の家計簿読込機能で、KakeiMatchのレシート画像、明細ファイル、照合run、利用者判断をbackupしません。現在はブラウザー内データがローカル情報の唯一のコピーです。試験中にブラウザー領域を消去しないでください。
