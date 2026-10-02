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

月間利用量はAsia/Tokyoの暦月単位で集計し、1レシート解析フローを1回として表示します。Geminiだけの読み取りでも、同じフロー内でJevのカテゴリ提案を使っても合計1回です。利用者が「AIで読み取る」を押すたびに新しいフローを作ります。形式検証後、最初のGemini送信直前に利用枠を予約します。認証失敗、形式検証失敗、利用枠超過は計上しません。provider呼び出し開始後のtimeoutや失敗は計上します。同じフロー内の内部再試行は追加計上しません。

サーバーは認証済み利用者とフロー識別子を一意に結び付けます。画像とカテゴリ入力は、秘密鍵を使う検証用ハッシュ（HMAC）で結び付けます。カテゴリ入力はサーバーで検証したGemini抽出結果から構成します。利用者の申告だけで別の画像・カテゴリ入力を同じフローへ追加できません。D1には利用管理用の識別子、開始月・時刻、HMAC、段階ごとの試行回数だけを保存し、画像・店名・金額・商品・AI応答は保存しません。同じフローは開始から10分以内、各段階の初回を含め最大3試行までです。上限・期限に達したカテゴリ提案では、手動選択または明示的な再解析を案内します。各要求への既存のrate limitは別に維持します。月をまたぐ再試行・カテゴリ提案は開始月の1回に含めます。

Issue #60の切替には `0003_receipt_ai_flows.sql` を適用してから、PWAとWorkerを同時に更新します。旧 `ai_usage` 行は履歴として保持し、新しい集計・利用枠には加算しません。旧provider単位・UTC月の履歴からフロー数を復元できないため、切替月は新方式で開始したフローのみ計上し、切替時点から利用枠を再付与します。過去分の補完は行いません。旧PWAの識別子なしの要求は拒否します。利用者はアプリを更新して再解析できます。既存・復元済みレシートの確認値、手入力、家計簿登録は継続できます。残り回数は0以上に制限します。ロールバック時は旧カウンタを利用するため、切替前の利用回数へ戻る点に注意してください。

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

## 開発者向けAPIコスト（Issue #117）

製品の利用枠は従来どおり「レシート解析の1フローにつき1回」です。GeminiとJevの送信回数・トークン数・料金は別の `ai_provider_cost_events` に記録します。同じフローの再試行も、実際に外部APIへ送信した要求ごとに記録します。認証・入力・利用枠・頻度制限で拒否した要求は記録しません。[実装: worker.ts](../workers/ai-gateway/src/worker.ts)

`GET /api/ai/costs?month=2026-10` は認証済みsession本人の月次料金だけを返します。利用者IDを要求から採用しません。月省略時はAsia/Tokyoの当月です。不正な月は400、未認証は401、保存領域の障害は503を返します。応答はUSD整数単位の `totalUsdMicros`、`unknownRequests` と、Gemini/Jevごとの要求件数・入力/出力トークン・料金・不明件数を含みます。全利用者の集計を返すAPIはありません。[実装: ai-provider-costs.ts](../workers/ai-gateway/src/ai-provider-costs.ts)

計測には現行Gemini Interactions APIの `usage` と、GenerateContent形式の `usageMetadata` に対応します。思考トークンは出力料金に1回だけ加えます。Jevは応答の版付きモデルIDと `usage.input_tokens` / `output_tokens` を使います。キャッシュやツール等の未対応の料金要素、矛盾する使用量、未知のモデルは推測で0ドルにせず不明として扱います。[Google Interactions (2026/10), Usage](https://ai.google.dev/api/interactions-api)、[Google GenerateContent (2026/10), UsageMetadata](https://ai.google.dev/api/generate-content)、[TypeSafe API (2026/10), Response](https://docs.typesafe.ai/api)、[実装](../workers/ai-gateway/src/ai-provider-costs.ts)

通常の設定画面には製品利用回数だけを表示します。「アプリ情報」の開発者向け機能を有効にすると、AIアカウント内に自分の月次推定料金と月切替を表示します。不明な要求は既知の料金合計に含められないため、件数を明示します。開発者設定は既定値OFFで、ブラウザー内の表示だけを制御します。家計バックアップやCloud account権限には使いません。無効にしても計測は続きます。[実装: PWA](../apps/pwa/src/main.ts)

## サービス全体の費用制限（Issue #56）

利用者の製品利用枠と別に、全利用者合計の費用予算とprovider別の要求件数・費用上限を適用します。Familyも対象です。処理中・コスト不明の要求には予約額を残し、同時要求にも上限を適用します。障害・不明要求の増加ではprovider単位で停止します。停止は `503 ai_temporarily_paused` を返します。停止判定は製品利用回数の予約前に行います。並行要求が最終送信予約で競合した場合も、未送信のフロー予約を解放します。中断された未送信予約は120秒後に回収します。[実装: worker.ts](../workers/ai-gateway/src/worker.ts)

AI停止中も画像と確認値は端末に残り、手入力、カテゴリ選択、家計簿への登録を続けられます。停止設定と全利用者の費用は通常ユーザーへ公開しません。開発者表示を有効にしても自分の料金だけを取得できます。運用者向けの設定・停止・再開は[AI費用の停止と再開](AI_COST_GUARDRAILS.md)を参照してください。
