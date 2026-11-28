# iOS アプリのクラウド認証境界（Issue #240）

この文書は `/api/native/*` の実装仕様です。通常の家計操作は端末内で完結し、クラウド認証へ依存させません。Passkey・招待・アカウント削除は S6（#456）と S7（#458）で撤去し、この文書では扱いません。本番への公開・migration 適用・署名済みアプリの実機確認は、この文書更新の対象外です。

## 1. 境界と採用方針

1. **Web の旧 API**: `/api/auth/*`、`/api/account/*`、`/api/ai/*`、`/api/contact*` は410を返します（S7 単位1・2で撤去）。Web のログイン・Cookie・Turnstile の経路は残っていません。
2. **ネイティブ**: `/api/native/*` は Cookie と Origin を受け付けません。App Attest で検証した鍵と、その鍵に結び付けたゲストのネイティブセッションだけを受け付けます。Origin ヘッダーをアプリの証明にしません。
3. **既存処理への接続**: ネイティブ境界で鍵・期限を検証した後、サーバー内でのみ既存のAI処理を呼びます。リクエストの user ID、Cookie、Origin、Authorization をそのまま転送しません。AI の入力検証、利用枠、接続元制限、全体費用停止、応答検証を再利用します。

実装の正本は [`native-auth.ts`](../workers/ai-gateway/src/native-auth.ts)、[`worker.ts`](../workers/ai-gateway/src/worker.ts)、[`app-attest.ts`](../workers/ai-gateway/src/app-attest.ts) です。利用主体と利用量の境界は [Cloud account](CLOUD_ACCOUNT.md)、費用の境界は [AI費用の停止と再開](AI_COST_GUARDRAILS.md) を参照してください。

### 設定不足・非対応端末

全設定がそろうまで、ネイティブAPIは `503 not_configured`、config は `available:false`、AASA は404です。Team ID を推測して有効にしません。App Attest 非対応端末・Simulator ではネイティブのクラウド機能を使えません。ダミー証明、自己申告、Origin 偽装、無検証のゲスト作成へ切り替えません。手入力と端末内の閲覧・編集は継続できます。

Apple は `isSupported` の確認と、非対応時のサービス設計の分岐を求めています。本実装では安全側にクラウド機能を無効にする方針を採用します。[Apple Integrity (2026/10), Check for availability]

## 2. 資格情報と有効期間

| 資格情報 | audience / 対象 | 有効期間・保存 | 失効 |
| --- | --- | --- | --- |
| App Attest 鍵 | 設定済み origin / App ID / 環境 | 秘密鍵は端末の App Attest。Worker は公開鍵と検証用metadataだけ | `native_app_keys.revoked_at` 設定で即拒否。再インストール時は新鍵 |
| challenge | `attest`・`guest`・`token` の1用途、鍵ID、必要時セッションに固定 | 32 bytes乱数、120秒、D1で一度だけ消費 | 成功・失敗を問わず検証開始時に消費。期限後は拒否 |
| ネイティブセッション | ゲストの利用量と、AI token の交換 | 32 bytes乱数のbase64url、発行から14日固定（利用に応じて延長しない）。D1にはSHA-256だけ | 鍵の失効、user の削除、期限切れ |
| ネイティブAI token | `kakeimatch-native-ai`。AI の4経路だけ | 不透明な32 bytes乱数。最大600秒、セッション期限以内。D1にSHA-256・audience・セッション参照 | セッション・鍵の状態を毎回確認 |

ネイティブAI token は JWT ではありません。Web の AI JWT はネイティブAPIでは受理しません。ネイティブのセッションと AI token で利用できるのは、AI の読み取りと利用量の確認だけです。管理者API・問い合わせの受付・費用の表示はネイティブから呼べません。

セッションの期限は固定で、利用に応じて延ばしません。期限後は App Attest の確認からやり直します。ゲストは同じ検証済みの鍵でセッションを再発行しても、同じ user と利用量を使います。

端末の資格情報は接続host別Keychainに保存し、同期・バックアップ移行を無効にします。短期tokenは再起動後に復元せず、メモリキャッシュは残り30秒超の場合だけ再利用します。家計バックアップへ資格情報を入れません。Appleの鍵は通常のアプリ更新で維持されますが、再インストール・端末移行・バックアップ復元では引き継がれません。[Apple Integrity (2026/10), Generate assertions / key lifetime]

## 3. API と要求・応答

全通信は設定済みHTTPS hostへ直接行います。redirectを追いません。JSON応答は `Cache-Control:no-store`。ネイティブの小さな制御要求は64 KiB上限、未知フィールドは拒否します。AI本体の要求サイズは既存経路の制限を使います。時刻はUnix秒、日次・月次集計はAsia/Tokyoです。challenge のUUIDは大文字・小文字を受理し、D1照合前に小文字へ正規化します。SwiftのUUIDエンコード形式でも同じchallengeを参照できます。

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

### ゲストとAI token の交換

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

ゲスト作成は `guest_devices` に記録します。接続元あたり1日10件（`GUEST_CREATIONS_PER_ADDRESS_DAILY`）に制限し、接続元の生IPは保存せず、暦日別のHMACを使います。鍵ごとにguest userは1つです。鍵がアカウントに結び付いている場合、利用主体はそのアカウントで、新しいguest userは作りません。付与のない利用主体は、Asia/Tokyoの暦日で1日5回まで数えます。ネイティブにはWeb用のguest secretを発行しません。レシートの1日5回、接続元の1日20回、全体費用・緊急停止も既存処理を通るため維持されます。[実装: native-auth.ts / guest-ai.ts / receipt-ai-usage.ts / worker.ts]

### 認証後のAPI

既存APIの `/api/` を `/api/native/` に置き換え、method・body・成功JSONは原則そのまま使います。

| native対象 | 認証 |
| --- | --- |
| `ai/gemini`, `ai/payroll`, `ai/jev`, `ai/category-suggestion` のPOST | `Bearer <nativeAI token>` |
| `ai/usage` GET | `Native <sessionToken>`（応答は `supportId` を含む） |

上記以外のネイティブ経路は410を返します。`/api/native/passkey/*`、`/api/native/auth/*`、`/api/native/account/*`、`/api/native/contact*`、`/api/native/ai/costs` が対象です。`ai/usage` の応答は付与の有無で形が変わります（[Cloud account](CLOUD_ACCOUNT.md)の利用量の節）。

ネイティブ境界は Cookie・Set-Cookie を扱いません。APIエラーの本文や暗号検証の例外はログへ出さず、固定の安全なerror codeだけ返します。

## 4. App Attest 検証

Appleの公開手順に従って、CBORの形を検証し、Apple App Attestation Root CAへ固定したチェーン、証明書の署名・有効期間・CA制約を検証します。HTTPやbindingで任意のtrust anchorを指定する機能はありません。[Apple Validation (2026/10), Verify the attestation]

検証する結び付きは次のとおりです。[Apple Validation (2026/10), Verify the attestation / assertion]

- 証明書nonce OID `1.2.840.113635.100.8.2` のDER内octet stringと、`SHA256(authData || clientDataHash)` が一致する。
- leaf公開鍵をX9.62非圧縮点へ変換したSHA-256が、keyIdとcredential IDに一致する。COSE公開鍵も同じ鍵である。
- `rpIdHash == SHA256(設定済みApp ID)`。RPのWeb domain hashとApp AttestのApp ID hashを混同しない。
- 初回counterは0。環境別AAGUIDは `appattestdevelop` または `appattest` + 7 zero bytes。登録環境と運用環境が一致する。
- assertionの署名は登録済み公開鍵で検証する。署名対象は `nonce = SHA256(authenticatorData || clientDataHash)` で、端末はこの nonce をメッセージとして署名する（ES256のdigestは `SHA256(nonce)`）。`authenticatorData || clientDataHash` を直接検証すると実機の署名と一致しない。counterは前回を超え、D1の比較更新でも競合がない。challengeの期限・用途・一度限り使用も独立して検証する。
- attestationのEDフラグ付きauthenticator extensionでは、`apple_validation_category_01` を4 bytesのlittle-endian整数として検証する。developmentは3、productionは2（TestFlight）・4（App Store）・5（Enterprise / ad-hoc）だけを受理する。`apple_bundle_version_01` は数字とドットによる1〜5要素（各1〜20桁、全体64 bytes以内）の版番号に限定し、UTF-8のbyte stringでも同じ内容なら受理する。`CFBundleVersion` は `apps/ios/scripts/testflight.sh` が作る12桁のbuild番号（YYYYMMDDHHMM）であり、semantic versionより長い要素を許す必要がある。最低版の強制はまだ行わない。EDなしの旧形式も構造を検証して受理し、ED付きで欠損・不正な値は拒否する。
- assertionはAppleの検証手順（Verify the assertion）にflagsの要件がないため、flagsバイトを受理条件にしない。authenticatorDataが37 bytesなら末尾データなし、37 bytesを超えるなら署名対象のCBOR extension辞書として同じextension値を検証し、不正なら拒否する。EDビットの有無でextensionの有無を判定しない。

App Attestは本人認証の代わりではありません。ゲストはその鍵に固定します。App Attest自体も中継・正規端末の不正使用を完全には防ぎません。日次利用枠・address制限・全体費用停止は外しません。Apple fraud metricの照会・receiptの独立した解析は今回実装しません。receiptは検証済みattestationの付随bytesとして保存するだけで、課金許可やrisk判定には使いません。Appleはreceiptの独立検証とrisk metricによる追加評価も説明しています。この未実装は実機公開前の追加評価対象です。[Apple Validation (2026/10), Receipt / fraud assessment; Apple Integrity (2026/10)]

## 5. D1 migration・保存内容・失効

[`0018_native_app_auth.sql`](../workers/ai-gateway/migrations/0018_native_app_auth.sql) は追加のみのmigrationです。

| 表 | 保存するもの |
| --- | --- |
| `native_app_keys` | 鍵ID、origin・App ID・環境、公開鍵、receipt、counter、guest/account対応、登録・失効時刻 |
| `native_sessions` | セッションSHA-256、鍵・user・参照先の Better Auth session（`auth_session_id`、外部キー）、identity、期限 |
| `native_challenges` | 乱数challenge、用途・鍵・セッション参照、期限・消費時刻 |
| `native_ai_tokens` | token SHA-256、audience、セッション参照、期限 |

家計データ・画像・App Attest秘密鍵・生のセッション/AI tokenは保存しません。定期handlerが期限切れのchallenge・token・セッション行を削除します。削除前でも毎要求の期限検査で拒否します。

userの削除は外部キーでnative session / AI tokenへ伝播します。`native_sessions.auth_session_id` は Better Auth の `session(id)` への外部キー（`ON DELETE CASCADE`）で、この表は残ります（S8で表を整理するまで）。Better Auth の session 行が削除されれば、紐づくネイティブセッションも削除されます。鍵は監査とcounter再利用防止のため残します。鍵を緊急失効する場合は、対象環境のD1で `native_app_keys.revoked_at` を現在のUnix秒へ更新します。新鍵登録で既存keyIdを上書きしません。鍵IDは端末識別に関わるmetadataなので、ログやPRへ掲載しません。

## 6. 設定と環境の分離

| Worker var / build variable | 値と検証 |
| --- | --- |
| `NATIVE_APP_TEAM_ID` | 利用者がApple Developer Accountで確認した10文字のTeam ID。仮値・推測値を入れない |
| `NATIVE_APP_ID` | 実際のApplication Identifier Prefix + `.jp.kakeimatch.ios`。prefixとTeam IDを同じと推測しない |
| `NATIVE_APP_ORIGIN` | 本番は `https://kakeimatch.yhgry.workers.dev`。request originと `CLOUD_ACCOUNT_ORIGIN` に完全一致 |
| `NATIVE_APP_RP_ID` | 上記hostに完全一致。本番は `kakeimatch.yhgry.workers.dev` |
| `NATIVE_APP_ATTEST_ENVIRONMENT` | `production` / `development`。本番hostでdevelopmentは拒否 |
| iOS build setting `KM_NATIVE_HOST` | 既定は `kakeimatch.yhgry.workers.dev`。`project.yml` の `postBuildScripts` が署名前に `$(KM_NATIVE_HOST)` を `KMNativeAPIHost` として生成plistへ注入し、`webcredentials:` entitlementへも同じhostを渡す。Xcodeの `INFOPLIST_KEY_` はcustom keyを生成plistへ反映しないため使わない。previewではpreview hostへ上書きし、API URLとAssociated Domainsを同時に切り替える。本番entitlementのままpreview URLだけを指定しない |
| iOS build setting `KM_APP_ATTEST_ENVIRONMENT` | Debugは `development`、Releaseは `production` を既定値にする。`KM_DEVELOPMENT_TEAM` は外部署名環境から受け取り、sourceへ置かない |

`KMAPIConfiguration` はbundleの `KMNativeAPIHost` から既定のHTTPS API URLを作ります。値が欠損・不正なら初期化を失敗させ、production hostへfallbackしません。hostの自動発見やpreview fallbackは行いません。テスト等では明示URLを注入できますが、署名済みpreview buildでは `KM_NATIVE_HOST` とAssociated Domainsの値を合わせてください。Worker `/api/native/config` の `rpId` もそのURL hostと一致必須です。

全項目を明示します。通常の Worker buildで値がなくても失敗させず、ネイティブ境界だけ無効にします。`workers/ai-gateway/cloudflare.config.ts` は本番build変数からtext bindingを作ります。previewは `PREVIEW_NATIVE_APP_*` だけを読み、本番値を継承しません。既存の `AI_GATEWAY_AUTH_SECRET`・D1・rate-limit bindingも必須です。新しいprovider秘密鍵や端末内bootstrap secretは不要です。Better Auth のシークレット（`BETTER_AUTH_SECRET`）は Worker の設定から参照しません（S7で参照を外し、Cloudflare 上の実体の削除はS8の作業です）。

AASAは `/.well-known/apple-app-site-association` にJSONとして直接200で返し、`webcredentials.apps:[設定したApp ID]` を載せます。Cloudflare assetsより先にWorkerで処理します。Team/App ID、origin、RP、環境が不正なら404にし、SPAへredirectしません。Appleは有効なHTTPS証明書・redirectなし・App ID prefixとbundle IDの一致を要求します。AASAはApple CDN経由で反映に時間がかかるため、設定直後の実機失敗を即座にサーバーバグと断定しません。[Apple Domains (2026/10), Add the associated domain file / CDN]

previewは別host・RP・D1・AASA・Keychain serviceを使い、合成データだけで確認します。開発用のApp Attest資格情報を本番で受理しません。preview用Associated Domainsも、そのhostを明示した署名設定が必要です。

## 7. Webへの影響と脅威

| 脅威 | 対策 |
| --- | --- |
| ブラウザーのCSRF / Origin偽装 | nativeはCookie/Originを拒否し、App Attestの署名証明を要求。CORS許可を追加しない。Web の旧 API は410 |
| tokenの横流し | opaque tokenのaudience・経路の限定・identity区分。Web JWTと別形式で、ネイティブAPIはWeb JWTを受理しない |
| challengeやassertionの再送・同時再送 | 120秒・目的/鍵/セッション固定、消費UPDATE、counter比較更新 |
| 偽証明書・別app・開発環境からの要求 | Apple root固定、証明書/nonce/公開鍵/App ID/AAGUID照合、登録設定を毎要求で再確認 |
| 削除後にtokenが残る | user・背後のsession・鍵の失効を要求ごとにD1で確認し、外部キーでcascade |
| 鍵の作り直しでguest quota回避 | 同鍵は同guest、接続元あたりの日次作成制限、AI address20回、費用停止 |
| 認証ストレージを家計の所有権と混同 | APIは端末Repositoryを読まない。user IDを要求から採用しない |
| 証明の巨大入力・公開challengeの濫用 | 制御body64 KiB、既存rate-limitの専用addressキー、期限付き清掃 |

既存のAI処理のOrigin条件、CSRF設定、AIの認証・費用制限の条件式は緩めません。PWA routingへの差分は専用APIとAASAの分岐・定期清掃です。COOP/COEP/CSP/no-storeは既存ラッパーを維持し、Service Workerの `/api/*` 非cacheも変更しません。D1 migrationは定期清掃の参照表も追加するため、**ネイティブを有効化しない場合も公開前の適用が必要**です。

## 8. 利用者による準備・実機確認

1. Apple Developer AccountからTeam IDと、対象App IDのApplication Identifier Prefixを確認します。Bundle IDは `jp.kakeimatch.ios` です。値を確認してから上記varsへ設定します。
2. 本番と異なるD1・host・RPでpreviewを準備します。現在の `cf --help` / `cf cli search` / 対象commandのhelpを確認します。合成データでmigrationとAASA/APIを確認します。
3. 対象本番D1を確認し、既存migrationに続けて0018を人間が適用します。`cf d1 migrations list` / `apply` に本番IDと `--dir ../../workers/ai-gateway/migrations` を明示します。適用・秘密値の登録をAIへ暗黙に委ねません。
4. Xcodeの署名Teamを外部設定から指定し、Associated DomainsとApp Attest capabilityを対象App ID / provisioning profileで有効にします。Debugのdevelopment鍵を本番へ向けません。TestFlight / App Storeのproduction環境も確認します。
5. 本番build変数に `NATIVE_APP_*` を登録します。previewには `PREVIEW_NATIVE_APP_*` を登録し、本番資格情報を使いません。秘密情報は既存のCloudflare Secret bindingのままです。
6. PRの `ci`・AI Gateway・iOS CI成功と検証差分を確認し、利用者がマージします。通常の本番公開はmainマージ後のWorkers Buildsに任せます。このPR担当はdeployしません。
7. 公開後、AASAのHTTPS直200・JSON・redirectなしを確認します。署名済み実機で、ゲストの作成とAI token更新、レシート読み取りを合成データで確認します。両経路で日次枠・費用停止を確認します。
8. App Attest非対応端末でAIの操作が出ず、要求も送られないこと、オフラインの手入力、資格情報と家計バックアップの分離、再インストール後の鍵再作成を確認します。AASAのCDN反映も待って確認します。

## 9. iOS の認証画面（S6 で撤去）

設定の「ログイン・利用状況」（Passkey ログイン、招待コード、Passkey の追加・削除、ログアウト、アカウント削除）は、S6（#456）で画面から撤去しました。`KMNativeAuthService` などの service 層は残りますが、UI からは呼びません。撤去前の画面の仕様は、Git 履歴の旧版を参照してください。

iOS の API 契約（`KMWorkerAPI.swift`）は、アプリが呼ぶ経路として、ゲストの作成（`/api/native/challenge`・`/api/native/guest`）、AI token（`/api/native/ai/token`）、AI の読み取り、利用量（`/api/native/ai/usage`）を使います。Passkey・招待・アカウント削除の経路は退役（410）しています。

Simulator は `KMLiveAppAttest.isSupported` が常に `false` を返します。App Attest 非対応の端末では、ネイティブ要求を送らず、クラウドのAI機能を使えないことを示します。家計簿の閲覧・編集は続けられます。

`project.yml` は `INFOPLIST_KEY_KMNativeAPIHost` を使わず、`postBuildScripts` で署名前に `$(KM_NATIVE_HOST)` を `KMNativeAPIHost` として生成plistへ注入します。Xcodeの `INFOPLIST_KEY_` は既知のキーしか反映しないためです。Debugは `KM_APP_ATTEST_ENVIRONMENT=development`、Releaseは `production` の既定値を変えません。previewは6節のとおり、hostとAssociated Domainsを同時に切り替えます。

## 10. 検証の範囲と残件

Workerの暗号テストは実行時に生成する合成証明書・鍵を使います。HTTP/D1テストは期限切れ、replay、環境/設定不一致、失効、経路の分離と、Web 旧 API・退役経路の410を検査します。Swift Testingは URLProtocol / App Attest のstubで順序と保存・拒否を検査します。CI成功はAppleサーバー・実機・本番D1での成功を意味しません。

未検証: 正しいTeam/App ID、署名済み実機のAssociated Domains、App Attestの本物の証明書・assertion、TestFlightの環境、実provider・本番費用制限・本番migration・AASA CDN反映、実機のKeychain。

## 参照資料

[Apple Passkeys, 2026/10] Apple. “Supporting passkeys.” https://developer.apple.com/documentation/authenticationservices/supporting-passkeys

[Apple Sample, 2026/10] Apple. “Connecting to a service with passkeys.” https://developer.apple.com/documentation/authenticationservices/connecting-to-a-service-with-passkeys

[Apple Domains, 2026/10] Apple. “Supporting associated domains.” https://developer.apple.com/documentation/xcode/supporting-associated-domains

[Apple Integrity, 2026/10] Apple. “Establishing your app’s integrity.” https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity

[Apple Validation, 2026/10] Apple. “Validating apps that connect to your server.” https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server

[Apple Validation Guide, 2026/10] Apple. “Attestation object validation guide.” https://developer.apple.com/documentation/devicecheck/attestation-object-validation-guide

[Apple Root, 2026/10] Apple. “Apple Private PKI.” https://www.apple.com/certificateauthority/private/ （App Attestation Root CA）

Apple資料は2026-10-26に公式Documentation JSONと関連リンクで確認しました。外部仕様の説明と、上記のKakeiMatch固有の期限・非対応時方針・設定要件を区別しています。
