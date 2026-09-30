# Security

KakeiMatch handles personal financial information and receipt images. Security and privacy take priority over convenience when the two conflict.

## Data model requirement

MVPでは各ユーザーは自分の家計簿だけを閲覧・操作できます。

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

The local PWA household experience does not require a Cloud account. Local Actual Budget data, receipts, statements, reconciliation results, and backups remain on the device. A Cloud account is used for Passkey identity, AI access, and entitlements. Its D1 database stores only account authentication records, entitlement settings, and monthly AI usage counters. It must not store household transactions, receipt content or images, statement files or rows, reconciliation results, or Actual Budget data. See [Cloud account operations](docs/CLOUD_ACCOUNT.md).

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

Statement CSV files are saved through `StatementStorage` outside the public directory. `STATEMENT_STORAGE_DIR` identifies the private location; Docker Compose mounts the separate `statement-data` volume. The server generates storage keys and stores no absolute path or original filename in the database. Imports and canonical rows are scoped to the authenticated user. CSV data is never sent to Gemini, Jev, or Actual Budget by Issue #11. Validate the entire CSV before persisting any rows; remove the raw file if the database transaction fails.

## External AI

Receipt data sent to Gemini and TypeSafe leaves the self-hosted environment.

Only send data required for the requested processing. Do not send authentication data, unrelated transaction history, or other users' information.

Receipt analysis sends the saved receipt image, its content type, and the extraction prompt to Google's Gemini API. The API key and model setting are server-only environment variables (`GEMINI_API_KEY` and `GEMINI_MODEL`); never expose them through a `NEXT_PUBLIC_` variable or return them to the browser. The Gemini Interactions API request must use `store: false`. Do not send a user's name, email, Actual Budget data, household history, or other receipts. Do not enable Google Search, grounding, or tools for receipt extraction. A failed analysis must leave the saved image intact.

Category classification sends only the minimum validated extraction state needed for the decision (merchant, total amount in yen, and a bounded set of item names and amounts) to the TypeSafe System One endpoint. Never send receipt images, user name, email, user ID, receipt ID, storage key, purchase history, Actual Budget data, or other receipts to Jev. `TYPESAFE_API_KEY`, `TYPESAFE_API_URL`, and `JEV_MODEL` are server-only settings; do not expose them through `NEXT_PUBLIC_` variables or return them to the browser. A provider failure or invalid response must leave the category unclassified for the user to review.

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
