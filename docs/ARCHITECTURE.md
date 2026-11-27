# アーキテクチャ

利用者向けアプリは `apps/ios` の iOS アプリです。家計データは利用者の端末に保存します。`workers/ai-gateway` はネイティブ API、管理画面、アカウントや運用に必要な D1 データを担当します。

## 本番構成

- iOS アプリは `/api/native/*` を利用します。Associated Domains の関連付けには AASA を配信します。
- 管理画面と管理 API（`/admin`、`/api/admin/*`）は Cloudflare Access と Worker の管理者認可で保護します。
- 旧 PWA の経路には Worker が HTTP 410 を返します。Cloudflare Access の対象では未認証のリクエストが先にログイン画面へ転送されます。

本番 origin は `https://kakeimatch.yhgry.workers.dev` です。App Attest の検証対象の host（RP ID）と Associated Domains に関係するため、この origin を維持します。プレビューは別 origin と合成データを使います。

## データ境界

iOS アプリは取引、レシート、取り込んだ明細、照合結果を端末内に保存します。明細解析、照合、状態変更、金額処理は通常コードで行います。

Cloud accountは端末内の家計操作には不要です。App Attest の鍵とネイティブセッションで本人確認を行い、Web の認証と Passkey は S6・S7 で撤去しました。D1には鍵の登録情報とネイティブセッション（ハッシュ）、利用主体（アカウント・ゲスト）、利用権限、AI利用量・料金・制限情報、問い合わせの二重投稿を防ぐ処理状態、マスキング済み問い合わせと許可された診断情報、暗号化した原文、管理操作の監査ログを保存します。音声はD1へ保存しません。取引、レシート画像、明細CSV、照合結果、Actual Budgetデータは保存しません。ログアウトしても端末の家計データは削除されません。

アカウント削除は S7 で撤去しました（`/api/native/account/*` は410）。削除済みの利用者 ID の再利用を防ぐ tombstone 表は残します。家計データは端末に残ります。

AI 要求は iOS からネイティブ API を通します。Workerは認証、利用枠、要求形式、provider応答を検証します。利用者が選んだ場合だけ、レシート画像をGeminiへ送ります。レシート分類では、検証済みの店名・合計金額・最大30件の商品名と金額に加え、候補カテゴリのID・名称と分類基準をGemini Decisions API（`POST /v1beta/decisions`、モデル `gemini-decision-1`）へ送ります。レシート画像の読み取りはGemini Interactions APIです。MoneyForwardのカテゴリ対応候補では、変換元カテゴリ名と候補カテゴリのID・名称を送ります。分類はレシート読み取りと共通の `GEMINI_API_KEY`、費用予約・計測、rate limit、circuitを使います。分類のモデルはWorkerのコードで `gemini-decision-1` に固定し、`GEMINI_MODEL` はInteractions APIを使うレシート読み取りなどの設定で、分類には使いません。分類応答は選択肢・全候補の確率・confidenceをWorkerで検証します。Gemini要求が失敗した場合は別providerへ送らず、分類を停止します。Cloud accountやネットワークを利用できない場合も、手入力、明細取込、照合、端末内の家計操作を続けられます。



給与明細の読み取りもネイティブの AI 境界を通します。

## iOS ネイティブのクラウドAPI

iOSのAPI層は、App Attestで検証する専用 `/api/native/*` を使います。家計データの正本や通常の端末内操作はCloud accountに依存しません。Webの認証経路を緩めず、ネイティブセッション・短期tokenを既存のWeb Cookie/JWTと分離します。検証後のAI処理は既存の利用枠・接続元制限・費用停止を通します。AASA、必要設定、追加D1表、実機確認の残件は[ネイティブ認証境界](NATIVE_APP_AUTH.md)に定義します。API層の追加であり、認証画面・家計サービスへの接続までの完成を意味しません。

## iOSのGoogle Driveへの書き出し

iOSアプリは、利用者が設定で明示的に有効にした場合だけ、本人のGoogle Driveへ直接スナップショットを書き込みます。書き込みはアプリの起動時・前面復帰時と「今すぐ保存」に行い、家計データは開発者のCloudflare Worker・D1・R2を通りません。アプリが要求する権限は `drive.file` だけに限定し、アプリが作った `KakeiMatch/snapshot.json` の作成と上書き、およびフォルダ作成の3操作以外は行いません。アプリはDriveから読み込まず、削除・権限変更もしません。既定はOFFで、OFFの間は自動・手動ともDriveへ書き込みません。保存済みのGoogle Sign-Inの復元は、ONのときと、利用者が設定ページを開いたときだけ行います。詳細は[Museへの読み取り専用スナップショット](MUSE_SNAPSHOT.md)を参照してください。

## 端末内データの移行

Issue #38のクラウド保存は、明示同意後の暗号文のみを端末外へ送る追加経路として段階的に実装します。端末側の共通暗号形式と復旧コードは[暗号化クラウド保存の共通形式](ENCRYPTED_HOUSEHOLD_STORAGE.md)に定義します。現段階では送信・保存先・同意UIは未実装で、通常の端末内利用には影響しません。将来の保存先へ平文家計データ、復旧コード、復号鍵を送らず、Cloud accountと復号鍵を分けます。

旧 PWA の `.kmb` は iOS へ取り込めます。iOS のバックアップ形式は `.kmib` です。

旧Next.js環境から移行する場合、Actual ZIPにはActual Budgetの取引だけが含まれます。legacy Next.jsには `.kmb` export機能がありません。`.kmb` はlocal-first PWAで作成した場合に限り、KakeiMatchの端末記録や残っているreceipt/statement原本も含みます。旧 PWA は legacy server SQLite を直接読み込みませんでした。旧Next.js環境のreceipt/statement metadataは自動移行されず、Actual ZIPにも含まれません。これらの記録が必要な場合は別途手動移行してください。Actual孤児データの特殊な整理制約はIssue #58で管理します。


## legacy実装

旧 Next.js アプリとサーバーアダプターは移行時の参照として残します。旧 PWA のリポジトリ上の最終状態は `pwa-final` タグにあります。過去の構成は [legacy 文書](legacy/README.md) を参照してください。

## お問い合わせと管理画面

iOS から明示的に送信されたお問い合わせを管理者専用の受信箱に保存します。管理者は内容を確認してから AI 分析や Issue 作成を実行できます。Issue にはマスキング済み情報だけを送ります。暗号化した原文とマスキング済み本文の保存期限は90日です。管理画面と管理 API の動作は [Gateway の README](../workers/ai-gateway/README.md) を参照してください。
