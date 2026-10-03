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

Receipt images and statement files are untrusted input. The PWA validates image signatures and size before local storage. It parses the complete supported PayPayカード CSV before saving the original file and canonical rows. Unsupported card formats remain disabled until their columns are verified. Statement CSV files and canonical rows never leave the device for Cloudflare, Gemini, Jev, or an Actual Sync Server. Confirmed statement-derived transactions can be registered in the device-local Actual browser engine.

Avoid logging financial data, raw AI request/response bodies, provider errors that may contain user data, and secrets. Use synthetic or thoroughly anonymized fixtures; never commit family financial records. The PWA support Flight Recorder is an exception only for fixed, non-user-authored metadata: whitelisted screen/action names, safe error codes, network state, and relative event age. It must remain memory-only, must not accept free-form strings or stack traces, and is attached to support requests only after explicit user opt-in.

## Deployment

Settings also provides a local diagnostic report with strictly validated build/schema versions, network status, whitelisted feature/result codes and relative ages. It remains in memory for at most 15 minutes and 40 events, and is cleared by reload or an explicit clear action. Copy/export uses the exact user-reviewed snapshot, works offline, and never automatically sends the report. No raw errors, arbitrary inputs, household content, filenames, URLs, secrets or persistent device identifiers are collected. See [local diagnostics](docs/LOCAL_DIAGNOSTICS.md).

The application assumes the canonical production origin is `https://kakeimatch.yhgry.workers.dev`. Browser storage belongs to its origin, so keep the Worker name and origin stable after production use. Configuring a Worker named `kakeimatch` does not verify that Cloudflare routes this canonical origin to it. Production routes, D1, and secrets remain unprovisioned and unverified by Issue #39. Preview deployments are for synthetic tests only. The Service Worker must not cache `/api/*`; the Worker must retain its configured COOP and COEP headers for the browser-side Actual engine.

The production application does not require a home Linux server, Docker, Next.js server, Actual Sync Server, server household SQLite, or receipt/statement filesystem volumes. Legacy server components are not production security boundaries. Production route, D1, and secret provisioning must be verified before production use; Issue #39 does not deploy to or reconfigure production.

## Browser policy and reviewed boundaries

The PWA static responses and same-origin Worker API responses use a Content Security Policy. Scripts are limited to same-origin files; `wasm-unsafe-eval` permits the Actual browser engine to compile its embedded WebAssembly without enabling general `unsafe-eval`. `worker-src` permits same-origin, `blob:`, and `data:` workers because Actual's browser build creates an embedded worker from a Blob and retains a data URL fallback. `style-src 'unsafe-inline'` remains for the app's runtime CSS custom properties and Actual's generated styles; inline scripts are not permitted. Images and media are limited to same-origin, local Blob URLs, and data URLs used for local receipts and bundled resources. Network connections are same-origin only. The policy blocks objects and framing, and restricts base URLs and form targets.

The Service Worker caches the root response as received and returns that response for offline navigation, preserving CSP together with COOP and COEP. It does not intercept `/api/*`; the Worker sets the same policy on its JSON responses. A dedicated synthetic browser test checks the online app shell, Actual-backed local records, offline use, and CSP violations. It puts HTML-shaped merchant, item, and memo values through save and detail rendering online and offline, and verifies that they remain text.

The browser test observes one expected `script-src` violation: the generated Actual browser bundle probes whether the general `Function("")` constructor is available and catches the blocked result. The app continues through that fallback. The policy intentionally leaves general `unsafe-eval` disabled; the test fails on any other CSP violation.

The browser bundle build checks emitted client chunks for secret values provided through known build environment variables and Google API-key-shaped values. Cloudflare runtime bindings are only available to the Worker; provider and authentication secrets are configured there. The Vite module-graph boundary also rejects unapproved server modules from the browser build. These checks complement code review; they cannot detect arbitrary secret values copied under an unrecognized format.

Boundary review for this change found that the browser has only same-origin application/API fetches and no third-party script or analytics SDK. The three `innerHTML` sites are limited to fixed application markup and SVG strings selected from the compile-time icon map; receipt, merchant, item, memo, and statement text is rendered through DOM text nodes. Existing auth routes retain trusted-origin checks, CSRF protection, HttpOnly/SameSite cookies, and server-derived identity. Existing upload/archive validators and memory-only fixed-field diagnostics remain the input and logging boundaries. COOP/COEP, `nosniff`, API cache exclusions, and the Service Worker update/cache behavior remain in place. This scoped review is not a full dependency, authentication, archive, or browser security audit; dependency vulnerability tracking and the remaining checks listed in Issue #54 require separate work.

## Reporting

This is a personal project. Report security issues privately to the repository owner rather than posting sensitive reproduction data in a public issue.
