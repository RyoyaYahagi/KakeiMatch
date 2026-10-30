# iOS API 層（Issue #240 Phase 6）

## 結論と実装範囲

`API/KMWorkerAPI.swift` はネイティブ専用 Worker 境界の通信アダプターです。Passkey 操作は `AuthenticationServices` adapter、App Attest は `DeviceCheck` adapter に分離し、どちらもprotocol stubで置き換えられます。画面と `Data/` は変更しません。通常の家計操作はCloud accountへ依存させません。[構成: docs/ARCHITECTURE.md、実装: API/KMWorkerAPI.swift / KMNativeSecurity.swift]

**既定の `.native` は全要求で Origin / Cookie を送らず、`/api/native/*` のみを呼びます。** App Attestが非対応の端末ではネイティブのクラウド機能を停止し、TurnstileやPWA経由へfallbackしません。`.existingWorkerCompatibility` は従来Worker APIを使う明示的な互換モードで、アプリ真正性の証明ではありません。Worker側も本PRで実装し、合成証明書・Passkey・D1のテストを追加しました。署名済み実機から実サーバーへの通信は未確認です。[Workerの設計と公開前手順](../../../docs/NATIVE_APP_AUTH.md)を参照してください。

```swift
// Preview は合成データ専用。資格情報の Keychain service も host ごとに分かれる。
let config = try KMAPIConfiguration(
    baseURL: URL(string: "https://preview.example.test")!,
    originPolicy: .native
)
let api = KMWorkerAPI(configuration: config)
```

本番の既定 URL は `https://kakeimatch.yhgry.workers.dev`。HTTPS origin のみ許可し、userinfo・path・query・fragment・非標準 port は拒否します。Keychain service はhost別で、`WhenUnlockedThisDeviceOnly`・同期なしです。session、guest session、App Attest key IDは分離して保存し、短期AI tokenは再起動後に復元しません。provider API key、bootstrap secret、JWT署名鍵は端末へ持ちません。自動再試行、redirect追従、HTTP cache、共有Cookie jarを使いません。[実装: API/KMCloudCredentials.swift、API/KMWorkerAPI.swift]

## Native API と端末認証

`.native` のURLは `/api` を `/api/native` に置き換えます。`GET /api/native/config` は端末認証前に確認できる公開情報です。鍵登録とPasskey開始も専用のchallenge経路を使い、検証完了まではaccount sessionを発行しません。設定値がない場合はWorkerの `available:false` を表示し、その他のnative要求は `503 not_configured` などの理由で失敗として扱います。成功要求にもOrigin/Cookieを付けません。

| 操作 | native要求と検証 |
| --- | --- |
| 設定 | `GET /api/native/config`。`available`、`rpId`、`appAttestEnvironment` の相互整合を検証。RP IDは接続hostと一致必須 |
| 鍵登録 | 一度だけ `DCAppAttestService.generateKey()` し、Appleが返すcanonical標準base64・32-byte key IDをhost別Keychainへ保存。challengeはcanonical base64urlで、復号後が必ず32 byte・120秒以内。`attestKey` のclientDataHashはその32 byteへのSHA-256。成功登録フラグを保存し、以後attestしない。失敗時に別鍵を自動生成しない |
| ゲスト | `purpose:guest` challenge後にApp Attest assertionを送り、`POST /api/native/guest` の43文字sessionToken・最大14日期限を保存。Turnstileの既存 `createGuest` はnative modeで拒否 |
| AI token | `purpose:token` challengeとNative sessionによるApp Attest assertionで43文字・最大600秒のopaque tokenを取得。残り30秒を超える間だけメモリcacheを再利用し、Keychainへ保存しない。contact以外のAI要求はBearer opaque token、account/usage/costsはNative sessionを使う |
| Passkey | `POST /api/native/passkey/options` のBetter Auth optionsからcanonicalな32-byte challengeを復号し、明示された `rpId` または `rp.id` が接続hostと一致する場合だけ `ASAuthorizationPlatformPublicKeyCredentialProvider` へ渡す。RP IDをhostへ補完しない。招待登録はcontextを渡し、Passkey追加（contextなし）はNative account sessionで認証する。登録では `user.id`、認証では存在する `allowCredentials` も復号して渡す。platform requestはuser verificationをrequiredにする。verify時のApp Attest hashはoptions.challenge bytesのSHA-256。Workerだけがchallenge状態を保持し、端末Cookie jarは使わない |
| その他 | 既存APIのmethod/body/response schemaを維持してnative pathへ移行。signout・account deleteではaccount sessionとAI tokenを消し、guest session・家計データは保持 |

SimulatorまたはApp Attest非対応端末はnativeクラウド認証・AI利用を行いません。ローカル家計機能は別境界なので継続します。Fake adapterでのテスト成功はAppleサービス・実端末・実Workerの成功を意味しません。`project.yml`はTeam IDを含まず、`KM_DEVELOPMENT_TEAM` は署名環境から指定します。`KM_APP_ATTEST_ENVIRONMENT` はbuild configurationごとの既定値を持ち、Debugは `development`、Releaseは `production` です。`KM_NATIVE_HOST` は `kakeimatch.yhgry.workers.dev` が既定値で、アプリの `KMNativeAPIHost` と `webcredentials:` entitlementの両方へ同じbuild settingを渡します。preview buildではこの値をpreview hostへ上書きし、previewのAPI URLとAssociated Domainsを一緒に切り替えます。本番entitlementのままpreview URLだけを指定してはいけません。`KMAPIConfiguration` はアプリbundleの `KMNativeAPIHost` を既定接続URLに使い、値が欠損・不正なら初期化を失敗させます。テスト等の明示URL注入以外にhost discoveryやproduction hostへのfallbackを行いません。Workerのconfig応答で `rpId == 接続host` を検査し、不一致は拒否します。previewは本番と異なるRP ID / Keychain serviceを使います。

Apple公式資料では、Passkey用platform providerの役割とRP ID指定、App Attestの端末側鍵生成・attestation/assertion、Associated Domainsのwebcredentials entitlementが定義されています。実装は公式APIの責務に留め、server-side検証を端末で代替しません。[Apple Passkeys: `ASAuthorizationPlatformPublicKeyCredentialProvider` / “Supporting passkeys”; Apple DeviceCheck: `DCAppAttestService` / “Establishing your app’s integrity”; Apple Xcode: “Supporting associated domains”]

## endpoint 一覧（従来Worker互換モード）

この節の正本は `apps/pwa/src/worker.ts`、`workers/ai-gateway/src/{worker,guest-ai,account-auth,contact,feedback,payroll-schema,ai-provider-costs}.ts`。認証 plugin 部分は lockfile が固定する Better Auth / Passkey **1.7.6** の配布ソース（`dist/api/routes/{session,sign-out}.mjs`、Passkey `dist/index.mjs`）も確認した。下表の JSON は省略記法であり、`?` はキー省略可、`T|null` はキー必須・null 許可を表す。[Worker (2026/10), routing / schemas; Better Auth (2026/10), routes]

認証記号: **S** = サーバーが検証した Better Auth session Cookie、**G** = `Authorization: Guest <43文字の端末合言葉>`、**B** = `Authorization: Bearer <10分のAI JWT>`、**O** = 接続先 origin と一致する Origin ヘッダー必須。GET で Origin を付ける場合も一致が必要（guest config は検査しない）。B の `sub` はサーバーが決め、要求に user ID を入れない。[Worker (2026/10), handleRequest / authenticate; Account (2026/10), getAccountSession]

| method / path | request | response schema | 認証 / iOS 実装 |
| --- | --- | --- | --- |
| GET `/api/ai/guest` | なし | `{guestAvailable:Bool,turnstileSiteKey:String|null}` | 公開、実装済み |
| POST `/api/ai/guest` | `{turnstileToken:String(1…2048)}`、4 KiB以下 | 201 `{guestSecret:base64url(43)}` | O + Turnstile、通信のみ。確認UIなし |
| POST `/api/ai/token` | bodyなし | `{token:JWT,expiresAt:Unix秒Int}` | S または G、O、実装済み |
| GET `/api/ai/usage` | なし | アカウント `{plan:free|pro|family,period:month,month:YYYY-MM,used:Int,limit:Int|null,remaining:Int|null}` / ゲスト `{plan:guest,period:day,day:YYYY-MM-DD,used:Int,limit:Int,remaining:Int}` | S または G。B では取得しない。実装済み |
| GET `/api/ai/costs?month=YYYY-MM` | month省略時は日本の当月。iOSは明示指定 | `{month,currency:USD,totalUsdMicros:Int,unknownRequests:Int,providers:{gemini:Cost,jev:Cost}}` | S のみ、実装済み |
| POST `/api/ai/gemini` | `{flowId:UUIDv4,imageBase64,contentType:image/jpeg|image/png|image/webp}` | Receipt（下記） | B + O、実装済み |
| POST `/api/ai/payroll` | 上記 + `{maskingConfirmed:true}` | `{extraction:Payroll,model:String(1…100),promptVersion:payroll-v1}` | B + O、実装済み |
| POST `/api/ai/jev` | `{flowId,receipt:{merchant:String|null,totalAmountYen:Int|null,items:[{name,amountYen:Int|null}]},categories:[{id,name}],itemIndexes?:[Int]}` | `{model:String,answers:{categoryまたはitem_N:Choice}}` | B + O、実装済み |
| POST `/api/ai/category-suggestion` | `{flowId,sourceCategoryName:String(1…200),categories:[{id,name}]}` | `{categoryId:候補内ID|null}` | B + O、実装済み |
| POST `/api/contact` | `{flowId,kind:bug|improvement|question,message:String(1…4000),originalMessage?:String(1…4000),diagnostic?:Diagnostic}`、20 KiB以下 | `{feedbackId,kind,reply,issueUrl:null}` | B + O。PWA / iOS は account のみ。通信実装済み、diagnostic送信は未実装 |
| POST `/api/contact/transcribe` | `{flowId,audioBase64,contentType:audio/mp4|audio/webm|audio/ogg|audio/wav|audio/mpeg}` | `{text:String(1…4000)}` | B + O。PWA / iOS は account のみ。通信実装済み、録音UIなし |
| POST `/api/contact/interview` | `{flowId,message,history:[{question,answer}]最大4,finish:Bool,diagnostic?:Diagnostic}` | `{status:ask|ready,kind,question,recommendation,summary}` | B + O。旧互換用、通常PWAから呼ばないため移植しない |
| GET `/api/auth/get-session` | なし | `{user:User,session:Session}|null` | S、実装済み |
| GET `/api/auth/passkey/list-user-passkeys` | なし | `[Passkey]` | S、実装済み |
| POST `/api/auth/passkey/delete-passkey` | `{id:PasskeyのID}` | `{status:true}` | S + Better Auth CSRF、実装済み |
| POST `/api/auth/sign-out` | `{}` | `{success:true}`（現在のPasskey専用設定） | S + Better Auth CSRF、実装済み |
| DELETE `/api/account/delete` | bodyなし、user IDなし | `{deleted:true,localHouseholdDataPreserved:true}` | S + O、実装済み |
| GET `/api/auth/passkey/generate-register-options` | query `name?,context?:招待token,authenticatorAttachment?` | WebAuthn `PublicKeyCredentialCreationOptionsJSON`（challenge,rp,user,pubKeyCredParams,excludeCredentials等） | session または招待、未実装 |
| POST `/api/auth/passkey/verify-registration` | `{response:RegistrationResponseJSON,name?,createSession?:Bool}` | Passkey。session作成時は `{...Passkey,session,user}`、Set-Cookie | challenge Cookie / 招待のサーバー検証、未実装 |
| GET `/api/auth/passkey/generate-authenticate-options` | なし | WebAuthn `PublicKeyCredentialRequestOptionsJSON`（challenge,rpId,allowCredentials等） | challenge Cookieを発行、未実装 |
| POST `/api/auth/passkey/verify-authentication` | `{response:AuthenticationResponseJSON}` | `{session,user}`、Set-Cookie | challenge Cookie + WebAuthn検証、未実装 |

管理者用 `POST /api/account/{invites,recovery}` は bootstrap secret が必要であり、ネイティブアプリの呼び出し対象外。招待発行は `{email,name}`、回復は `{email,name?}`、201応答は `{context:招待token,expiresAt:ISO8601,inviteUrl}`。アプリに管理者 secret を入れない。admin Inbox API も対象外。[Account (2026/10), handleAccountRequest]

### JSON の詳細と検証

- **Receipt**: `documentKind:receipt|not_receipt|unknown`、`merchant:String|null`、`purchasedDate:YYYY-MM-DD|null`、`purchasedTime:HH:MM|null`、`totalAmountYen:Int|null`、`taxAmountYen:Int|null`、`items:[{name,amountYen:Int|null,quantity?:Decimal>0,unitPriceYen?:Int|null}]`、`adjustments?:[{label,amountYen:符号付きInt,targetItemIndex?:Int|null}]`、`warnings:[{field:既知field|null,code:String(1…100),message:String(1…500),index?:Int|null}]`。各配列最大100、一般テキスト最大500。index は実際の対象配列内だけ。warning code はWorker仕様上自由な識別文字列であり、未知codeを既知状態へ読み替えない。[Worker (2026/10), receiptResultProblem]
- **Payroll**: `documentKind:pay_slip|not_pay_slip|unknown`、`employerName,paymentDate,payPeriod` はnullable、`payType:salary|bonus|other`、`grossPayYen,netPayYen` はnullable整数円、`deductions:{incomeTaxYen,residentTaxYen,healthInsuranceYen,pensionYen,employmentInsuranceYen,otherYen,totalYen}` は全キー必須nullable整数円、`allowances:[{name,amountYen}]`、`warnings:[{field:既知field|null,code:unreadable|uncertain|amount_mismatch}]` 各最大30。ラベルはNFKC後の7桁以上の番号、氏名・住所等の識別情報ラベル、URL、@を拒否。支給日補完・手取り再計算はしない。[Payroll (2026/10), payrollSchema]
- **Choice**: `{type:choice,choice:候補内ID,confidence:Decimal(0…1),probabilities:{全候補ID:Decimal(0…1)}}`。回答キー集合・候補集合が要求と一致し、確率和の誤差が0.02以内、choice が最大確率であることを検証する。画面の提案値はPWAと同じく最大確率0.75以上・2位との差0.15以上の時だけ返す。[PWA (2026/10), safeCategoryResponse]
- **Jev要求**: Geminiの同じ抽出値を元に店名・品目名を200 UTF-16単位以内、先頭30品目に絞る。学習済みの分類を先に適用し、未分類indexだけを渡す責任は呼び出し元サービスにある。候補は1…100件、ID一意・1…128文字、名前1…100文字。ローカル学習履歴・画像・家計簿全体を送らない。[PWA (2026/10), local-receipts.ts / local-category-learning.ts]
- **Cost**: `{requests,inputTokens,outputTokens,costUsdMicros,unknownRequests}` は非負の安全整数。合計料金・不明件数はprovider和と一致、`unknownRequests<=requests`。通貨はUSD。金額にDoubleを使わない。[Costs (2026/10), monthlyCosts]
- **User / Session**: Userは`{id,name,email,emailVerified,image?:String|null,createdAt,updatedAt}`、Sessionは`{id,userId,token,expiresAt,createdAt,updatedAt,ipAddress?:String|null,userAgent?:String|null}`。日時はtimezone付きISO8601。user ID一致とsession期限を検証する。取得結果は保存・ログ・診断へ入れない。[Better Auth (2026/10), get-session; 実装: KMAPIModels.swift]
- **Passkey**: `{id,name?:String|null,publicKey,userId,credentialID,counter:Int>=0,deviceType:singleDevice|multiDevice,backedUp:Bool,transports?:String|null,createdAt?:ISO8601|null,aaguid?:String|null}`。一覧のID重複を拒否。[Better Auth (2026/10), Passkey schema / listPasskeys]
- **Diagnostic**: `{version:1,currentScreen:固定語彙,network:online|offline,events:[固定語彙event]最大20}`。eventはscreen_open/action/error/network、相対秒は0…900。PWA recorderはメモリで40件・15分だけ保持し、contact内の操作を除外し、利用者の明示同意時だけ添付する。iOSはこのrecorderが未実装のため、任意文字列JSONを受ける代用品を作らず添付自体を未実装にした。[Contact (2026/10), parseDiagnosticContext; PWA, contact-diagnostics.ts]

すべての応答はJSON Content-Type・1 MiB上限・形の検証を経てCodableへdecodeする。未知キー、未知enum、欠けたnullable必須キー、整数円の小数・負値・JS安全整数超過、実在しない日付、範囲外indexを正常値として返さない。Receiptの日付はWorkerの簡易正規表現より厳しく暦日を検証する。欠損を空値に置換しない。[実装: KMAPIValidation.swift / KMAPIShapes.swift]

## 認証・有効期限・エラー

以下のJWT / Cookieの説明は従来Worker互換モードのものです。native modeは前節の固定期限session・opaque AI tokenを使い、Set-Cookieを保存しません。

アカウント優先で `/token` を呼び、401時だけ保存済みゲストへ切り替える。contactは `allowGuest:false`。保存済みゲストが無効なら合言葉を削除し、勝手に新規作成しない。JWTの残り時間が**30秒超**の時だけメモリキャッシュを再利用し、account限定要求にguest JWTを使わない。JWT発行の最大期限は600秒として検証する。401後に有料要求を自動再送しない。[PWA (2026/10), ai-auth.ts / guest-ai.ts; 実装: KMWorkerAPI.swift]

端末合言葉、session Cookie、短期JWTはhost別Keychain serviceへ保存する。`WhenUnlockedThisDeviceOnly`、同期なし。JWTはPWAの再起動時再取得に合わせ**Keychainから復元しない**。期限更新・logoutで削除する。再起動直後は古いKeychain JWTが残っていても読まず、次のtoken要求前に削除する。sessionは14日、24時間後の利用による更新はWorkerのSet-Cookieで受ける。共有Cookie jarやSafari Cookieを暗黙に流用しない。`installAccountSession` は将来の承認済み認証adapter用の境界であり、利用者にCookieの貼付けを求める導線ではない。[Cloud account, Passkeyとsession; 実装: KMCloudCredentials.swift / KMWorkerAPI.swift]

logout・account削除はAIキャッシュとsessionを破棄するが、ゲストの合言葉と家計データを消さない。実行中の古い資格情報による応答は世代番号で拒否する。APIは家計Repositoryを参照しない。[実装: KMWorkerAPI.swift]

| Worker error | iOS enum | PWA対応・画面への引き継ぎ |
| --- | --- | --- |
| 401 unauthorized | authenticationRequired | auth_required。画像を残しサインインを案内 |
| 429 ai_quota_exceeded | quotaExceeded | quota。account月次/guest日次を区別 |
| 503 ai_temporarily_paused | aiTemporarilyPaused | offline_or_unavailable。利用枠超過とは別。手入力を続ける |
| rate_limited | rateLimited | 要求集中、しばらく待つ |
| invalid_provider_response / schema不正 | invalidResponse | invalid_ai_response。確認値を上書きしない |
| invalid_flow | invalidFlow | 同じフローを勝手に作り直さず、手動選択/明示再解析 |
| provider_timeout / provider_unavailable | providerTimeout / providerUnavailable | 通信/サービス一時障害 |
| forbidden_origin / untrusted_origin | forbiddenOrigin | ネイティブ互換境界。認証切れと混同しない |
| not_configured | notConfigured | AIを現在利用できない |
| bot_check_failed / guest_limit_reached | botCheckFailed / guestLimitReached | 確認失敗/ゲスト作成上限 |
| URLSession通信失敗 | network | offline_or_unavailable。cancelはCancellationErrorのまま |

PWAのレシート文言は `receiptMessage(isGuest:)` に対応する。contact画面は `contact-ui.ts:errorMessage`、給与明細画面は `payroll-ui.ts` の文脈別文言に合わせる。APIは生のserver message・未知errorを画面へ出さない。[PWA (2026/10), gatewayError / contact-ui.ts / payroll-ui.ts]

## 画像・音声の前処理

**通常レシート**はPWAの送信前縮小・変換・自動マスキングが存在しない。保存時はJPEG/PNG/WebP・署名・10 MiB上限、送信時は元bytesをBase64化し6 MiB超を拒否する。iOSの `KMUploadImage` も送信前は署名・MIME一致・6 MiBを検証し、元bytesを変更しない。HEICは拒否する。写真選択UIでHEIC変換を追加する場合は、PWAとの差分として別途判断する。元画像のメタデータ除去を今回のレシートAPIの保証にしない。[PWA (2026/10), local-receipts.ts:analyze; Security, Cloud account and AI]

**給与明細**は `financial-image.ts` と同じく、JPEG/PNG/WebP・20 MiB以下を入力とし、向きを反映、長辺最大1800px、利用者指定の正規化座標の矩形を黒塗り、最小幅/高さ0.005、JPEG品質0.9で新しいラスタを作り6 MiB以下にする。`KMMaskedPayrollImage.prepare` は確認Boolなしに作れない。EXIF/GPSを引き継がない。自動個人情報検出はしない。`Features/Payroll/PayrollView` がマスキング画像・同意を表示し、送信後/失敗/画面移動時に画像を破棄する。SwiftのData/URLSessionのコピーを含む全メモリのゼロ消去は保証しない。CanvasとImageIOのJPEGは同一bytesではない。[PWA (2026/10), financial-image.ts / payroll-ui.ts; 実装: KMUploadMedia.swift / Features/Payroll/PayrollView.swift]

音声は2 MiB上限と形式署名を検証する。MP4は要求では`audio/mp4`、WorkerがGoogle向けに`audio/m4a`へ変換する。最大60秒の録音停止・同じ録音flowIdでの明示再試行・画面移動時停止はUI側で実装する。APIは録音しない。[Contact (2026/10), parseContactInput / transcriptionPayload; docs/CONTACT.md]

レシート/給与の新しい明示読み取りはUUIDv4を使う。JevはGeminiと同じflowIdと抽出値に結び付く。サーバーのフローは開始から10分・各段階最大3試行、カテゴリ候補更新でflowを勝手に再発行しない。問い合わせ最終送信は同じ内容とflowIdで冪等、結果不明時は自動再送しない。MoneyForward提案も利用枠と費用制限を通る。[Cloud account, AI entitlementと利用量; Worker, categorySuggestion; Contact, サーバーの記録と二重投稿]

## Worker側のnative契約

| 境界 | native契約 |
| --- | --- |
| GET config | `{available,rpId,appAttestEnvironment}` を返す。未設定時は利用不可にし、native credential endpointは失敗閉鎖 |
| challenge/attest | purpose別に32-byte challengeを発行し120秒で失効。登録済み鍵、nonce、counter/replay、App ID、環境をWorkerで検証 |
| guest/session | guestは同じApp Attest鍵から同じuserを再利用し、session tokenは14日固定。token発行・Passkey追加時のaccount認可はWorker側で強制 |
| Passkey | Better AuthのWebAuthn challenge/verificationを維持し、native responseのorigin/RP条件を検証。challenge状態はWorker側だけに保持 |
| preview | host・RP ID・App Attest環境・Keychain serviceを本番から分離。previewは合成データ専用 |

この表のendpoint・schema・期限は本PRのWorker実装と対応します。合成Passkeyの認証・招待登録、失効、Origin拒否、利用枠・費用停止をWorker側のテストで検証します。Apple資料ではPasskey platform providerがRP IDとchallengeを使うこと、App Attestで鍵・attestation/assertionを生成してサーバーが検証すること、Associated Domainsにwebcredentials entitlementが必要なことを確認しました。[Apple Passkeys / Apple DeviceCheck / Apple Associated Domains、参照資料]


## 検証と未実装

`KakeiMatchTests/APIClientTests.swift` はSwift Testing + URLProtocolおよびApp Attest stubでnative config、App Attest/guest/token/AI要求、Origin/Cookie不送信、base64url challenge hash、token期限と互換APIの既存検証を確認する。実Worker、Apple App Attest、実Passkey、Gemini/Jevへ接続しない。LinuxにXcodeがないためmacOSの`ios.yml`成功が必要です。[実装: APIClientTests.swift; .github/workflows/ios.yml]

CI は `CODE_SIGNING_ALLOWED=NO` のため、Keychain の保存・更新・削除・host分離・`WhenUnlockedThisDeviceOnly`・エラー時の拒否は Security API 呼び出しだけを stub にして検証する。署名済みアプリでの実 Keychain の読み書きは別途実機確認が必要。Cookie 更新テストは固定時計と同じ基準の Expires を使い、実時計に依存する Max-Age で判定しない。給与画像は縮小寸法・黒塗り・逆方向の矩形指定・GPS非継承を合成画像で確認する。[実装: APIClientTests.swift / KMCloudCredentials.swift; .github/workflows/ios.yml]

未確認・未実装: Swiftクライアントから実Workerへのend-to-end通信、実機でのPasskeyおよびApp Attest検証、署名済みbuildのentitlement、実際のApple App ID prefixとAssociated Domainsの一致、実機Keychain、診断recorder/添付、録音/カメラUI、APIとRepositoryの接続。Simulator / App Attest非対応時はクラウド機能を停止します。Team IDはソースへ置かず、手動session Cookie導入も提供しません。[実装: API/]

## 参照資料

[Worker, 2026/10] KakeiMatch. `apps/pwa/src/worker.ts`, `workers/ai-gateway/src/{worker,guest-ai}.ts`.

[Account, 2026/10] KakeiMatch. `workers/ai-gateway/src/account-auth.ts`, `docs/CLOUD_ACCOUNT.md`.

[PWA, 2026/10] KakeiMatch. `apps/pwa/src/{ai-auth,guest-ai,local-receipts,local-category-learning,receipt-reading-progress,payroll-ui,local-payroll,financial-image,contact-ui,contact-diagnostics,moneyforward-category-suggestion,main}.ts`.

[Payroll / Contact / Costs, 2026/10] KakeiMatch. `workers/ai-gateway/src/{payroll-schema,contact,feedback,ai-provider-costs}.ts`, `docs/{LOCAL_PAYROLL,CONTACT,AI_COST_GUARDRAILS}.md`, `SECURITY.md`.

[Better Auth, 2026/10] Better Auth. Version 1.7.6 distribution source (npm). https://registry.npmjs.org/better-auth/-/better-auth-1.7.6.tgz / https://registry.npmjs.org/@better-auth/passkey/-/passkey-1.7.6.tgz

[Apple Passkeys, 2026/10] Apple. “Supporting passkeys.” https://developer.apple.com/documentation/authenticationservices/supporting-passkeys / “Connecting to a service with passkeys.” https://developer.apple.com/documentation/authenticationservices/connecting-to-a-service-with-passkeys / “ASAuthorizationPlatformPublicKeyCredentialProvider.” https://developer.apple.com/documentation/authenticationservices/asauthorizationplatformpublickeycredentialprovider

[Apple Domains, 2026/10] Apple. “Supporting associated domains.” https://developer.apple.com/documentation/xcode/supporting-associated-domains

[Apple App Attest, 2026/10] Apple. “DCAppAttestService.” https://developer.apple.com/documentation/devicecheck/dcappattestservice / “Establishing your app’s integrity.” https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity / “Validating apps that connect to your server.” https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server

[Apple Web Auth, 2026/10] Apple. “ASWebAuthenticationSession.” https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession
