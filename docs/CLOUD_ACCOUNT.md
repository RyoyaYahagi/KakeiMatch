# Cloud account

Cloud accountはAIなどのクラウド機能を使うためのアカウントです。家計簿の所有者アカウントではありません。Cloud accountを作らなくても、端末内の家計機能を利用できます。

## データ境界

| 端末内に保存する家計データ | Cloudflare D1に保存するアカウント情報 |
| --- | --- |
| Actual Budgetデータ | Better Authのusers、sessions、passkeys |
| レシートと画像 | entitlement（planと月間上限） |
| 明細ファイルとcanonical rows | provider別の月間AI利用数 |
| 照合状態と判断 | 必要最小限の認証metadata |

D1には取引、店名・商品名などの履歴、レシート画像、明細CSVや明細行、照合結果、Actual Budgetのデータを保存しません。Cloudflareのuser IDを端末のprofile ID、Actual Budget ID、レシート所有者IDに使いません。

## Passkeyとsession

Passkey登録・認証にはBetter Authの公式Passkey pluginを使います。WebAuthnのchallenge生成、検証、replay対策をアプリ独自に実装しません。一般公開のsignupを無効にし、管理された招待で利用者を追加します。招待された人はPWAで一度限りの招待tokenを使い、自分のPasskeyを登録します。ログイン後は設定から複数のPasskeyを登録・一覧・削除できます。

アカウントsessionは初回から14日後に失効します。利用から24時間以上が経って再度使われると、その時点から14日後へ有効期限を延長します。cookieはHttpOnly、SameSite=Laxで、HTTPSではSecure属性を付けます。AI専用JWTは最大10分です。両者は別の有効期間です。有効なsessionがある限り、AI JWTの期限切れ後もPasskeyを求めず `/api/ai/token` から再取得できます。PWAはJWTをメモリ内だけに保持し、期限が近づいた場合にsession cookieを使って無人で更新します。ログアウト時にメモリ内JWTを破棄し、端末内の家計データは削除しません。[Better Auth session資料](https://better-auth.com/docs/concepts/session-management)を参照してください。

招待は一度だけ使え、有効期間は7日間です。管理者が `POST /api/account/invites` にメールアドレスと表示名を渡して新規利用者向け招待を発行します。招待tokenは `/?invite=...` として本人へ安全に渡します。Passkeyをすべて失った場合、管理者は本人を別経路で確認したうえで `POST /api/account/recovery` を使います。この操作は既存のPasskeyとsessionを無効にし、古い招待を失効させて、新しい招待を発行します。メールによる自動復旧は設定しません。Cloudflareまたは認証が停止しても端末内の家計データは保持されます。

## AI entitlementと利用量

planは `free`、`pro`、`family` です。初期設定では新規アカウントは `free` になり、既定の月間上限は30回です。freeの上限は `AI_FREE_MONTHLY_LIMIT` で一箇所から変更します。proとfamilyはclientから設定できません。課金処理はこのIssueの範囲外です。

Familyは月間AI利用量の上限を持ちません。無制限は月間product quotaがないという意味で、provider料金が無制限という意味ではありません。短時間の不正利用を抑えるrate limitはfamilyでも有効です。管理者はCloudflare D1に対する `account:set-plan` 運用commandでfamilyを割り当てます。command名や実行方法は[AI Gateway運用手順](../workers/ai-gateway/README.md)を参照してください。

月間利用量はUTCの暦月単位で集計し、GeminiとJevの合計回数を画面へ表示します。リクエストの形式検証後、providerへの送信直前に1回記録します。認証失敗、形式検証失敗、quota超過は記録しません。provider呼び出し開始後のtimeoutや失敗は記録します。再試行は新たなprovider呼び出しとして1回記録します。

`GET /api/ai/usage` は `{plan, month, used, limit, remaining}` を返します。unlimited planでは `limit` と `remaining` は `null` です。`POST /api/ai/token` はclientからuser IDを受け取らず、認証sessionのuser IDをJWTの `sub` として設定します。JWTは `aud: "kakeimatch-ai"` とし、署名秘密情報はserver-onlyです。

## APIと障害時の動作

同一originの `/api/auth/*`、`/api/account/*`、`/api/ai/token`、`/api/ai/usage`、`/api/ai/gemini`、`/api/ai/jev` を使います。Service Workerは `/api/*` をキャッシュしません。

認証・AIサービスが利用できない場合でも実装済みの端末内機能は利用できます。現在のPWAのレシート画面では、quota超過やprovider failure後も手動入力へ進め、保存済み画像を削除しません。Cloud accountのlogoutは端末内データに影響しません。

PWAはaccount状態、AI利用量、Passkey操作、token発行とレシート解析・カテゴリ提案を同一originで接続しています。現行の起動・配信手順は[デプロイ](DEPLOYMENT.md)を正本とします。

## 運用上の注意

Cloudflare WorkerのsecretにはBetter Auth signing secret、AI Gateway signing secret、bootstrap/invite secret、provider API keysを設定します。secret値や認証/request bodyをGit、browser bundle、通常ログへ出しません。D1 schemaは `workers/ai-gateway/migrations/` のversion管理されたmigrationで再現します。Issue #6のpreview環境はproduction Workerと分けます。

### Issue #6時点のpreview準備記録（履歴・フォールバック）

以下はIssue #6の実施記録です。Worker名とD1を現在の本番設定へそのまま流用しないでください。現在のpreviewと本番の選択は[デプロイ](DEPLOYMENT.md)に従います。`wrangler` の例は当時の `cf` 未対応操作のフォールバックであり、通常のdeploy手順ではありません。

プレビュー環境の準備では、まず `cf --help` と `cf cli search` で現行コマンドを確認します。プレビュー専用D1を `cf d1 create --name <preview-db-name>` で作成し、`apps/pwa/cloudflare.config.ts` の `ACCOUNT_DB` にその名前とIDを設定します。次に `workers/ai-gateway` から `cf d1 migrations apply <preview-db-id> --dir ./migrations` を実行します。PWAは `apps/pwa` から `cf previews deploy kakeimatch-issue-6` で配信します。これらの操作は本番Workerと本番D1を更新しません。[Cloudflare D1 migration資料](https://developers.cloudflare.com/d1/reference/migrations/)を参照してください。

`CLOUD_ACCOUNT_ORIGIN` はブラウザーが開く配信元の完全なoriginに設定します。Previewでは安定したPreview URL、productionでは本番PWAのoriginを使います。RP IDはそのoriginのhostです。ローカル開発では `localhost` または `127.0.0.1` だけを許可し、実際のportを含めたoriginでアクセスします。別originのPasskeyは共有できません。[Better Auth Passkey設定資料](https://better-auth.com/docs/plugins/passkey)を参照してください。

今回使用した `cf` 1.0.0-beta.5 にはPreview個別のsecret設定コマンドが見つからなかったため、公式の `wrangler` 4.144.0 の `preview secret bulk` を使用しました。秘密値を含むJSONファイルはGit管理外に置き、`BETTER_AUTH_SECRET`、`ACCOUNT_BOOTSTRAP_SECRET`、`AI_GATEWAY_AUTH_SECRET`、`CLOUD_ACCOUNT_ORIGIN` を設定します。Gemini/Jevの実呼び出し時には各provider keyも必要です。`cf previews deploy` の後にPreviewへsecretを再設定し、認証APIが利用可能か確認します。[Cloudflare Preview secret資料](https://developers.cloudflare.com/workers/previews/configuration/)を参照してください。

```sh
npx wrangler@4.144.0 preview secret bulk /private/path/preview-secrets.json \
  --name kakeimatch-issue-6 --worker-name kakeimatch-issue-6-preview
```
