# Security

KakeiMatch handles personal financial information and receipt images. Security and privacy take priority over convenience when the two conflict.

## Data model requirement

現在の主アプリPWAでは、家計データをCloud accountではなく端末内のActual BudgetとIndexedDBに保存します。ローカルデータはブラウザーprofileと端末へのアクセスで保護されます。同じブラウザーprofileを使う人同士をCloud accountのログインで分離する仕組みはありません。端末を共有する場合はブラウザーprofileを共有せず、OSの画面ロックを設定してください。移行前のNext.js APIはlegacy実装で、Issue #39まで保持します。legacy APIはユーザーごとの家計データを扱うため、サーバー側で認可します。

Every endpoint that reads or writes user data must enforce authorization on the server side.

Protected data includes:

- transactions
- receipts and receipt images
- imported statements
- reconciliation results
- category history
- user correction history
- mappings to Actual Budget

## Secrets

Never commit:

- API keys
- passwords
- production environment files
- Actual Budget credentials
- authentication secrets
- real card statements
- real receipt images

Use environment variables or an appropriate secret store.

## Cloud account and local data boundary

The local PWA household experience does not require a Cloud account. Local Actual Budget data, receipts, statements, reconciliation results, and correction decisions remain in browser storage on the device. A Cloud account is used for Passkey identity, AI access, and entitlements. Its D1 database stores only account authentication records, entitlement settings, and monthly AI usage counters. It must not store household transactions, receipt content or images, statement files or rows, reconciliation results, or Actual Budget data. The PWA provides explicit local portable backup and staging restore. The backup contains household data and existing raw artifacts, never Cloud account credentials, sessions, AI tokens, entitlements, usage, billing, or provider secrets. Restore validates the archive and writes to a new local profile and a separate Actual API data directory before switching the active profile. Raw cleanup removes only eligible image/CSV blobs. Local wipe uses household stores and local-only Actual API handlers, never an account endpoint. If an Actual import fails before returning its budget ID, the public API cannot prove that all incomplete files are removed; the app preserves the active household and refuses to report a complete wipe. This unresolved case is documented in [local backup and recovery](docs/LOCAL_BACKUP.md). See [Cloud account operations](docs/CLOUD_ACCOUNT.md) and the [local-first flow](docs/LOCAL_FIRST_FLOW.md).

The public signup path is disabled. Account creation uses a controlled, one-time invite/bootstrap process. Invites expire after 7 days. Passkey verification and challenge handling are delegated to Better Auth's Passkey plugin. The account cookie is HttpOnly and SameSite=Lax, and Secure over HTTPS; auth routes validate trusted origins and protect state-changing requests against CSRF. Account sessions last 14 days with a rolling refresh age of 24 hours. AI JWTs have a maximum 10-minute lifetime and are signed only on the server. A valid account session can renew an expired AI JWT without prompting for a Passkey again. The signing secret must never enter the PWA bundle.

AI quota checks run on the server independently of the short-window abuse rate limit. The monthly counter increments once after request validation and immediately before a provider request. Provider failures after dispatch count as usage; validation, authentication, and quota rejections do not. Client retries are new provider attempts. Family entitlement removes the monthly product quota only; it does not remove the abuse rate limit.

## Uploaded files

Receipt images and imported statement files are untrusted input.

At minimum:

- validate file size
- validate supported content type/format
- generate server-side filenames
- prevent path traversal
- store outside public static directories
- require authorization when serving files
- avoid logging raw financial data

The legacy Next.js app stores uploaded files in private server storage and enforces session authorization when serving receipt images. The primary PWA handles receipt images and statement CSVs locally in browser storage. The PWA validates JPEG, PNG, or WebP signatures and enforces a 10 MiB receipt image limit before saving. It parses the supported PayPay CSV fully before storing the original file and canonical rows. Other card formats are rejected until their meaning is verified. The PWA never sends a statement CSV to Cloudflare, Gemini, Jev, or Actual.

## External AI

Receipt data sent to Gemini and TypeSafe leaves the self-hosted environment.

Only send data required for the requested processing. Do not send authentication data, unrelated transaction history, or other users' information.

Receipt analysis is an explicit PWA action. The browser sends the selected, locally saved image and content type to the same-origin AI Gateway; the Gateway sends the image and extraction prompt to Google's Gemini API. The PWA stores images up to 10 MiB, while the Gateway accepts up to 6 MiB. The API key and model setting (`GEMINI_API_KEY` and `GEMINI_MODEL`) are Worker secrets/settings and must never enter the browser bundle. The Gemini Interactions API request uses `store: false`. Do not send a user's name, email, Actual Budget data, household history, or other receipts. Do not enable Google Search, grounding, or tools for receipt extraction. A failed analysis must leave the saved image intact.

Category classification sends only the minimum validated extraction state (merchant, total amount in yen, and at most 30 item names and amounts) through the same-origin AI Gateway to the TypeSafe System One endpoint. Never send receipt images, user name, email, user ID, receipt ID, storage key, purchase history, Actual Budget data, or other receipts to Jev. `TYPESAFE_API_KEY`, `TYPESAFE_API_URL`, and `JEV_MODEL` are Worker secrets/settings and must never enter the browser bundle. A provider failure or invalid response must leave the category unclassified for the user to review. The app first checks a locally stored, user-confirmed merchant mapping; only when there is no mapping does it call Jev.

## Test data

Use synthetic or thoroughly anonymized fixtures. Do not commit family financial records for tests.

## Deployment

Before exposing the service outside the home network:

- enable HTTPS
- require authentication
- use strong secrets
- ensure receipt files are not publicly addressable
- restrict Actual Budget administrative access
- establish backups
- verify restoration procedures
- review logs for accidental personal-data leakage

## Reporting

This is currently a personal project. Security issues should be reported privately to the repository owner rather than posted with sensitive reproduction data in a public issue.
