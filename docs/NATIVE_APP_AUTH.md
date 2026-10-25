# iOS アプリのクラウド認証境界（Issue #240）

この文書は `/api/native/*` の実装仕様です。通常の家計操作は端末内で完結し、クラウド認証へ依存させません。本番への公開・migration 適用・署名済みアプリの実機確認は、このPRでは行いません。**Worker と PWA 配信にも変更があるため、利用者の確認後にだけマージします。**

## 1. 境界と採用方針

1. **Web**: 既存の `/api/auth/*`、`/api/account/*`、`/api/ai/*`、`/api/contact*` は、従来の trustedOrigins・CSRF・Cookie・AI JWT のままです。Origin のない POST を許可しません。
2. **ネイティブ**: `/api/native/*` は Cookie と Origin を受け付けません。App Attest で検証した鍵と、Passkey またはゲストに結び付けた専用セッションだけを受け付けます。Origin ヘッダーをアプリの証明にしません。
3. **既存処理への接続**: ネイティブ境界で本人・鍵・期限を検証した後、サーバー内でのみ既存ハンドラーを呼びます。リクエストの user ID、Cookie、Origin、Authorization をそのまま転送しません。AI の入力検証、利用枠、接続元制限、全体費用停止、応答検証を再利用します。

実装の正本は [`native-auth.ts`](../workers/ai-gateway/src/native-auth.ts)、[`account-auth.ts`](../workers/ai-gateway/src/account-auth.ts)、[`worker.ts`](../workers/ai-gateway/src/worker.ts) です。アカウントの境界は [Cloud account](CLOUD_ACCOUNT.md)、費用の境界は [AI費用の停止と再開](AI_COST_GUARDRAILS.md) を参照してください。

### 設定不足・非対応端末

全設定がそろうまで、ネイティブAPIは `503 not_configured`、config は `available:false`、AASA は404です。Team ID を推測して有効にしません。App Attest 非対応端末・Simulator ではネイティブのクラウド機能を使えません。ダミー証明、自己申告、Origin 偽装、無検証のゲスト作成へ切り替えません。手入力・端末内閲覧は継続できます。既存PWAの Turnstile 経路は独立して残ります。

Apple は `isSupported` の確認と、非対応時のサービス設計の分岐を求めています。本実装では安全側にクラウド機能を無効にする方針を採用します。[Apple Integrity (2026/10), Check for availability]

## 2. 資格情報と有効期間

| 資格情報 | audience / 対象 | 有効期間・保存 | 失効 |
| --- | --- | --- | --- |
| App Attest 鍵 | 設定済み origin / App ID / 環境 | 秘密鍵は端末の App Attest。Worker は公開鍵と検証用metadataだけ | `native_app_keys.revoked_at` 設定で即拒否。再インストール時は新鍵 |
| challenge | attest / guest / token / passkey の1用途、鍵ID、必要時セッションに固定 | 32 bytes乱数、120秒、D1で一度だけ消費 | 成功・失敗を問わず検証開始時に消費。期限後は拒否 |
| ネイティブセッション | account管理・usage・costs・token交換。guestはusageと交換のみ | 32 bytes乱数のbase64url、固定14日以内。accountは背後の Better Auth session の期限以内。D1にはSHA-256だけ | ログアウト・回復で背後のsessionを削除、本人削除、鍵失効、期限切れ |
| ネイティブAI token | `kakeimatch-native-ai`。明示allowlistのAI / contact APIだけ | 不透明な32 bytes乱数。最大600秒、セッション期限以内。D1にSHA-256・audience・セッション参照 | セッション・鍵の状態を毎回確認。ログアウト・回復・本人削除に追随 |
| Web資格情報 | 既存Web専用 | 従来のCookie・`aud:kakeimatch-ai` JWT | 従来どおり |

ネイティブAI token は JWT ではありません。旧Web APIでは受理されず、Web AI JWTもネイティブAPIでは受理されません。guest session・AI token でアカウント管理や費用表示はできません。管理者API、招待発行、回復、旧contact interviewはネイティブallowlistに含めません。

accountセッションはネイティブでは固定期限です。Webの「24時間後の利用で14日へ延長」は変更しません。ネイティブの期限後はPasskeyで再認証します。guestは同じ検証済み鍵でセッションを再発行しても同じuser・利用量を使います。App Attest 鍵を別のCloud accountへ使い回すことはサーバーで拒否します。guestから同一端末のaccountへ移る場合も、既存guestの利用量は消しません。

端末の資格情報は接続host別Keychainに保存し、同期・バックアップ移行を無効にします。短期tokenは再起動後に復元せず、メモリキャッシュは残り30秒超の場合だけ再利用します。家計バックアップへ資格情報を入れません。Appleの鍵は通常のアプリ更新で維持されますが、再インストール・端末移行・バックアップ復元では引き継がれません。[Apple Integrity (2026/10), Generate assertions / key lifetime]

## 3. API と要求・応答

全通信は設定済みHTTPS hostへ直接行います。redirectを追いません。JSON応答は `Cache-Control:no-store`。ネイティブの小さな制御要求は64 KiB上限、未知フィールドは拒否します。AI本体の要求サイズは既存経路の制限を使います。時刻はUnix秒、日次・月次集計はAsia/Tokyoです。

### App Attest 鍵の登録

```text
GET /api/native/config
  -> {available, rpId:String|null, appAttestEnvironment:String|null}
DCAppAttestService.generateKey()
POST /api/native/challenge {purpose:"attest",keyId}
  -> {challengeId,challenge:base64url(32 bytes),expiresAt}
clientDataHash = SHA256(base64urlDecode(challenge))
DCAppAttestService.attestKey(keyId,clientDataHash)
POST /api/native/attest {challengeId,keyId,attestation:base64}
  -> {registered:true}
```

`keyId` はAppleのAPIが返すcanonical標準base64（32 bytes、padding付き）をそのまま使います。challengeだけがcanonical base64urlで、復号後は必ず32 bytesです。attestation・assertionはAppleが返すbytesを標準base64へ変換します。端末は登録成功後の鍵IDを保存します。アプリ更新時に毎回新鍵を作りません。[Apple Validation Guide (2026/10), keyId; Apple Integrity (2026/10), Attest the key]

### ゲスト・AI token の交換

```text
POST /api/native/challenge {purpose:"guest",keyId}
DCAppAttestService.generateAssertion(keyId,SHA256(decodedChallenge))
POST /api/native/guest {challengeId,keyId,assertion}
  -> 201 {sessionToken,expiresAt}

POST /api/native/challenge {purpose:"token",keyId}
  Authorization: Native <sessionToken>
POST /api/native/ai/token {challengeId,keyId,assertion}
  Authorization: Native <sessionToken>
  -> {token,expiresAt}
```

用途・鍵・セッションはchallenge行に固定されます。別用途や別セッションのchallengeで交換できません。署名を検証してからcounterを比較更新し、競合した要求は失敗扱いにします。

ゲスト作成は既存の `guest_devices` に記録し、Webとネイティブの合計で接続元あたり1日10件に制限します。接続元の生IPは保存せず、既存の暦日別HMACを使います。鍵ごとにguest userは1つです。ネイティブにはWeb用guest secretを発行しません。レシートの1日5回、接続元の1日20回、全体費用・緊急停止も既存処理を通るため維持されます。[実装: native-auth.ts / guest-ai.ts / receipt-ai-usage.ts / worker.ts]

### Passkey ceremony

```text
POST /api/native/passkey/options
  {kind:"authenticate"|"register",keyId,context?:招待token,name?}
  （Passkey追加時だけ Authorization: Native <accountSession>）
  -> {ceremonyId,options:Better AuthのWebAuthn options}
ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
  登録: options.challenge / user.id をbase64url decodeして渡す
  認証: options.challengeをbase64url decodeして渡す
DCAppAttestService.generateAssertion(keyId,SHA256(decoded options.challenge))
POST /api/native/passkey/verify
  {ceremonyId,response:WebAuthn response JSON,name?,assertion}
  -> {sessionToken,expiresAt}
```

Better Auth がchallengeを生成し、challenge Cookieとverification行で検証します。端末はoptions内のchallengeがcanonical base64urlで32 bytesに復号できることを検証します。`rpId` または `rp.id` が明示され、接続hostと一致しなければ拒否し、欠損値を接続hostで補いません。認証optionsに `allowCredentials` があれば空配列も含めてplatform requestへ渡します。platform passkey requestはuser verificationをrequiredにします。ネイティブ境界はCookieをサーバー内の期限付きceremony行に保持します。アプリにchallenge CookieやWeb session Cookieを渡さず、SafariのCookie jarも流用しません。招待登録は既存の一度限り招待が必要です。Passkey追加は認証済み本人に限定し、sessionと招待contextの併用を拒否します。招待の対象userはサーバーで解決し、App Attest証明後・招待消費前に鍵をその対象へ比較更新で予約します。複数アカウントの登録が競合しても、後から拒否する要求の招待を消費しません。Passkey検証に失敗した場合も、鍵の対象予約は残りますが、セッションは発行せず招待も消費しません。同じ対象の招待は新しいceremonyで再試行できます。

ネイティブの `clientDataJSON.origin` の受理条件は、設定済み **HTTPS originと完全一致**です。RP IDも設定済みhostと完全一致し、App ID schemeやwildcardを追加しません。WebAuthnのchallenge・署名・RP hash・origin・crossOrigin・counterは既存のBetter Auth / SimpleWebAuthn検証へ委ねます。ネイティブ用インスタンスだけuser verificationを要求し、検証結果の `userVerified` も確認します。Webの既存設定は変更しません。

AppleのPasskey APIはAssociated Domainsのwebcredentials設定を必要とし、サーバーchallengeを渡して登録・認証します。同じRPのPWA登録済みPasskeyを使うことを目標にしていますが、実際のiOS `clientDataJSON` と既存Passkeyの共有は署名済み実機で未検証です。未確認を理由にorigin条件を広げません。[Apple Passkeys (2026/10), Register / Authenticate; Apple Sample (2026/10), Configure the sample]

### 認証後のAPI

既存APIの `/api/` を `/api/native/` に置き換え、method・body・成功JSONは原則そのまま使います。

| native対象 | 認証 |
| --- | --- |
| `ai/gemini`, `ai/payroll`, `ai/jev`, `ai/category-suggestion` のPOST | `Bearer <nativeAI token>` |
| `contact`, `contact/transcribe` のPOST | accountの `Bearer <nativeAI token>` |
| `ai/usage` GET | account / guestの `Native <sessionToken>` |
| `ai/costs` GET | account sessionのみ |
| `auth/get-session`, `auth/passkey/list-user-passkeys` GET | account sessionのみ |
| `auth/passkey/delete-passkey`, `auth/sign-out` POST | account sessionのみ |
| `account/delete` DELETE | account sessionのみ |

`get-session` の `session.token` / `id` / `expiresAt` はネイティブの値へ置換します。Webのsession tokenとSet-Cookieを外へ出しません。ログアウト・本人削除はguest資格情報と家計データを削除しません。APIエラーの本文や暗号検証の例外はログへ出さず、固定の安全なerror codeだけ返します。

## 4. App Attest 検証

Appleの公開手順に従って、CBORの形を検証し、Apple App Attestation Root CAへ固定したチェーン、証明書の署名・有効期間・CA制約を検証します。HTTPやbindingで任意のtrust anchorを指定する機能はありません。[Apple Validation (2026/10), Verify the attestation]

検証する結び付きは次のとおりです。[Apple Validation (2026/10), Verify the attestation / assertion]

- 証明書nonce OID `1.2.840.113635.100.8.2` のDER内octet stringと、`SHA256(authData || clientDataHash)` が一致する。
- leaf公開鍵をX9.62非圧縮点へ変換したSHA-256が、keyIdとcredential IDに一致する。COSE公開鍵も同じ鍵である。
- `rpIdHash == SHA256(設定済みApp ID)`。RPのWeb domain hashとApp AttestのApp ID hashを混同しない。
- 初回counterは0。環境別AAGUIDは `appattestdevelop` または `appattest` + 7 zero bytes。登録環境と運用環境が一致する。
- assertionの署名は登録済み公開鍵で検証する。counterは前回を超え、D1の比較更新でも競合がない。challengeの期限・用途・一度限り使用も独立して検証する。
- EDフラグ付きの新しいauthenticator extensionでは、`apple_validation_category_01` を4 bytesのlittle-endian整数として検証する。developmentは3、productionは2（TestFlight）・4（App Store）・5（Enterprise / ad-hoc）だけを受理する。`apple_bundle_version_01` は数字とドットによる1〜3要素の版番号に限定する。最低版の強制はまだ行わない。EDなしの旧形式も構造を検証して受理し、ED付きで欠損・不正な値は拒否する。

App Attestは本人認証の代わりではありません。account本人はPasskeyが決め、guestはその鍵に固定します。App Attest自体も中継・正規端末の不正使用を完全には防ぎません。日次利用枠・address制限・全体費用停止は外しません。Apple fraud metricの照会・receiptの独立した解析は今回実装しません。receiptは検証済みattestationの付随bytesとして保存するだけで、課金許可やrisk判定には使いません。Appleはreceiptの独立検証とrisk metricによる追加評価も説明しています。この未実装は実機公開前の追加評価対象です。[Apple Validation (2026/10), Receipt / fraud assessment; Apple Integrity (2026/10)]

## 5. D1 migration・保存内容・失効

[`0018_native_app_auth.sql`](../workers/ai-gateway/migrations/0018_native_app_auth.sql) は追加のみのmigrationです。

| 表 | 保存するもの |
| --- | --- |
| `native_app_keys` | 鍵ID、origin・App ID・環境、公開鍵、receipt、counter、guest/account対応、登録・失効時刻 |
| `native_sessions` | セッションSHA-256、鍵・user・Better Auth session参照、identity、期限 |
| `native_challenges` | 乱数challenge、用途・鍵・セッション参照、ceremony Cookie・招待/追加の対象user参照、期限・消費時刻 |
| `native_ai_tokens` | token SHA-256、audience、セッション参照、期限 |

家計データ・画像・Passkey秘密鍵・App Attest秘密鍵・生のセッション/AI tokenは保存しません。challenge Cookieは短期のサーバー内検証状態で、汎用アカウントsessionではありません。定期handlerが期限切れchallenge/token/session行を削除します。削除前でも毎要求の期限検査で拒否します。

userまたは背後のBetter Auth session削除は外部キーでnative session / AI tokenへ伝播します。鍵は監査とcounter再利用防止のため残します。鍵を緊急失効する場合は、対象環境のD1で `native_app_keys.revoked_at` を現在のUnix秒へ更新します。新鍵登録で既存keyIdを上書きしません。鍵IDは端末識別に関わるmetadataなのでログやPRへ掲載しません。

## 6. 設定と環境の分離

| Worker var / build variable | 値と検証 |
| --- | --- |
| `NATIVE_APP_TEAM_ID` | 利用者がApple Developer Accountで確認した10文字のTeam ID。仮値・推測値を入れない |
| `NATIVE_APP_ID` | 実際のApplication Identifier Prefix + `.jp.kakeimatch.ios`。prefixとTeam IDを同じと推測しない |
| `NATIVE_APP_ORIGIN` | 本番は `https://kakeimatch.yhgry.workers.dev`。request originと `CLOUD_ACCOUNT_ORIGIN` に完全一致 |
| `NATIVE_APP_RP_ID` | 上記hostに完全一致。本番は `kakeimatch.yhgry.workers.dev` |
| `NATIVE_APP_ATTEST_ENVIRONMENT` | `production` / `development`。本番hostでdevelopmentは拒否 |
| iOS build setting `KM_NATIVE_HOST` | 既定は `kakeimatch.yhgry.workers.dev`。アプリの `KMNativeAPIHost` と `webcredentials:` entitlementへ同じhostを渡す。previewではpreview hostへ上書きし、API URLとAssociated Domainsを同時に切り替える。本番entitlementのままpreview URLだけを指定しない |
| iOS build setting `KM_APP_ATTEST_ENVIRONMENT` | Debugは `development`、Releaseは `production` を既定値にする。`KM_DEVELOPMENT_TEAM` は外部署名環境から受け取り、sourceへ置かない |

`KMAPIConfiguration` はbundleの `KMNativeAPIHost` から既定のHTTPS API URLを作ります。値が欠損・不正なら初期化を失敗させ、production hostへfallbackしません。hostの自動発見やpreview fallbackは行いません。テスト等では明示URLを注入できますが、署名済みpreview buildでは `KM_NATIVE_HOST` とAssociated Domainsの値を合わせてください。Worker `/api/native/config` の `rpId` もそのURL hostと一致必須です。

全項目を明示します。通常のPWA buildで値がなくても失敗させず、ネイティブ境界だけ無効にします。`apps/pwa/cloudflare.config.ts` は本番build変数からtext bindingを作ります。previewは `PREVIEW_NATIVE_APP_*` だけを読み、本番値を継承しません。既存の `BETTER_AUTH_SECRET`・`AI_GATEWAY_AUTH_SECRET`・D1・rate-limit bindingも必須です。新しいprovider秘密鍵や端末内bootstrap secretは不要です。

AASAは `/.well-known/apple-app-site-association` にJSONとして直接200で返し、`webcredentials.apps:[設定したApp ID]` を載せます。Cloudflare assetsより先にWorkerで処理します。Team/App ID、origin、RP、環境が不正なら404にし、SPAへredirectしません。Appleは有効なHTTPS証明書・redirectなし・App ID prefixとbundle IDの一致を要求します。AASAはApple CDN経由で反映に時間がかかるため、設定直後の実機失敗を即座にサーバーバグと断定しません。[Apple Domains (2026/10), Add the associated domain file / CDN]

previewは別host・RP・D1・AASA・Keychain serviceを使い、合成データだけで確認します。開発用のApp Attest資格情報を本番で受理しません。preview用Associated Domainsも、そのhostを明示した署名設定が必要です。

## 7. Webへの影響と脅威

| 脅威 | 対策 |
| --- | --- |
| ブラウザーのCSRF / Origin偽装 | 旧Web検査は変更しない。nativeはCookie/Originを拒否し、専用秘密tokenと署名証明を要求。CORS許可を追加しない |
| tokenをWebやadminへ横流し | opaque tokenのaudience・route allowlist・identity区分。旧Web JWTと別形式 |
| challengeやassertionの再送・同時再送 | 120秒・目的/鍵/session固定、消費UPDATE、counter比較更新 |
| 偽証明書・別app・開発環境からの要求 | Apple root固定、証明書/nonce/公開鍵/App ID/AAGUID照合、登録設定を毎要求で再確認 |
| 別アカウントの招待の誤消費・同一鍵での登録競合 | sessionとcontextを分離。対象をサーバー解決し、署名証明後に鍵を比較更新で予約してから招待を消費 |
| 削除・回復後にtokenが残る | user / backing session / 鍵失効を要求ごとにD1確認、外部キーcascade |
| 鍵の作り直しでguest quota回避 | 同鍵は同guest、Webと共有のaddress日次作成制限、AI address20回、費用停止 |
| 認証ストレージを家計の所有権と混同 | APIは端末Repositoryを読まない。user IDを要求から採用しない |
| 証明の巨大入力・公開challengeの濫用 | 制御body64 KiB、既存rate-limitの専用addressキー、期限付き清掃 |

既存WebハンドラーのOrigin条件、trustedOrigins、CSRF設定、Cookie属性、AIの認証・費用制限の条件式は緩めません。`createAuth` のネイティブ専用設定は別のサーバー内呼出時だけ選びます。PWA routingへの差分は専用APIとAASAの分岐・定期清掃です。COOP/COEP/CSP/no-storeは既存ラッパーを維持し、Service Workerの `/api/*` 非cacheも変更しません。D1 migrationは定期清掃の参照表も追加するため、**ネイティブを有効化しない場合も公開前の適用が必要**です。

## 8. 利用者による準備・実機確認

1. Apple Developer AccountからTeam IDと、対象App IDのApplication Identifier Prefixを確認します。Bundle IDは `jp.kakeimatch.ios` です。値を確認してから上記varsへ設定します。
2. 本番と異なるD1・host・RPでpreviewを準備します。現在の `cf --help` / `cf cli search` / 対象commandのhelpを確認します。合成データでmigrationとAASA/APIを確認します。
3. 対象本番D1を確認し、既存migrationに続けて0018を人間が適用します。`cf d1 migrations list` / `apply` に本番IDと `--dir ../../workers/ai-gateway/migrations` を明示します。適用・秘密値の登録をAIへ暗黙に委ねません。
4. Xcodeの署名Teamを外部設定から指定し、Associated DomainsとApp Attest capabilityを対象App ID / provisioning profileで有効にします。Debugのdevelopment鍵を本番へ向けません。TestFlight / App Storeのproduction環境も確認します。
5. 本番build変数に `NATIVE_APP_*` を登録します。previewには `PREVIEW_NATIVE_APP_*` を登録し、本番資格情報を使いません。秘密情報は既存のCloudflare Secret bindingのままです。
6. PRの `ci`・AI Gateway・iOS CI成功と検証差分を確認し、利用者がマージします。通常の本番公開はmainマージ後のWorkers Buildsに任せます。このPR担当はdeployしません。
7. 公開後、AASAのHTTPS直200・JSON・redirectなしを確認します。署名済み実機でPWA登録済みPasskeyのログイン、招待登録、追加/削除、guest作成、token更新、logout/recovery/delete後の拒否を合成データで確認します。両経路で日次枠・費用停止も確認します。
8. App Attest非対応端末の拒否、オフライン手入力、資格情報と家計バックアップの分離、再インストール後の鍵再作成を確認します。AASAのCDN反映も待って確認します。

## 9. 検証の範囲と残件

Workerの暗号テストは実行時に生成する合成証明書・鍵を使います。HTTP/D1テストは期限切れ、replay、環境/設定不一致、失効、route/audience分離と旧Webの拒否を検査します。Swift TestingはURLProtocol / Passkey / App Attestのstubで順序と保存・拒否を検査します。CI成功はAppleサーバー・実機・本番D1での成功を意味しません。

未検証: 正しいTeam/App ID、署名済み実機のAssociated Domains、App Attestの本物の証明書・assertion、PWA既存Passkeyのネイティブ共有とorigin実値、TestFlightの環境、実provider・本番費用制限・本番migration・AASA CDN反映。認証UIと家計サービスへの接続はAPI層とは別の作業です。

## 参照資料

[Apple Passkeys, 2026/10] Apple. “Supporting passkeys.” https://developer.apple.com/documentation/authenticationservices/supporting-passkeys

[Apple Sample, 2026/10] Apple. “Connecting to a service with passkeys.” https://developer.apple.com/documentation/authenticationservices/connecting-to-a-service-with-passkeys

[Apple Domains, 2026/10] Apple. “Supporting associated domains.” https://developer.apple.com/documentation/xcode/supporting-associated-domains

[Apple Integrity, 2026/10] Apple. “Establishing your app’s integrity.” https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity

[Apple Validation, 2026/10] Apple. “Validating apps that connect to your server.” https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server

[Apple Validation Guide, 2026/10] Apple. “Attestation object validation guide.” https://developer.apple.com/documentation/devicecheck/attestation-object-validation-guide

[Apple Root, 2026/10] Apple. “Apple Private PKI.” https://www.apple.com/certificateauthority/private/ （App Attestation Root CA）

Apple資料は2026-10-26に公式Documentation JSONと関連リンクで確認しました。外部仕様の説明と、上記のKakeiMatch固有の期限・非対応時方針・設定要件を区別しています。
