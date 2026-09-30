# KakeiMatch PWA

`apps/pwa` は現在の主アプリです。Viteで生成したPWAをCloudflare Workers Static Assetsで配信し、認証・AI用APIを同一originのWorker routeで提供します。移行前のNext.jsアプリはlegacy実装として残し、Issue #39で削除を判断します。

Issue #37 preview: [https://kakeimatch-issue-37-kakeimatch-issue-37-preview.yhgry.workers.dev](https://kakeimatch-issue-37-kakeimatch-issue-37-preview.yhgry.workers.dev)

## 現在利用できる機能

- Actual Budgetを端末内で開き、支出を表示する
- レシート画像を端末内へ保存し、手入力または任意のAI抽出を行う
- ユーザーが確認したレシートをActual Budgetへ登録する
- PayPayの対応CSVを端末内で読み込み、重複を除いて保存する
- 保存済みレシートとPayPay明細を照合し、判断とActualへの反映状態を端末に保存する
- 設定画面からActual家計簿と端末データ、残っている画像・CSV原本を `.kmb` に書き出し、新しいprofileへ復元する
- 保存済み原本を条件付きで整理し、確認後に端末内の家計データをまとめて削除する
- Cloud accountへログインしてAIを利用する。ログアウト後も端末内の家計データを保持する

レシート画像は10 MiBまで端末に保存できます。AI Gatewayの画像上限は6 MiBです。上限を超えた画像も手入力に使えますが、AIへは送信できません。CSVは端末内で処理し、CloudflareやAI providerへ送りません。明細CSVは現在PayPayの限定された公式形式のみ対応し、三井住友カード、楽天カード、イオンカードは安全に解釈できる列仕様が未確認のため取り込めません。

## 開発

リポジトリのルートで次を実行します。

```sh
corepack pnpm --dir apps/pwa typecheck
corepack pnpm --dir apps/pwa build
```

Preview Workerの設定は `cloudflare.config.ts` にあります。previewは `kakeimatch-issue-37` というWorker名を使います。deploy操作はこの文書の開発手順には含めません。

## iPhoneでの確認

実機での確認はまだ完了していません。`.kmb` のFiles保存、復元後の再読込、原本整理、全消去の合成手順は[端末内バックアップの確認手順](../../docs/LOCAL_BACKUP.md#iphone-previewでの合成確認)にあります。Gemini/TypeSafeへの実要求とActual Sync Serverとの同期も未確認です。復元途中のActual importを完全削除できない可能性が検出された場合は、アプリからの全消去を停止し、元データのバックアップ後にブラウザーのサイトデータ削除を案内します。確認に使ったレシート・家計簿・CSVはテスト専用profileでのみ扱ってください。

## 合成データによるブラウザー試験

`test:e2e` は新しいブラウザープロファイルで実際の家計簿エンジンを使います。AIの応答だけを代替し、レシート保存・修正・登録、PayPay重複取込、照合と判断、オフライン再起動・手入力登録を確認します。AIの代替応答がService Workerを経由しないよう、試験ではAI操作後にService Workerを登録します。

```sh
corepack pnpm --dir apps/pwa exec playwright-core install chromium
PWA_E2E_URL=https://<専用preview> corepack pnpm --dir apps/pwa test:e2e
```

必要なら `PWA_BROWSER_PATH` でChromiumの実行ファイルを指定できます。実AIへの通信やiPhone実機の検証を代替する試験ではありません。

`test:auth-e2e` は専用previewに合成アカウントを作り、仮想Passkeyによる登録・ログイン・sessionからのAI認証・ログアウトを確認します。`PWA_ACCOUNT_SECRET_FILE` にpreview専用bootstrap secretのJSONファイルを指定してください。秘密情報のファイルはリポジトリ外へ置きます。この試験は実際のiPhoneのPasskey操作を代替しません。
