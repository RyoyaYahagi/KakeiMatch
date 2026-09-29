# AI Gateway Worker

Small Cloudflare Worker handler for the PWA's same-origin `POST /api/ai/gemini` and `POST /api/ai/jev` paths. It has no database, object storage, or logging of request, provider, or response bodies. The receipt image exists only in the in-flight Gemini request. Jev receives only merchant, total JPY, and up to 30 item names and amounts.

## Identity boundary

Both routes require an `Authorization: Bearer <JWT>` token signed with `AI_GATEWAY_AUTH_SECRET`. The gateway accepts HS256 tokens with `aud: "kakeimatch-ai"`, an opaque URL-safe `sub`, and an expiry no more than 10 minutes away. A trusted same-origin identity issuer must mint this token after authenticating the person. The token is for AI calls only; local data access does not use it. Never put the signing secret or provider keys in the PWA bundle. The PWA integration should use these same-origin paths, so its request stays within the app origin and preserves COOP/COEP behavior.

The existing server session can be the initial trusted issuer while that server remains in use. A future local-first issuer must establish user identity without relying on an ID supplied by the client. This Worker deliberately has no token-minting route.

## Limits and errors

- JSON request body: 9 MiB maximum; Gemini image: 6 MiB maximum and JPEG/PNG/WebP signature checked.
- Provider response: 1 MiB maximum; fixed provider URLs/configuration and timeouts; no provider error body is returned.
- Cloudflare `AI_USER_RATE_LIMIT` binding: 20 requests per user/provider per minute. Cloudflare's built-in limit is location-local and permissive, so it is an abuse guard rather than exact billing.
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

The `cloudflare.config.ts` declares only secret bindings, non-sensitive model settings, and a rate-limit binding. Provision real secret values with the current `cf workers secrets` commands after checking `cf cli search`; never pass values in shell arguments, save them in Git, or copy them between worktrees. The dedicated Worker name is `kakeimatch-pr-36`; deploy it only as a Worker Preview with `cf previews deploy kakeimatch-pr-36`. Do not run `cf deploy` for this isolated preview Worker.

This isolated preview has its own origin. The same-origin route must be integrated with the #32 PWA Worker after #32 is merged. The identity issuer is intentionally not included because the PWA and identity flow are being implemented separately. Until the issuer and secret bindings exist, requests fail closed with `not_configured`.
