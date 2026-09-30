# Security

KakeiMatch handles household finances and receipt images. Production uses the PWA in `apps/pwa` and a same-origin Cloudflare Worker. Household data stays in browser storage on the user's device; Cloud account authentication does not separate people who share one browser profile. Use separate device profiles and the operating system's screen lock on a shared device.

## Data boundaries

The browser-side Actual Budget engine and KakeiMatch IndexedDB hold budgets, receipts, statement imports, reconciliation results, and user decisions. The production app does not send those records to an application database. Cloudflare D1 stores Better Auth identity and sessions, Passkeys, invite and recovery state, entitlements, and AI usage counters only. D1 must never become a household history store.

Cloud account is optional for local household use. Cloud API routes must validate the Better Auth session or the AI token as appropriate. Resolve account identity from validated server-side credentials; never authorize a Cloud request using a user ID supplied in its URL, form, or JSON body. Legacy Next.js routes and server-side household storage are retained for reference and are not part of the production PWA request path.

The `.kmb` portable backup includes local household records and retained receipt/statement source files. It excludes Cloud credentials, sessions, AI tokens, entitlements, usage counters, and provider secrets. The archive is not encrypted. Keep it in a protected location outside browser storage and confirm restore behavior with synthetic data. Restore stages data into a new local profile before switching the active profile. The known Actual orphan cleanup limitation is tracked separately in Issue #58 and documented in [local backup and recovery](docs/LOCAL_BACKUP.md).

## Secrets

Never commit API keys, passwords, production environment files, Actual credentials, authentication secrets, real card statements, or real receipt images. Gemini, TypeSafe, Better Auth, and AI gateway signing secrets belong in Cloudflare secret bindings. Secret values must not appear in configuration source, logs, or browser bundles. Resource identifiers used to select production D1 are configuration values, not secrets; the production database must still be selected explicitly.

## Cloud account and AI

Better Auth and its Passkey plugin authenticate Cloud account routes. The account cookie is HttpOnly and SameSite=Lax, and Secure over HTTPS. Authentication routes validate trusted origins and protect state-changing requests against CSRF. AI JWTs are signed by the Worker, are limited to the AI audience, and expire within 10 minutes. The signing secret never enters the PWA bundle.

AI quota checks run independently of short-window abuse limits. The monthly counter increments after request validation and immediately before a provider request. Provider failures after dispatch count as usage; authentication, validation, and quota rejections do not. A client retry is another provider attempt. Family entitlement removes the product quota only and does not remove the abuse rate limit.

Receipt analysis is an explicit user action. The browser sends the selected, locally saved image to the same-origin AI gateway, which forwards it to Gemini. The PWA accepts JPEG, PNG, or WebP images up to 10 MiB for local storage; the gateway accepts at most 6 MiB. The gateway does not persist request or response bodies, and the Gemini request uses `store: false`. Do not send a user's name, email, Actual data, household history, or other receipts.

Category classification sends only validated merchant, total amount in yen, and at most 30 item names and amounts to TypeSafe Jev. Never send images, user or receipt identifiers, storage keys, purchase history, Actual data, or other receipts. Provider responses are schema-validated before application code can save a suggestion. Failures leave the user's confirmed data intact and the category available for review.

## Files and logs

Receipt images and statement files are untrusted input. The PWA validates image signatures and size before local storage. It parses the complete supported PayPay CSV before saving the original file and canonical rows. Other card formats remain disabled until their columns are verified. Statement CSV files and canonical rows never leave the device for Cloudflare, Gemini, Jev, or an Actual Sync Server. Confirmed statement-derived transactions can be registered in the device-local Actual browser engine.

Avoid logging financial data, raw AI request/response bodies, provider errors that may contain user data, and secrets. Use synthetic or thoroughly anonymized fixtures; never commit family financial records.

## Deployment

The application assumes the canonical production origin is `https://kakeimatch.yhgry.workers.dev`. Browser storage belongs to its origin, so keep the Worker name and origin stable after production use. Configuring a Worker named `kakeimatch` does not verify that Cloudflare routes this canonical origin to it. Production routes, D1, and secrets remain unprovisioned and unverified by Issue #39. Preview deployments are for synthetic tests only. The Service Worker must not cache `/api/*`; the Worker must retain its configured COOP and COEP headers for the browser-side Actual engine.

The production application does not require a home Linux server, Docker, Next.js server, Actual Sync Server, server household SQLite, or receipt/statement filesystem volumes. Legacy server components are not production security boundaries. Production route, D1, and secret provisioning must be verified before production use; Issue #39 does not deploy to or reconfigure production.

## Reporting

This is a personal project. Report security issues privately to the repository owner rather than posting sensitive reproduction data in a public issue.
