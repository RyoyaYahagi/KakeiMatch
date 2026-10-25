# アーキテクチャ

本番アプリは `apps/pwa` のPWAと、同じoriginで動くCloudflare Workerです。家計データは利用者の端末に保存します。Cloudflareはアプリ配信、Cloud account、AI Gatewayと、それらに必要なD1データを担当します。

## 本番構成

```text
ブラウザー / iPhone
├─ PWAの画面
├─ Actual Budgetブラウザー版
├─ KakeiMatchのIndexedDB記録
├─ レシート / 明細 / 照合 / .kmbバックアップと復元
└─ Cloud account / AI利用時の同一origin要求
       │
       ▼
Cloudflare Worker: https://kakeimatch.yhgry.workers.dev
├─ PWA配信
├─ /api/auth/* と /api/account/*（本人認証、招待、アカウント削除）
├─ /api/ai/* と /api/contact*
└─ D1: 本人確認 / session / Passkey / 招待・回復 /
       利用権限 / AI利用量・料金・制限 / 問い合わせ処理状態
```

本番の正規originは `https://kakeimatch.yhgry.workers.dev` です。ブラウザー保存領域はoriginごとに分かれるため、利用開始後にWorker名やoriginを変えると、保存済みデータが見えなくなることがあります。このoriginを安定して維持してください。previewは別originを使い、合成データ専用とします。家計データをpreviewで開かないでください。

## データ境界

Actual Budgetのブラウザー版は家計簿を端末内に保存します。KakeiMatchはレシート情報と画像、取り込んだ明細、照合run・判断、登録状態をブラウザー内に保存します。明細解析、照合、状態変更、金額処理は決定的な通常コードで行います。これらの家計データをアプリ用データベースへ送りません。

Cloud accountは端末内の家計操作には不要です。Better AuthとPasskeyはアカウントとAI APIの本人確認に使います。D1には本人確認とsession、Passkey、招待・回復情報、利用権限、AI利用量・料金・制限情報、問い合わせの二重投稿を防ぐ処理状態、マスキング済み問い合わせと許可された診断情報、暗号化した原文、管理操作の監査ログを保存します。音声はD1へ保存しません。取引、レシート画像、明細CSV、照合結果、Actual Budgetデータは保存しません。ログアウトしても端末の家計データは削除されません。

本人によるアカウント削除は、同一originと有効sessionをサーバーで確認し、D1のbatchで削除済みの不透明なuser IDをtombstoneへ記録してからuser行を削除します。認証情報、session、招待、利用権限、AI利用記録、問い合わせ処理状態は外部キーにより削除します。tombstoneは遅れて終わるPasskey登録から同じIDが復活するのを防ぐためにだけ保持し、氏名・email・認証情報を持ちません。AI用JWTは要求ごとにD1のuser行を確認してから使います。家計データは端末に残り、アカウント削除と連動して消しません。

AI要求は同一originの `/api/ai/*` を通します。Workerは認証、利用枠、要求形式、provider応答を検証します。利用者が選んだ場合だけ、レシート画像をGeminiへ送ります。カテゴリ提案では、検証済みの店名、合計金額、最大30件の商品名と金額だけをJevへ送ります。Jevは `JEV_PROVIDER` が選ぶproviderのSystemOne形式APIを呼びます。既定はOpenCode Consoleの `https://opencode.ai/inference/systemone/v1/systemone` と `jev-1.13-free` で、`openrouter` を選ぶとDecisions APIの `typesafe/jev-1.13` へ戻ります。両方のキーが登録されている場合、1回の失敗（タイムアウト、応答本文不正、HTTP 400/401/403/404/408/429/529/5xx）はもう片方のproviderへ1回だけ再送し、片方のcircuitが開いている間は最初からもう片方を使います。circuitは `jev:opencode` と `jev:openrouter` に分かれ、課金と利用枠は `jev` のままです。`OPENCODE_API_KEY`、`OPENROUTER_API_KEY` を含むprovider秘密鍵はWorker secretに保管し、ブラウザーbundleへ含めません。Cloud accountやネットワークを利用できない場合も、手入力、明細取込、照合、Actual Budgetの端末内操作を続けられます。

端末間の同期は、利用者の2台をWebRTCのデータチャネルで直接つなぎます。サーバーもSTUN/TURNも使わず、同じネットワークの端末どうしだけがつながります。接続に必要なsession descriptionは、QRコードまたは文字のコードとして利用者が受け渡します。コードにはDTLSの指紋が入るため、チャネルはコードを見せた端末に結び付いて暗号化されます。片方の家計簿全体をバックアップと同じ形式で送り、受け取った側はSHA-256で欠けがないことを確かめてから、バックアップの復元と同じ手順で切り替えます。元の家計簿は「変更前のデータに戻す」で戻せます。取引単位の合併はしません。

Service Workerは `/api/*` をcacheしません。Workerはブラウザー内のActualエンジンが必要とするCOOP/COEP response headerを維持します。いずれも本番構成の要件です。

給与明細も既存のAI境界を通し、手取りだけをActualへ登録します。写真はメモリ内でマスキングした後に送信し、永続保存しません。確認済みの構造化内訳だけを端末の`payroll-record`へ保存し、バックアップ・同期へ含めます。詳細は[給与明細](LOCAL_PAYROLL.md)を参照してください。

## iOS ネイティブのクラウドAPI

iOSのAPI層は、App AttestとPasskeyで検証する専用 `/api/native/*` を使います。家計データの正本や通常の端末内操作はCloud accountに依存しません。Webの認証経路を緩めず、ネイティブセッション・短期tokenを既存のWeb Cookie/JWTと分離します。検証後のAI処理は既存の利用枠・接続元制限・費用停止を通します。AASA、必要設定、追加D1表、実機確認の残件は[ネイティブ認証境界](NATIVE_APP_AUTH.md)に定義します。API層の追加であり、認証画面・家計サービスへの接続までの完成を意味しません。

## 端末内データの移行

Issue #38のクラウド保存は、明示同意後の暗号文のみを端末外へ送る追加経路として段階的に実装します。端末側の共通暗号形式と復旧コードは[暗号化クラウド保存の共通形式](ENCRYPTED_HOUSEHOLD_STORAGE.md)に定義します。現段階では送信・保存先・同意UIは未実装で、通常の端末内利用には影響しません。将来の保存先へ平文家計データ、復旧コード、復号鍵を送らず、Cloud account/Passkeyと復号鍵を分けます。

`.kmb` archiveにはActualブラウザー版の家計簿、KakeiMatchの端末記録、残っているレシート画像と明細CSVを含めます。復元時は内容を検証し、新しい端末profileとActual data directoryへstagingしてから、有効profileを切り替えます。Cloud credentials、session、AI token、利用権限、AI利用量、provider secretsは含めません。archiveは暗号化されません。詳細は[端末内データのバックアップと復元](LOCAL_BACKUP.md)を参照してください。

旧Next.js環境から移行する場合、Actual ZIPにはActual Budgetの取引だけが含まれます。legacy Next.jsには `.kmb` export機能がありません。`.kmb` はlocal-first PWAで作成した場合に限り、KakeiMatchの端末記録や残っているreceipt/statement原本も含みます。PWAはlegacy server SQLiteを直接読みません。旧Next.js環境のreceipt/statement metadataは自動移行されず、Actual ZIPにも含まれません。これらの記録が必要な場合は別途手動移行してください。Actual孤児データの特殊な整理制約はIssue #58で管理します。

MoneyForward CSVの移行も端末内で解析・登録します。元CSVは保存せず、移行履歴と対応ルールだけをIndexedDBと`.kmb`に保持します。未対応カテゴリの任意提案では、カテゴリ名と利用可能な選択肢だけを専用AI APIへ送ります。詳細は[マネーフォワードCSVからの移行](MONEYFORWARD_IMPORT.md)を参照してください。

## legacy実装

旧Next.jsアプリとserver adapterはlegacyまたは移行時の参照として残します。本番client、起動経路、家計データの正本ではありません。PWA production buildが共有するroot moduleは、browser-safeな15ファイルに限定しています。Vite pluginは実際のmodule graphを検査し、それ以外のroot moduleやlegacy runtime packageがbundleへ入る場合はbuildを失敗させます。詳細は[legacy文書index](legacy/README.md)と[legacy runtime inventory](LEGACY_RUNTIME_INVENTORY.md)を参照してください。現行PWAの動作と合成データによる確認手順は[ローカル利用フロー](LOCAL_FIRST_FLOW.md)に記載します。

お問い合わせでは、録音終了後に音声をGoogleへ送り自動で文字起こしします。利用者が許可した場合は、サーバー管理のProduct Contextと文章をGeminiへ送り、1問ずつの深掘りと送信前要約を行います。別途利用者が許可した場合だけ、メモリ上のFlight Recorderから固定語彙で構成した画面・操作・安全なエラーコード・通信状態を添付します。生ログ、stack trace、入力文字列、家計データは診断コンテキストに入りません。最終送信時はAIやGitHubを呼ばず、管理者専用Inboxへ保存します。管理者が確認してからマスキング済み情報だけをAI分析またはIssue化します。原文は秘密情報を除去して暗号化し、90日の保存期限を設けます。管理UI/APIはサーバー側の管理者認可と、設定済み環境ではCloudflare Access JWT検証で保護します。詳細は[お問い合わせ](CONTACT.md)を参照してください。

任意の端末内画面ロックはCloud accountと独立し、PINと復旧コードのsalt付きハッシュだけをブラウザーのlocalStorageへ保存します。生体認証での解除を有効にした場合は、端末のplatform authenticatorでuser verificationを必須にしたWebAuthn credentialを作り、credential IDと公開鍵だけを同じ設定へ保存します。解除時は端末内で生成したchallengeへの署名、origin、RP ID hash、user verification flagをブラウザー内で検証し、サーバーやCloud accountのPasskey認証には送りません。設定はhouseholdデータとは別で、`.kmb`バックアップには含めません。画面を隠す通常UIの保護であり、IndexedDBやActualの家計データの暗号化ではありません。
