# AI Gateway Worker

Cloudflare Worker handlers for the PWA's same-origin Cloud account and AI routes. The D1 binding stores only account authentication, entitlement, and monthly usage metadata. No request, provider, or response body is logged or persisted. The receipt image exists only in the in-flight Gemini request. Jev receives only merchant, total JPY, and up to 30 item names and amounts.

## Identity boundary and account routes

Both provider routes require an `Authorization: Bearer <JWT>` token signed with `AI_GATEWAY_AUTH_SECRET`. The gateway accepts HS256 tokens with `aud: "kakeimatch-ai"`, an opaque URL-safe `sub`, and an expiry no more than 10 minutes away. The same-origin `/api/ai/token` route signs this token after checking the Better Auth session. The token is for AI calls only; local data access does not use it. Never put the signing secret or provider keys in the PWA bundle. `apps/pwa/src/worker.ts` mounts the handlers under the app origin and preserves COOP/COEP behavior.

`POST /api/ai/token` and `GET /api/ai/usage` use the Better Auth session from the account cookie. The token endpoint does not accept an identity in the request; it signs the server-resolved account ID. The token is valid for 10 minutes, while account sessions use the separately configured 14-day lifetime with 24-hour refresh age. A valid session can silently mint a new token after expiry.

The account D1 database contains identity/auth records, `account_entitlements`, and monthly `ai_usage` counters only. It does not contain household data. Missing entitlement rows use the configured `AI_FREE_MONTHLY_LIMIT` (30 by default). Family has a null monthly limit, meaning no monthly product quota; the existing per-user/provider rate limit remains active. Pro is admin-set only and has a finite limit. Monthly buckets follow UTC calendar months.

## Limits and errors

- JSON request body: 9 MiB maximum; Gemini image: 6 MiB maximum and JPEG/PNG/WebP signature checked.
- Provider response: 1 MiB maximum; fixed provider URLs/configuration and timeouts; no provider error body is returned.
- Cloudflare `AI_USER_RATE_LIMIT` binding: 20 requests per user/provider per minute. Cloudflare's built-in limit is location-local and permissive, so it is an abuse guard rather than exact billing.
- Monthly quota increments once after request validation and immediately before a provider request. Validation/auth/quota failures do not increment. Provider timeouts and failures after the request starts count. A client retry is a new provider attempt and counts again.
- Safe error JSON uses only stable codes such as `unauthorized`, `invalid_request`, `rate_limited`, `provider_timeout`, and `provider_unavailable`.
- Gemini structured output and Jev category probabilities are validated before return. Application code must still perform its own domain validation before saving.

## Local development and checks

Copy `.dev.vars.example` to `.dev.vars` and provide synthetic values for tests/local development. Real provider keys are only needed for live calls and must never be committed.

```sh
npm ci
npm run dev
npm test
npm run typecheck
npm run build
```

The PWA Worker supplies `ACCOUNT_DB`, `BETTER_AUTH_SECRET`, `AI_GATEWAY_AUTH_SECRET`, and `AI_FREE_MONTHLY_LIMIT` with the existing provider and rate-limit bindings. Provision real secret values with the current `cf` commands after checking `cf cli search`; never pass values in shell arguments, save them in Git, or copy them between worktrees.

Apply versioned SQL under `migrations/` before deployment. From `workers/ai-gateway`, administrators can assign plans with `ACCOUNT_D1_ID=<database-uuid> npm run account:set-plan -- <opaque-user-id> family`; `family` is unlimited at the product-quota layer. The Worker uses `AI_FREE_MONTHLY_LIMIT` (30 by default) for accounts without an explicit entitlement. Explicit `free` or `pro` assignments require `AI_FREE_MONTHLY_LIMIT` or `AI_PRO_MONTHLY_LIMIT` in the operator environment. The command is administrative; there is no client plan mutation route.

The PWA and API handlers run in one Issue #6 Preview Worker. This Preview uses its own D1 database and trusted origin. Issue #35 will connect receipt and category actions to the token and provider routes.
