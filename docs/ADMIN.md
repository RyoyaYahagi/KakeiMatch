# 管理画面

Issue #234の管理画面は `/admin`、問い合わせInboxは `/admin/feedback`、AI費用は `/admin/ai`、エラーは `/admin/errors`、Cloud account一覧は `/admin/users` です。通常のPWAとは別のHTMLとJavaScriptを使い、Actual Budgetや端末内の家計データを読み込みません。家計の利用分析イベントは収集しません。

## 認証と認可

管理ページ（`/admin`、`/admin/*`、`/admin.html`）と `/api/admin/*` のすべての要求は Cloudflare Access の認証のみで保護し、PWAのBetter Auth session や cookie には依存しません。

Worker側では次の3つの設定がすべて必須です。いずれかが未設定、または片方だけ設定されている場合は、ローカル環境を含めて素通りさせず `503`（`admin_not_configured`）で拒否します。

- `CF_ACCESS_TEAM_DOMAIN`: Cloudflare Access のチームドメイン（`https://<team>.cloudflareaccess.com`）
- `CF_ACCESS_AUD`: 対象 Access application の audience（`aud`）
- `ADMIN_ACCESS_EMAILS`: 管理を許可するメールアドレスの許可リスト（Cloudflare Secret binding）。書式はカンマ区切り（例: `admin@example.com,ops@example.com`）で、各要素の前後の空白は無視し、大文字・小文字を区別せず照合します。

`ADMIN_USER_IDS` は後続段の整理まで設定定義のみ残置していますが、認可判定には使用しません。

すべての管理要求で `Cf-Access-Jwt-Assertion` ヘッダーの RS256 署名、`iss`、`aud`、`exp` / `nbf` に加え、`email`（許可リスト一致）と `sub` の存在を検証します。JWT がない場合、署名不正、audience 不一致、期限切れ、許可されていない `email`、`email` を持たないサービストークンは `403` で拒否します。管理操作（`GET` 以外、および `Origin` ヘッダーが付与された要求）は同一 origin からの要求だけを受け付けます。

管理画面の AI 分析における利用量・原価の記録先には、マイグレーション `workers/ai-gateway/migrations/0019_admin_operator_principal.sql` で追加する運営者用の利用主体（`admin-operator` / `operator@kakeimatch.invalid`）を使用します。`admin-operator` は概要の登録アカウント数と `/api/admin/users` の一覧から除外します。

`/admin.html` の直接取得も同じ認可を通します。管理ページ/APIは `Cache-Control: no-store` を返し、Service Workerは `/admin`、`/admin/*`、`/admin.html`、すべての `/api/*` を扱いません。管理画面のコードは秘密情報を含まない静的assetです。設定の通常画面には運用費用の入口を置きません。

## Cloudflare Access

Accessのself-hosted applicationで `/admin` とその配下、`/admin.html`、`/api/admin` とその配下を保護します。管理者だけを許可するAllow policyを使い、Bypassや一般公開のpolicyを作りません。複数applicationを使う場合も、Workerに設定するaudienceでこれらの経路をカバーする必要があります。署名検証はAccessの公式手順に従います。[Cloudflare Access (2026/10), Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

CLIを使う際は、実行時点の `cf cli search 'Create a self hosted Access application'` でcommandを確認します。今回のCLIでは `cf zero-trust access applications create` と `cf zero-trust access applications policies create` が見つかりました。`cf schema zero-trust access applications create` と `--help` でAPI bodyを確認し、対象account・hostname・管理者policyを固定した設定を管理してください。本PRはAccess applicationの作成や本番deployを行いません。

## Inboxと公開

最終問い合わせ送信はAIもGitHubも呼ばず、D1のInboxへ保存します。`contact_submissions` は冪等性メタデータの役割を維持します。`feedback_submissions` には秘密除去・暗号化した原文、マスキング済み本文、固定語彙だけの診断、AI要約、Issueへの参照、保存期限を持ちます。音声、レシート画像、明細、家計データは管理機能で収集しません。

原文は必要なときだけ表示します。AI分析にはマスキング済み本文と診断情報だけを送り、既存の費用計測、緊急停止、providerごとの料金上限とcircuit保護を適用します。利用者向けのレシート回数枠には加算しません。

Issue作成時は管理者が公開用のタイトル・本文を編集して確認します。サーバーは公開用の文章を再度マスキングし、診断情報と `feedback_id` を添えます。原文を自動で本文へ追加しません。機械的マスキングで任意の氏名や家計内容を完全に取り除ける保証はないため、公開前に本文を確認してください。Issue作成の処理中・結果不明は再投稿を止めます。GitHubのIssueと `kakeimatch-feedback:<feedback_id>` マーカーを照合して運用上の判断を行います。

## 保存期限と監査

受付から90日を保存期限にします。毎日03:00（日本時間）のscheduled handlerで期限切れの本文と暗号化原文を削除し、管理APIを利用した際にも回収します。問い合わせの削除・アカウント削除時も本文は削除します。受付の冪等性メタデータと、本文を含まない監査ログは別に残します。

原文表示、AI分析、Issue作成、status変更、削除は `admin_audit_log` に管理者識別子（`access:<sub>`）、action、target ID、時刻だけを保存します。`GET /api/admin/audit` は管理者だけが取得できます。外部APIへ送る前にも要求を記録し、分析や投稿が失敗した場合でも操作を追跡できます。本文、API key、Cookie、Authorizationは監査ログへ入れません。

## 導入と確認

Worker更新前に `workers/ai-gateway/migrations/0016_feedback_inbox.sql` および `workers/ai-gateway/migrations/0019_admin_operator_principal.sql` を既存のaccount用D1へ適用します。`FEEDBACK_ENCRYPTION_KEY` は独立した32バイトのランダム鍵をBase64で表し、Secret bindingへ登録します。未設定・不正な場合は問い合わせを保存できません。`CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`、`ADMIN_ACCESS_EMAILS`、本番のAccess設定、GitHub投稿用の限定tokenを確認してください。秘密値をCLI引数、Git、PR、チャットへ書きません。

費用は既存のprovider cost eventから集計します。エラーは安全なprovider error codeの直近30日分です。クライアントの任意ログを収集せず、local-firstの境界を維持します。非管理者の拒否、管理者の成功、本文のマスキング、Issue作成の冪等性、費用制限、キャッシュ除外を合成データで検証します。本番D1へのmigration、Secret登録、Accessの設定と実動作、実provider・GitHub投稿、iPhone実機は公開前に確認してください。

## 外部資料

[Cloudflare Access, 2026/10] Cloudflare. “Validate JWTs.” Cloudflare One docs. https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
