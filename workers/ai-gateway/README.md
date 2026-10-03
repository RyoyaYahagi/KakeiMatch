# AI Gateway Worker

Cloudflare Worker handlers for the PWA's same-origin Cloud account and AI routes. The D1 binding stores only account authentication, entitlement, and monthly usage metadata. No request, provider, or response body is logged or persisted. The receipt image exists only in the in-flight Gemini request. Jev receives only merchant, total JPY, and up to 30 item names and amounts.

## Identity boundary and account routes

Both provider routes require an `Authorization: Bearer <JWT>` token signed with `AI_GATEWAY_AUTH_SECRET`. The gateway accepts HS256 tokens with `aud: "kakeimatch-ai"`, an opaque URL-safe `sub`, and an expiry no more than 10 minutes away. The same-origin `/api/ai/token` route signs this token after checking the Better Auth session. The token is for AI calls only; local data access does not use it. Never put the signing secret or provider keys in the PWA bundle. `apps/pwa/src/worker.ts` mounts the handlers under the app origin and preserves COOP/COEP behavior.

`POST /api/ai/token` and `GET /api/ai/usage` use the Better Auth session from the account cookie. The token endpoint does not accept an identity in the request; it signs the server-resolved account ID. The token is valid for 10 minutes, while account sessions use the separately configured 14-day lifetime with 24-hour refresh age. A valid session can silently mint a new token after expiry.

The account D1 database contains identity/auth records, `account_entitlements`, and `ai_receipt_flows` usage/idempotency metadata only. It does not contain household data. Missing entitlement rows use the configured `AI_FREE_MONTHLY_LIMIT` (30 by default). Family has a null monthly limit, meaning no monthly product quota; the existing per-user/provider rate limit remains active. Pro is admin-set only and has a finite limit. Monthly buckets follow Asia/Tokyo calendar months; continuations remain in their starting month.

## Limits and errors

- JSON request body: 9 MiB maximum; Gemini image: 6 MiB maximum and JPEG/PNG/WebP signature checked.
- Provider response: 1 MiB maximum; fixed provider URLs/configuration and timeouts; no provider error body is returned.
- Cloudflare `AI_USER_RATE_LIMIT` binding: 20 requests per user/provider per minute. Cloudflare's built-in limit is location-local and permissive, so it is an abuse guard rather than exact billing.
- One AI use is one receipt flow: Gemini plus optional Jev, including internal retries. Each explicit reanalysis uses a fresh UUID v4 `flowId`. Both provider JSON bodies require it. A flow reserves one use before its first Gemini request; auth/validation/quota failures do not count, but provider failures count.
- D1 binds a flow to the authenticated user and an image HMAC. Jev is allowed only for the normalized category facts derived from a validated Gemini result, verified by a user/flow-scoped HMAC. Only HMACs and usage metadata are persisted, never household facts or responses. Image retries expire after ten minutes; category suggestions remain available for thirty days so locally saved receipts can be reviewed later. Each provider stage allows at most three attempts including the first; this bounds replay without trusting client retry claims. Retries remain available at monthly quota. The PWA reuses validated category answers stored locally, including uncertain answers, and clears them on explicit reanalysis. Invalid/expired/replayed flows return `409 invalid_flow`; the PWA offers manual category selection or explicit reanalysis.
- Safe error JSON uses only stable codes such as `unauthorized`, `invalid_request`, `rate_limited`, `provider_timeout`, and `provider_unavailable`.
- Gemini structured output (including safe integer yen values, optional item quantity/unit price, and signed receipt adjustments) and Jev choice answers are validated before return. With receipt items, Jev receives one question per item and must return matching `answers.item_0`, `answers.item_1`, ... entries in the same provider call. If there are no items, the legacy `answers.category` question remains available. The client applies confidence thresholds and must still perform its own domain validation before saving.

## Local development and checks

This package has its own `package-lock.json` and is outside the pnpm workspace. Install its dependencies with `npm ci --prefix workers/ai-gateway`. Copy `.dev.vars.example` to `.dev.vars` only when local Worker routes need bindings, and use synthetic values. Real provider keys are needed only for live calls and must never be committed.

```sh
npm run --prefix workers/ai-gateway test
npm run --prefix workers/ai-gateway typecheck
npm run --prefix workers/ai-gateway build
```

`npm run --prefix workers/ai-gateway dev` runs Vite directly and does not load the PWA's `cf` configuration. For local checks of the production PWA and its same-origin API routes, use root `pnpm dev` or build then use root `pnpm start`. Use the standalone Worker commands for its isolated tests and build.

The PWA Worker supplies `ACCOUNT_DB`, `BETTER_AUTH_SECRET`, `AI_GATEWAY_AUTH_SECRET`, and `AI_FREE_MONTHLY_LIMIT` with the provider and rate-limit bindings. Provision real secret values with the current `cf` commands after checking `cf --help` and `cf cli search`; never pass values in shell arguments, save them in Git, or copy them between worktrees.

Apply versioned SQL under `migrations/` before deployment. For Issue #60, apply `0003_receipt_ai_flows.sql` before updating the Worker and PWA together. Retain legacy `ai_usage` rows but exclude them from all new usage/quota queries. There is no historical backfill: in the cutover month users receive a fresh quota and only new flows count, avoiding double counting across incompatible UTC/provider and Tokyo/flow units. Missing identifiers from stale clients fail closed; refresh the PWA to use AI. Existing receipts without a valid flow can still be edited/registered manually. Rolling back restores the legacy counter semantics. From `workers/ai-gateway`, administrators can assign plans with `ACCOUNT_D1_ID=<database-uuid> npm run account:set-plan -- <opaque-user-id> family`; `family` is unlimited at the product-quota layer. The Worker uses `AI_FREE_MONTHLY_LIMIT` (30 by default) for accounts without an explicit entitlement. Explicit `free` or `pro` assignments require `AI_FREE_MONTHLY_LIMIT` or `AI_PRO_MONTHLY_LIMIT` in the operator environment. The command is administrative; there is no client plan mutation route.

The PWA and account/AI handlers run on the same origin. The default Issue #39 preview uses its own synthetic-test D1 database. Production uses the canonical origin `https://kakeimatch.yhgry.workers.dev`; its route, D1, and secrets must be provisioned for production use. Preview origin and data are never for household use. The Service Worker does not cache `/api/*`, and the Worker must preserve COOP/COEP behavior for the browser-side Actual engine.

See the [deployment guide](../../docs/DEPLOYMENT.md) for production updates, owner secret handling, operator invites, and Passkey/provider/iPhone checks.

## Provider cost events (Issue #117)

Apply migration `0004_ai_provider_costs.sql` before updating the Worker. Each dispatch, including retries, creates an operational-only cost event; pre-dispatch rejects create none. Interrupted or unmeasured requests remain `unknown`. Model IDs and safe HTTP codes are persisted, never request/response bodies or household facts. Existing product-flow quota semantics are unchanged.

`GET /api/ai/costs?month=YYYY-MM` uses the account session and returns only that account's Tokyo-calendar-month totals. Omit the month for the current month. Pricing is a versioned server-only catalog in `src/ai-provider-costs.ts`; append versions and preserve event snapshots. Standard paid USD costs are integers in micro-dollars, rounded up per request. Unknown model/usage or unsupported cache/tool billing remains unknown, not free. Gemini Interactions and GenerateContent usage shapes are supported; Jev requires its returned versioned model ID. The PWA exposes costs only with local developer options enabled; this toggle is not authorization. No global-cost endpoint is exposed to users.

## Global cost protection (Issue #56)

Apply `0005_ai_global_guardrails.sql` before updating the Worker. Global admission reuses cost events, storing an estimated reservation in each event. One conditional INSERT enforces provider request ceilings and global/provider daily/monthly liabilities across concurrent accounts, including Family. Measured events use stored costs; pending/unknown events retain reservations. Sliding-minute request ceilings contain spikes. Costs are heuristic estimates, not exact provider invoice ceilings.

Server-only `AI_GUARDRAILS_JSON` overrides validated defaults; `AI_EMERGENCY_STOP=true` stops all providers. Unknown settings fail closed. Provider failures or unknown-metering spikes persist an open circuit until an operator resumes it in D1. Local developer options do not control protection. See [operator runbook](../../docs/AI_COST_GUARDRAILS.md) for defaults, time windows, investigation and safe resume. Ordinary pauses happen before flow quota reservation. A concurrent loser at the final event INSERT releases its undispatched product-flow reservation; interrupted reservations without an event are reclaimed after 120 seconds. All non-AI local flows remain available.

## Contact API

The PWA mounts `POST /api/contact/transcribe`, `POST /api/contact/interview`, and `POST /api/contact` with the same signed AI token, same-origin checks, quotas and cost guardrails as receipt AI. Transcription uses inline Base64 audio with `gemini-3.5-transcribe`; the optional one-question-at-a-time interview and final classification use the configured Gemini text model. Interview calls receive a server-owned Product Context plus, only after separate user opt-in, a strictly validated diagnostic object containing whitelisted screen/action names, safe error codes, network state, and relative event age. Free-form logs, stack traces, URLs, household values, and user-authored strings are not accepted as diagnostics. Each provider call uses one product-flow allowance. Interview bodies, answers, and diagnostics are not stored in D1. Apply `0006_contact_submissions.sql` and provision `GITHUB_ISSUES_TOKEN` (Issues write permission on the configured repository) before deployment. Only bugs and concrete improvements are posted. Inquiry bodies and audio are not stored in D1. Ambiguous GitHub creation outcomes block automatic reposting. See [contact behavior and operational limits](../../docs/CONTACT.md).
