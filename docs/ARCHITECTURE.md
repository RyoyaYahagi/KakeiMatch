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
├─ /api/auth/* と /api/account/*
├─ /api/ai/*
└─ D1: 本人確認 / session / Passkey / 招待・回復 /
       利用権限 / AI利用量のみ
```

本番の正規originは `https://kakeimatch.yhgry.workers.dev` です。ブラウザー保存領域はoriginごとに分かれるため、利用開始後にWorker名やoriginを変えると、保存済みデータが見えなくなることがあります。このoriginを安定して維持してください。previewは別originを使い、合成データ専用とします。家計データをpreviewで開かないでください。

## データ境界

Actual Budgetのブラウザー版は家計簿を端末内に保存します。KakeiMatchはレシート情報と画像、取り込んだ明細、照合run・判断、登録状態をブラウザー内に保存します。明細解析、照合、状態変更、金額処理は決定的な通常コードで行います。これらの家計データをアプリ用データベースへ送りません。

Cloud accountは端末内の家計操作には不要です。Better AuthとPasskeyはアカウントとAI APIの本人確認に使います。D1には本人確認とsession、Passkey、招待・回復情報、利用権限、月ごとのAI利用量だけを保存します。取引、レシート画像、明細CSV、照合結果、Actual Budgetデータは保存しません。ログアウトしても端末の家計データは削除されません。

AI要求は同一originの `/api/ai/*` を通します。Workerは認証、利用枠、要求形式、provider応答を検証します。利用者が選んだ場合だけ、レシート画像をGeminiへ送ります。カテゴリ提案では、検証済みの店名、合計金額、最大30件の商品名と金額だけをJevへ送ります。provider秘密鍵はWorker secretに保管し、ブラウザーbundleへ含めません。Cloud accountやネットワークを利用できない場合も、手入力、明細取込、照合、Actual Budgetの端末内操作を続けられます。

Service Workerは `/api/*` をcacheしません。Workerはブラウザー内のActualエンジンが必要とするCOOP/COEP response headerを維持します。いずれも本番構成の要件です。

## 端末内データの移行

`.kmb` archiveにはActualブラウザー版の家計簿、KakeiMatchの端末記録、残っているレシート画像と明細CSVを含めます。復元時は内容を検証し、新しい端末profileとActual data directoryへstagingしてから、有効profileを切り替えます。Cloud credentials、session、AI token、利用権限、AI利用量、provider secretsは含めません。archiveは暗号化されません。詳細は[端末内データのバックアップと復元](LOCAL_BACKUP.md)を参照してください。

旧Next.js環境から移行する場合、Actual ZIPにはActual Budgetの取引だけが含まれます。legacy Next.jsには `.kmb` export機能がありません。`.kmb` はlocal-first PWAで作成した場合に限り、KakeiMatchの端末記録や残っているreceipt/statement原本も含みます。PWAはlegacy server SQLiteを直接読みません。旧Next.js環境のreceipt/statement metadataは自動移行されず、Actual ZIPにも含まれません。これらの記録が必要な場合は別途手動移行してください。Actual孤児データの特殊な整理制約はIssue #58で管理します。

## legacy実装

旧Next.jsアプリとserver adapterはlegacyまたは移行時の参照として残します。本番client、起動経路、家計データの正本ではありません。PWA production buildが共有するroot moduleは、browser-safeな12ファイルに限定しています。Vite pluginは実際のmodule graphを検査し、それ以外のroot moduleやlegacy runtime packageがbundleへ入る場合はbuildを失敗させます。詳細は[legacy文書index](legacy/README.md)と[legacy runtime inventory](LEGACY_RUNTIME_INVENTORY.md)を参照してください。現行PWAの動作と合成データによる確認手順は[ローカル利用フロー](LOCAL_FIRST_FLOW.md)に記載します。
