# Cloud account

Cloud accountはAIなどのクラウド機能を使うためのアカウントです。家計簿の所有者アカウントではありません。Cloud accountを作らなくても、端末内の家計機能を利用できます。

## データ境界

| 端末内に保存する家計データ | Cloudflare D1に保存するアカウント情報 |
| --- | --- |
| Actual Budgetデータ | 利用主体（`user` 行。アカウントまたはゲスト端末） |
| レシートと画像 | 端末ごとのApp Attest鍵、ネイティブセッション、AI用の短期token |
| 明細ファイルとcanonical rows | entitlement（有料の付与（`pro`・`family`）のplanと月間上限）。それ以外は日次上限 |
| 照合状態と判断 | provider別・フロー別の利用数と料金の記録（HMACと段階の試行回数のみ） |
| | 問い合わせの受付記録（管理者だけが閲覧し、90日後に自動削除） |

D1には取引、店名・商品名などの履歴、レシート画像、明細CSVや明細行、照合結果、Actual Budgetのデータを保存しません。Cloudflareのuser IDを端末のprofile ID、Actual Budget ID、レシート所有者IDに使いません。

## 端末の認証（ネイティブ）

iOSアプリは専用 `/api/native/*` でApp Attestを検証し、ネイティブセッションを得ます。Web Cookieやブラウザーのsessionは使いません。ネイティブセッションは発行から14日後に失効し、利用に応じて延長しません。AI用tokenは専用audienceの不透明な値で、最大10分です。両者は別の有効期間です。ネイティブ要求の詳細は[ネイティブ認証境界](NATIVE_APP_AUTH.md)を参照してください。

Passkey・招待・回復・アカウント削除のAPIは退役しました（`/api/native/passkey/*`、`/api/native/auth/*`、`/api/native/account/*`）。これらは410を返します。過去にPasskeyでログインした利用者のネイティブセッションは、残りの有効期間のあいだ使えます。新しいアカウントのセッションは作られません。

設定不足やApp Attest非対応端末では無検証へ切り替えません。

## AI entitlementと利用量

planは `free`、`pro`、`family` です（`family` は内部IDで、利用者に表示する名前は「Plus」です）。新規の利用主体には付与（entitlement）がなく、AIは1日5回（Asia/Tokyoの暦日、`AI_GUEST_DAILY_LIMIT`）で数えます。付与は運用者が `account:set-plan` で書き込みます。

月間上限で数えるのは、有効なStoreKit購入がある利用者と、有料の付与（`pro`・`family`）がある利用者だけです。`free` の付与は月間上限を読まず、日次上限で数えます。`account:set-plan <id> free` は付与を消すため、「付与なし」と同じ扱いになります。`pro` は `AI_PRO_MONTHLY_LIMIT` を月間上限として書き込みます。`pro` の上限を `0` にすると、有効な購入がない利用者は0/月で止まります。有効な購入がある場合は購入が優先されます。proとPlus（`family`）はclientから設定できません。課金処理はこのIssueの範囲外です。

Plusは月間AI利用量の上限を持ちません。無制限は月間product quotaがないという意味で、provider料金が無制限という意味ではありません。短時間の不正利用を抑えるrate limitはPlusでも有効です。管理者はCloudflare D1に対する `account:set-plan` 運用commandでPlus（`family`）を割り当てます。command名や実行方法は[AI Gateway運用手順](../workers/ai-gateway/README.md)を参照してください。

利用量は `GET /api/native/ai/usage` で読みます。有効なStoreKit購入、または有料の付与（`pro`・`family`）がある利用者は `{plan, period: "month", month, used, limit, remaining, supportId}` を返し、月はAsia/Tokyoの暦月です。それ以外（付与なし、`free` の付与、ゲスト）は `{plan, period: "day", day, used, limit, remaining, supportId}` を返し、planはゲスト端末なら `guest`、それ以外は `free` です。unlimited planでは `limit` と `remaining` は `null` です。`supportId` は問い合わせのときに利用者を特定するための内部IDで、利用者には表示しません。

月間利用量はAsia/Tokyoの暦月単位で集計し、1レシート解析フローを1回として表示します。Geminiの読み取りと同じフロー内のGeminiカテゴリ分類を合わせて1回です。利用者が「AIで読み取る」を押すたびに新しいフローを作ります。形式検証後、最初のGemini送信直前に利用枠を予約します。認証失敗、形式検証失敗、利用枠超過は計上しません。provider呼び出し開始後のtimeoutと、壊れた応答は計上します（providerが処理して料金がかかった可能性があるため）。providerがエラーの状態コード（408・504を除く）を返した時は、読み取りが行われていないため計上しません。この場合も費用の記録は残し、全体の費用上限に含めます。同じフロー内の内部再試行は追加計上しません。

サーバーは認証済み利用者とフロー識別子を一意に結び付けます。画像とカテゴリ入力は、秘密鍵を使う検証用ハッシュ（HMAC）で結び付けます。カテゴリ入力はサーバーで検証したGemini抽出結果から構成します。利用者の申告だけで別の画像・カテゴリ入力を同じフローへ追加できません。D1には利用管理用の識別子、開始月・時刻、HMAC、段階ごとの試行回数だけを保存し、画像・店名・金額・商品・AI応答は保存しません。同じフローは開始から10分以内、各段階の初回を含め最大3試行までです。上限・期限に達したカテゴリ提案では、手動選択または明示的な再解析を案内します。各要求への既存のrate limitは別に維持します。月をまたぐ再試行・カテゴリ提案は開始月の1回に含めます。

お問い合わせの送信は利用枠に数えません。代わりに、管理画面のAI分析を含む問い合わせ系の要求に `CONTACT_RATE_LIMIT`（管理者ごと・1分5回）をかけます。

## 登録なしのAI利用（ゲスト）

アカウントを作らなくても、端末ごとにAIを1日5回（Asia/Tokyoの暦日、`AI_GUEST_DAILY_LIMIT`）使えます。ゲストは `POST /api/native/guest` でApp Attestを検証して作られ、通常のネイティブセッションと同じ経路でAI tokenを得ます。ゲストは `user` 行とネイティブセッションだけを持ち、利用量・費用の記録は利用主体と同じ表に付きます。Web版のゲスト作成（Turnstile）は退役しました。

いたずら防止として、接続元アドレスごとに1日のゲスト作成を10件、ゲストのレシート読み取りを合計20回までにします。アドレスは保存せず、暦日を鍵に含めたHMACだけを保存するため、元のアドレスへ戻せず、日をまたいで結び付けられません。全体の費用上限（下記）は最後の歯止めとして働きます。

ゲストの記録は利用量・費用・問い合わせ処理状態だけで、件数とHMACのほかに中身を含みません。家計データはもともとサーバーへ保存しません。ゲストを削除する操作は用意していません。削除して作り直せると、1日の上限をすり抜ける手段になるためです。

## APIと障害時の動作

iOSアプリは `/api/native/*` を使います。Service Workerは `/api/*` をキャッシュしません。Web向けの `/api/auth/*`・`/api/account/*`・`/api/ai/*`・`/api/contact*` は410を返します。

認証・AIサービスが利用できない場合でも実装済みの端末内機能は利用できます。レシート画面では、quota超過やprovider failure後も手動入力へ進め、保存済み画像を削除しません。

端末内データは、サーバーの認証状態や利用枠とは独立しています。既に別端末や外部サービスに渡ったデータを遠隔削除する機能はありません。課金契約・バックアップ・同期は別Issueの導入時に本経路へ接続します。

## 運用上の注意

Cloudflare Workerのsecretには、AI Gateway signing secret（`AI_GATEWAY_AUTH_SECRET`）、provider API keys、問い合わせ・管理画面用の値（`FEEDBACK_ENCRYPTION_KEY`、`GITHUB_ISSUES_TOKEN`、Cloudflare Accessの設定）を設定します。ネイティブ境界の値（`CLOUD_ACCOUNT_ORIGIN`、`NATIVE_APP_*`）は公開値ですが、本番と一致させます。Better Auth・bootstrap・Turnstileの値はWorkerの設定から参照しません（[デプロイ](DEPLOYMENT.md)を参照）。secret値や認証/request bodyをGit、browser bundle、通常ログへ出しません。D1 schemaは `workers/ai-gateway/migrations/` のversion管理されたmigrationで再現します。プレビューと本番の分離は[デプロイ](DEPLOYMENT.md)に従います。

## 開発者向けAPIコスト

製品の利用枠は従来どおり「レシート解析の1フローにつき1回」です。Geminiの読み取りとカテゴリ分類の送信回数・トークン数・料金を `ai_provider_cost_events` に記録します。同じフローの再試行も、実際に外部APIへ送信した要求ごとに記録します。認証・入力・利用枠・頻度制限で拒否した要求は記録しません。

利用者向けの月次料金APIは退役しました（`/api/ai/costs`、`/api/native/ai/costs`）。費用は運用者が `ai_provider_cost_events` と[AI費用の停止と再開](AI_COST_GUARDRAILS.md)の手順で確認します。[実装: worker.ts](../workers/ai-gateway/src/worker.ts)

計測には現行Gemini Interactions APIの `usage` と、GenerateContent形式の `usageMetadata` に対応します。カテゴリ分類のGemini Decisions APIの応答は、Interactions APIと同じ `usage` の項目として読み取ります（Decisionsは応答にモデル名を含まないため、Workerが送信したモデル `gemini-decision-1` の使用量として計測します）。思考トークンは出力料金に1回だけ加えます。キャッシュやツール等の未対応の料金要素、矛盾する使用量、未知のモデルは推測で0ドルにせず不明として扱います。[Google Interactions (2026/10), Usage](https://ai.google.dev/api/interactions-api)

## サービス全体の費用制限

利用者の製品利用枠と別に、全利用者合計の費用予算とprovider別の要求件数・費用上限を適用します。Plusも対象です。処理中・コスト不明の要求には予約額を残し、同時要求にも上限を適用します。障害・不明要求の増加ではprovider単位で停止します。停止は `503 ai_temporarily_paused` を返します。停止判定は製品利用回数の予約前に行います。並行要求が最終送信予約で競合した場合も、未送信のフロー予約を解放します。中断された未送信予約は120秒後に回収します。[実装: worker.ts](../workers/ai-gateway/src/worker.ts)

AI停止中も画像と確認値は端末に残り、手入力、カテゴリ選択、家計簿への登録を続けられます。停止設定と全利用者の費用は通常ユーザーへ公開しません。運用者向けの設定・停止・再開は[AI費用の停止と再開](AI_COST_GUARDRAILS.md)を参照してください。
