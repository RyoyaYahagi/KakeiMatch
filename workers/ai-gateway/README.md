# AI Gateway Worker

Cloudflare Worker for the native app API and the admin screen. The D1 binding stores account authentication, entitlement, usage metadata, and the explicit support Inbox. No AI request, provider, or response body is logged or persisted by the AI gateway. The explicit support Inbox separately stores sanitized messages and encrypted secret-stripped originals for 90 days, with metadata-only admin audits. The receipt image exists only in the in-flight Gemini request. Category classification sends only merchant, total JPY, and up to 30 item names and amounts to Gemini.

## Identity boundary and account routes

The iOS app uses `/api/native/*`, with Passkey and App Attest for authentication. `src/hosting.ts` serves the native API, AASA, and the Access-protected admin UI and API. Signing secrets and provider keys are Worker bindings.


The account D1 database contains identity/auth records, `account_entitlements`, and `ai_receipt_flows` usage/idempotency metadata, plus the support Inbox and metadata-only admin audits. It does not contain household data. Missing entitlement rows use the configured `AI_FREE_MONTHLY_LIMIT` (30 by default). Plus (stored as the internal plan ID `family`) has a null monthly limit, meaning no monthly product quota; the existing per-user/provider rate limit remains active. Pro is admin-set only and has a finite limit. Monthly buckets follow Asia/Tokyo calendar months; continuations remain in their starting month.

## Limits and errors

- JSON request body: 9 MiB maximum; Gemini image: 6 MiB maximum and JPEG/PNG/WebP signature checked.
- Provider response: 1 MiB maximum; fixed provider URLs/configuration and timeouts; no provider error body is returned.
- Cloudflare `AI_USER_RATE_LIMIT` binding: 20 requests per user/provider per minute. Cloudflare's built-in limit is location-local and permissive, so it is an abuse guard rather than exact billing.
- One AI use is one receipt flow: Gemini receipt extraction and optional Gemini category classification, including internal retries. Each explicit reanalysis uses a fresh UUID v4 `flowId`. Both request bodies require it. A flow reserves one use before its first Gemini request; auth/validation/quota failures do not count, but provider failures count.
- D1 binds a flow to the authenticated user and an image HMAC. Classification is allowed only for normalized category facts derived from a validated Gemini result, verified by a user/flow-scoped HMAC. Only HMACs and usage metadata are persisted, never household facts or responses. Image retries expire after ten minutes; category suggestions remain available for thirty days so locally saved receipts can be reviewed later. Each stage allows at most three attempts including the first; this bounds replay without trusting client retry claims. Retries remain available at monthly quota. The client can reuse validated category answers stored locally, including uncertain answers, and clears them on explicit reanalysis. Invalid/expired/replayed flows return `409 invalid_flow`; the client can offer manual category selection or explicit reanalysis.
- Safe error JSON uses only stable codes such as `unauthorized`, `invalid_request`, `rate_limited`, `provider_timeout`, and `provider_unavailable`.
- Gemini structured output (including safe integer yen values, optional item quantity/unit price, signed receipt adjustments, and category choices) is validated before return. With receipt items, classification returns matching `answers.item_0`, `answers.item_1`, ... entries in the same provider call. If there are no items, the `answers.category` result remains available. The client applies confidence thresholds and must still perform its own domain validation before saving.

## Local development and checks

This package has its own `package-lock.json` and is outside the pnpm workspace. Install its dependencies with `npm ci --prefix workers/ai-gateway`. Copy `.dev.vars.example` to `.dev.vars` only when local Worker routes need bindings, and use synthetic values. Real provider keys are needed only for live calls and must never be committed.

```sh
npm run --prefix workers/ai-gateway test
npm run --prefix workers/ai-gateway typecheck
npm run --prefix workers/ai-gateway build
```

`npm run --prefix workers/ai-gateway dev` starts the Worker locally with the Gateway Vite and Cloudflare configuration. CI builds the admin assets and runs `test/admin-e2e.mjs` against a local preview with synthetic admin responses.

The Worker supplies `ACCOUNT_DB`, `BETTER_AUTH_SECRET`, `AI_GATEWAY_AUTH_SECRET`, and `AI_FREE_MONTHLY_LIMIT` with the provider and rate-limit bindings. Provision real secret values with the current `cf` commands after checking `cf --help` and `cf cli search`; never pass values in shell arguments, save them in Git, or copy them between worktrees.

## Gemini classification

Classification calls the Gemini Decisions API (`POST https://generativelanguage.googleapis.com/v1beta/decisions`) with the fixed model `gemini-decision-1` (a constant in `src/worker.ts`) and the same `GEMINI_API_KEY` as receipt extraction. It does not read `GEMINI_MODEL`; that setting (default `gemini-3.5-flash-lite`) belongs to the Gemini Interactions API calls for receipt extraction, payroll, and the contact/admin text features. Each question is a `choice` over the allowed categories (Decisions needs at least two options, so a single category is padded with a hidden option the Worker removes from the result), and the Worker validates the choice, a probability for every allowed category, and confidence before returning it. Classification has no OpenCode or OpenRouter dispatch or fallback. Missing credentials, an open circuit, a provider error, or invalid output stops classification; existing manual category selection remains available. Historical Jev cost events and the `0017_jev_upstream_circuits.sql` migration remain for accounting/migration history but are not used for new requests. The legacy Next.js classifier in `src/lib/jev-category-classifier.ts` is a separate legacy path and not used by the production Worker.

Apply versioned SQL under `migrations/` before deployment. For Issue #60, apply `0003_receipt_ai_flows.sql` before updating the Worker. Retain legacy `ai_usage` rows but exclude them from all new usage/quota queries. There is no historical backfill: in the cutover month users receive a fresh quota and only new flows count, avoiding double counting across incompatible UTC/provider and Tokyo/flow units. Requests with missing identifiers fail closed. Existing receipts without a valid flow can still be edited/registered manually. Rolling back restores the legacy counter semantics. From `workers/ai-gateway`, administrators can assign plans with `ACCOUNT_D1_ID=<database-uuid> npm run account:set-plan -- <opaque-user-id> family`; `family` (shown to users as Plus) is unlimited at the product-quota layer. The Worker uses `AI_FREE_MONTHLY_LIMIT` (30 by default) for accounts without an explicit entitlement. Explicit `free` or `pro` assignments require `AI_FREE_MONTHLY_LIMIT` or `AI_PRO_MONTHLY_LIMIT` in the operator environment. The command is administrative; there is no client plan mutation route.

Production uses `https://kakeimatch.yhgry.workers.dev` for the native API and the admin screen. The default Issue #39 preview uses a separate synthetic-test D1 database.

See the [deployment guide](../../docs/DEPLOYMENT.md) for production updates, owner secret handling, operator invites, and Passkey/provider/iPhone checks.

## Provider cost events (Issue #117)

Apply migration `0004_ai_provider_costs.sql` before updating the Worker. Each dispatch, including retries, creates an operational-only cost event; pre-dispatch rejects create none. Interrupted or unmeasured requests remain `unknown`. Model IDs and safe HTTP codes are persisted, never request/response bodies or household facts. Existing product-flow quota semantics are unchanged.

The admin API reports monthly costs using Tokyo calendar months. Pricing is a versioned server-only catalog in `src/ai-provider-costs.ts`; append versions and preserve event snapshots. Standard paid USD costs are integers in micro-dollars, rounded up per request. Unknown model/usage or unsupported cache/tool billing remains unknown, not free. Gemini Interactions and GenerateContent usage shapes are supported. Historical Jev model entries remain in the catalog for persisted cost-event snapshots; new classification requests are recorded as Gemini. The admin screen provides aggregate costs to authorized operators. No global-cost endpoint is exposed to users.

## Global cost protection (Issue #56)

Apply `0005_ai_global_guardrails.sql` before updating the Worker. Global admission reuses cost events, storing an estimated reservation in each event. One conditional INSERT enforces provider request ceilings and global/provider daily/monthly liabilities across concurrent accounts, including Plus. Measured events use stored costs; pending/unknown events retain reservations. Sliding-minute request ceilings contain spikes. Costs are heuristic estimates, not exact provider invoice ceilings.

Server-only `AI_GUARDRAILS_JSON` overrides validated defaults; `AI_EMERGENCY_STOP=true` stops all providers. Unknown settings fail closed. Provider failures or unknown-metering spikes persist an open circuit until an operator resumes it in D1. Local developer options do not control protection. See [operator runbook](../../docs/AI_COST_GUARDRAILS.md) for defaults, time windows, investigation and safe resume. Ordinary pauses happen before flow quota reservation. A concurrent loser at the final event INSERT releases its undispatched product-flow reservation; interrupted reservations without an event are reclaimed after 120 seconds. All non-AI local flows remain available.

## Contact API

The iOS app uses native contact routes. Transcription uses inline Base64 audio with `gemini-3.5-transcribe`; final submission does not call AI or GitHub. It stores the final user-approved message in the internal admin Inbox, with secret removal before storage, common PII redaction in the visible copy, and AES-GCM encryption for the secret-stripped original. The encryption key is a server-only `FEEDBACK_ENCRYPTION_KEY`, encoded as base64/base64url for exactly 32 bytes; without it, submissions fail closed and are not saved. Diagnostics remain a strict whitelist of screen/action names, safe error codes, network state, and relative event age. Apply `0016_feedback_inbox.sql` before deployment. Inbox rows expire after 90 days. Admins explicitly request AI analysis or GitHub issue creation; GitHub receives only sanitized text, diagnostics, and the feedback ID. The issue creation callback must treat ambiguous results as unknown and prevent reposting. Apply the admin auth migration/configuration as described in the issue deployment changes.

## Cloud account deletion (Issue #151)

The native account deletion route requires a valid native session and resolves the user ID from that session. The D1 batch atomically writes an opaque-ID tombstone and deletes the user, cascading credentials, sessions, invites, entitlements, AI usage/cost records, and contact idempotency state. The tombstone and database trigger prevent a stale Passkey registration from restoring the deleted user ID. AI bearer JWTs are checked against the live account row on every request, so deletion invalidates them immediately. If cleanup fails, the D1 batch rolls back and the endpoint returns 503.
