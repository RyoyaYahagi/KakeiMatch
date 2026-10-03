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

Cloud accountは端末内の家計操作には不要です。Better AuthとPasskeyはアカウントとAI APIの本人確認に使います。D1には本人確認とsession、Passkey、招待・回復情報、利用権限、AI利用量・料金・制限情報、問い合わせの二重投稿を防ぐ処理状態だけを保存します。問い合わせ本文と音声はD1へ保存しません。取引、レシート画像、明細CSV、照合結果、Actual Budgetデータは保存しません。ログアウトしても端末の家計データは削除されません。

本人によるアカウント削除は、同一originと有効sessionをサーバーで確認し、D1のbatchで削除済みの不透明なuser IDをtombstoneへ記録してからuser行を削除します。認証情報、session、招待、利用権限、AI利用記録、問い合わせ処理状態は外部キーにより削除します。tombstoneは遅れて終わるPasskey登録から同じIDが復活するのを防ぐためにだけ保持し、氏名・email・認証情報を持ちません。AI用JWTは要求ごとにD1のuser行を確認してから使います。家計データは端末に残り、アカウント削除と連動して消しません。

AI要求は同一originの `/api/ai/*` を通します。Workerは認証、利用枠、要求形式、provider応答を検証します。利用者が選んだ場合だけ、レシート画像をGeminiへ送ります。カテゴリ提案では、検証済みの店名、合計金額、最大30件の商品名と金額だけをJevへ送ります。provider秘密鍵はWorker secretに保管し、ブラウザーbundleへ含めません。Cloud accountやネットワークを利用できない場合も、手入力、明細取込、照合、Actual Budgetの端末内操作を続けられます。

Service Workerは `/api/*` をcacheしません。Workerはブラウザー内のActualエンジンが必要とするCOOP/COEP response headerを維持します。いずれも本番構成の要件です。

## 端末内データの移行

Issue #38のクラウド保存は、明示同意後の暗号文のみを端末外へ送る追加経路として段階的に実装します。端末側の共通暗号形式と復旧コードは[暗号化クラウド保存の共通形式](ENCRYPTED_HOUSEHOLD_STORAGE.md)に定義します。現段階では送信・保存先・同意UIは未実装で、通常の端末内利用には影響しません。将来の保存先へ平文家計データ、復旧コード、復号鍵を送らず、Cloud account/Passkeyと復号鍵を分けます。

`.kmb` archiveにはActualブラウザー版の家計簿、KakeiMatchの端末記録、残っているレシート画像と明細CSVを含めます。復元時は内容を検証し、新しい端末profileとActual data directoryへstagingしてから、有効profileを切り替えます。Cloud credentials、session、AI token、利用権限、AI利用量、provider secretsは含めません。archiveは暗号化されません。詳細は[端末内データのバックアップと復元](LOCAL_BACKUP.md)を参照してください。

旧Next.js環境から移行する場合、Actual ZIPにはActual Budgetの取引だけが含まれます。legacy Next.jsには `.kmb` export機能がありません。`.kmb` はlocal-first PWAで作成した場合に限り、KakeiMatchの端末記録や残っているreceipt/statement原本も含みます。PWAはlegacy server SQLiteを直接読みません。旧Next.js環境のreceipt/statement metadataは自動移行されず、Actual ZIPにも含まれません。これらの記録が必要な場合は別途手動移行してください。Actual孤児データの特殊な整理制約はIssue #58で管理します。

## legacy実装

旧Next.jsアプリとserver adapterはlegacyまたは移行時の参照として残します。本番client、起動経路、家計データの正本ではありません。PWA production buildが共有するroot moduleは、browser-safeな12ファイルに限定しています。Vite pluginは実際のmodule graphを検査し、それ以外のroot moduleやlegacy runtime packageがbundleへ入る場合はbuildを失敗させます。詳細は[legacy文書index](legacy/README.md)と[legacy runtime inventory](LEGACY_RUNTIME_INVENTORY.md)を参照してください。現行PWAの動作と合成データによる確認手順は[ローカル利用フロー](LOCAL_FIRST_FLOW.md)に記載します。

お問い合わせでは、録音終了後に音声をGoogleへ送り自動で文字起こしします。利用者が許可した場合は、サーバー管理のProduct Contextと文章をGeminiへ送り、1問ずつの深掘りと送信前要約を行います。別途利用者が許可した場合だけ、メモリ上のFlight Recorderから固定語彙で構成した画面・操作・安全なエラーコード・通信状態を添付します。生ログ、stack trace、入力文字列、家計データは診断コンテキストに入りません。最終送信時に文章を分類し、不具合と改善要望はGitHub Issueへ登録します。最初の問い合わせと深掘り後の文章をIssueに残し、深掘り途中の本文・質問・回答、家計データ、アカウントの個人情報はD1へ保存しません。詳細は[お問い合わせ](CONTACT.md)を参照してください。

任意の端末内画面ロックはCloud accountと独立し、PINと復旧コードのsalt付きハッシュだけをブラウザーのlocalStorageへ保存します。設定はhouseholdデータとは別で、`.kmb`バックアップには含めません。画面を隠す通常UIの保護であり、IndexedDBやActualの家計データの暗号化ではありません。
