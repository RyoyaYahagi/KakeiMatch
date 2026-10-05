# Issue #39: legacy runtime dependency inventory

This inventory records the repository before the Issue #39 runtime metadata changes. The inspected base commit was `3cf49ea184b8c509ade99c8879343bba8c60ff8e`.

## Finding

The root Next.js application and its server-side Actual integration are legacy reference code. The production entrypoints are `apps/pwa` and the AI/account handlers in `workers/ai-gateway`. The PWA imports several browser-safe modules from root `src/lib`; those modules remain production dependencies even though the Next.js runtime is legacy.

## A — production runtime

- `apps/pwa/**`: the Vite PWA, browser UI, local IndexedDB storage, browser Actual integration, statement import, reconciliation, backup/restore, service worker, and Cloudflare Worker entrypoint. `apps/pwa/vite.config.ts` builds the Cloudflare application and aliases `@` to root `src`.
- `workers/ai-gateway/**`: account authentication and AI API handlers. `apps/pwa/src/worker.ts` imports `workers/ai-gateway/src/account-auth.ts` and `workers/ai-gateway/src/worker.ts`. Its D1 migrations and bindings support Cloud account and AI use.
- The PWA Cloudflare configuration uses the Issue #39 preview by default. Production configuration is selected only by the explicit `production-deploy` mode and requires account D1 settings. Root scripts expose `deploy:preview` for the Issue #39 preview and `deploy` for the explicit production mode; only the dedicated preview was deployed for synthetic verification; production was not deployed.
- Browser-safe root modules imported by the PWA:
  - `src/lib/local-data.ts`: IndexedDB repository used by receipt, statement, reconciliation, and backup features.
  - `src/lib/local-backup-format.ts`: validates and encodes the portable `.kmb` backup format.
  - `src/lib/encrypted-household-format.ts` and `src/lib/encrypted-sync-version.ts`: shared authenticated encryption and verification of portable encrypted versions. The sync restore entrypoint is not exposed in the normal UI until the household coordinator is implemented.
  - `src/lib/actual-browser-ledger.ts`: browser Actual Budget operations, dynamically loading `@actual-app/api`.
  - `src/lib/category.ts`: category IDs, labels, and merchant normalization.
  - `src/lib/receipt-extraction.ts`: shared receipt extraction schema validation.
  - `src/lib/receipt-validation.ts`: image type and size validation used in the browser.
  - `src/lib/reconciliation-engine.ts`: deterministic receipt-to-statement matching rules.
  - `src/lib/statement-parser-core.ts`: CSV parser core using the browser-compatible `csv-parse/browser/esm/sync` entrypoint.
- `src/lib/actual-ledger.ts` supplies `ActualAccount`, `ActualCategory`, `ActualLedger`, and `ActualTransaction` types imported by `actual-browser-ledger.ts`. Preserve it with the browser modules; it is a type-level shared contract.
- `@actual-app/api`, `csv-parse`, and `zod` remain root runtime dependencies for shared-module type/build resolution. The PWA also declares its own runtime dependencies in `apps/pwa/package.json`. PWA and Worker authentication dependencies remain in their respective workspace packages.

Moving or deleting any shared module above breaks PWA compilation or local household features. Moving them requires coordinated updates to relative imports, TypeScript paths, Vite aliases, the pnpm workspace, and CI.

## B — legacy server runtime, not imported by the local-first app

- `src/app/**` and `src/db/**`: Next.js pages, API routes, and server database access. The PWA has no imports from these trees.
- Legacy server adapters in `src/lib`: `auth.ts`, `auth-client.ts`, `current-user.ts`, `env.ts`, `actual-gateway.ts`, `actual-receipt-writer.ts`, `actual-reconciliation-writer.ts`, `actual-budget-mapping.ts`, `actual-category-resolution.ts`, `actual-ledger.ts` runtime use, `receipt-storage.ts`, `statement-storage.ts`, `statement-parser.ts`, `gemini-receipt-extractor.ts`, `jev-category-classifier.ts`, `reconciliation-repository.ts`, `reconciliation-service.ts`, `reconciliation-review.ts`, `reconciliation-review-actions.ts`, `receipt-category-state.ts`, `receipt-registration-input.ts`, and `receipt-registration-state.ts`.
- `drizzle/**`, `drizzle.config.ts`, `next.config.ts`, `next-env.d.ts`, and root `tsconfig.json` support the legacy Next.js runtime. Keep the source in place as reference/development code for this Issue; this inventory does not propose deleting or relocating it.
- Root legacy-only packages include `@actual-app/cli`, `@better-auth/drizzle-adapter`, `@better-auth/passkey`, `@google/genai`, `@next/env`, `better-auth`, `better-sqlite3`, `drizzle-orm`, `next`, `react`, and `react-dom`. These packages can be development dependencies in the root workspace while legacy source remains available for local reference and tests. Current PWA/Worker manifests continue to own their runtime dependencies.
- Legacy administrator commands are `scripts/create-user.ts`, `scripts/link-actual-budget.ts`, and `scripts/map-actual-categories.ts`. Keep these available under `legacy:*` script names.
- `legacy/compose.yaml`, `legacy/Dockerfile`, and `legacy/.env.example` preserve the previous self-hosted Next.js + SQLite + Actual Server deployment. Compose must build from the repository root context because the Dockerfile copies root source files. The PWA's current `deploy` scripts do not reach this legacy app, but an operator can still explicitly build and run its production `runner` image through Compose. This is therefore a preserved, manually reachable legacy deployment path, not an unreachable source-only sample.

## C — test, development, and evaluation only

- At the inspected base, `.github/workflows/ci.yml` had separate `validate` and `local-first` jobs. `validate` checked root sources and built Next.js; `local-first` checked the PWA, backup browser flow, Worker, and shared reconciliation evaluation.
- `vitest.config.ts` and `src/**/*.test.ts` include both legacy server regression tests and tests for shared browser-safe modules. Retain local regression tests in the default test command. `src/lib/actual-gateway.live.test.ts` needs Actual Server credentials and two synthetic Budget IDs, so exclude it from the default test command and keep a separate `legacy:test:live` command.
- Legacy integration tests that create SQLite files use `mkdtemp` under the operating system temporary directory and remove those files after the test. Those temporary fixtures are not the runtime household database at `DATABASE_PATH` and do not require an Actual Server, except the explicitly gated live test.
- `eval/run-reconciliation-eval.ts` exercises the shared matcher on synthetic data and remains a development command. The live category evaluation under `eval/run-jev-category-eval.ts` uses the legacy Jev server adapter.
- `spikes/actual-browser/**` is an isolated feasibility spike built by the `browser-spike` CI job. It is not imported by the PWA.
- `apps/pwa/test/**`, `workers/ai-gateway/src/**/*.test.ts`, and Worker administrative scripts support current PWA/Worker development and checks.

## D — documentation and historical records

- `README.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCT.md`, `docs/UX.md`, and `docs/DESIGN.md` mix current local-first guidance with historical Next.js instructions. Keep the current guidance and label or update legacy instructions rather than treating these documents as runtime dependencies.
- `docs/DEPLOYMENT.md` and root legacy deployment instructions describe the self-hosted Next.js deployment. The moved Compose files and `legacy/README.md` are their reference implementation.
- `docs/ACTUAL_BROWSER_SPIKE.md` and `docs/ACTUAL_RECEIPT_LIVE_TEST.md` are historical investigation notes. `docs/STATEMENT_FORMATS.md` still records current provider support limits and remains relevant to the PWA.
- Screenshots, `docs/CODING_AGENT_PROMPT.md`, and `docs/IMPLEMENTATION_PLAN.md` are supporting or historical material, not runtime inputs.

## E — completely unnecessary references

No tracked source file was proven unnecessary for both local-first use and legacy regression/reference work. The former root deployment locations were removed and their optional examples relocated to `legacy/`. Generated `.next` output is not a production artifact.

## Removal and migration risks

- Do not remove the root `src/lib` modules listed under A, including `actual-ledger.ts` types. The PWA resolves those imports through its Vite alias and relative paths.
- Do not remove `apps/pwa` or `workers/ai-gateway` dependencies while changing root package metadata. Their manifests define current browser and Worker runtime dependencies.
- Do not treat temporary SQLite files created by legacy tests as production database usage. They isolate test fixtures in the system temporary directory.
- Moving Compose files without setting build context to the repository root and pointing to `legacy/Dockerfile` breaks root source copies. The legacy Docker build must call `legacy:db:migrate` and `legacy:build`; the maintenance image must call `legacy:user:create`.
- The legacy Docker dependency stage now includes `apps/pwa/package.json` before frozen installation, and the builder copies its workspace dependency links. The optional legacy runner retains development dependencies because its CLI subprocess and SQLite adapter still need them. Docker was intentionally not started or built for this verification.
- The root package remains a pnpm workspace member because the PWA imports shared source from `../../src`. Root `dev`, `build`, and `start` can target the PWA while preserving explicit `legacy:*` commands for the Next.js reference runtime.

## After the Issue #39 runtime metadata change

- Root `dev` and `build` delegate to `apps/pwa`; `start` serves the built PWA locally. `deploy` selects the explicit `production-deploy` mode, while `deploy:preview` targets the Issue #39 preview. The Cloudflare configuration defaults to preview; production requires the explicit mode and its account database bindings.
- `apps/pwa` uses `cf dev` and `cf build` so Cloudflare's project configuration participates in local serving and builds. The Vite plugin explicitly enables the new Cloudflare configuration and Build Output Specification, so `vite preview` reads the combined PWA/Worker output rather than silently serving an assets-only build. `cf build` remains the documented build entrypoint.
- Legacy Next.js, Actual Server, SQLite, Drizzle, and server-side AI packages move to root development dependencies. PWA browser packages remain root dependencies where shared-source resolution needs them, and PWA/Worker manifests retain their own runtime dependencies.
- `legacy/compose.yaml`, `legacy/Dockerfile`, and `legacy/.env.example` hold the old server deployment. Compose uses the repository root build context and the Dockerfile at `legacy/Dockerfile`; its app image calls `legacy:db:migrate` and `legacy:build`, and its maintenance image calls `legacy:user:create`.
- The default root test command retains local and legacy regression tests but excludes the credential-gated `actual-gateway.live.test.ts`; `legacy:test:live` runs that test explicitly. `test/legacy-fixtures.ts` sets disposable SQLite, storage, and CLI-cache paths before each test file loads. Individual integration tests may replace them with their own disposable fixtures. Both are removed after the tests; default tests do not open an operator database or create `data/kakeimatch.db`.
- Current legacy environment-variable references are in `legacy/.env.example`, `legacy/compose.yaml`, `legacy/Dockerfile`, `src/lib/env.ts`, `src/db/client.ts`, and the server adapters listed under B. `AUTH_SECRET`, `DATABASE_PATH`, `ACTUAL_SERVER_URL`, `ACTUAL_SERVER_PASSWORD`, `ACTUAL_CLI_DATA_DIR`, and the server storage paths belong to that legacy server path. `GEMINI_API_KEY` and `TYPESAFE_API_KEY` also appear in `apps/pwa/cloudflare.config.ts`, `workers/ai-gateway/cloudflare.config.ts`, and `workers/ai-gateway/src/worker.ts`; those are current Cloudflare Worker bindings and provider calls, not stale legacy configuration. Current account authentication uses Worker bindings such as `BETTER_AUTH_SECRET` and `AI_GATEWAY_AUTH_SECRET`.
- Current old-CLI and command references are grouped as follows: executable legacy commands in root `package.json`; the commands invoked by `legacy/Dockerfile`; usage instructions in `legacy/README.md`; runtime calls to `@actual-app/cli` in `src/lib/actual-gateway.ts`, `src/lib/actual-receipt-writer.ts`, and `src/lib/actual-reconciliation-writer.ts`; temporary Actual test setup in `src/lib/actual-gateway.live.test.ts`; and historical instructions in `docs/ACTUAL_RECEIPT_LIVE_TEST.md`, `docs/ACTUAL_BROWSER_SPIKE.md`, `docs/CODING_AGENT_PROMPT.md`, and `docs/legacy/IMPLEMENTATION_PLAN.md`. `docs/CLOUD_ACCOUNT.md` also records an older `wrangler` command for preview secrets; it is an operational history reference, while current Worker config and source use `cf` bindings.
- The current CI runs a single `ci` job that checks root lint/typecheck/tests, builds the PWA, and runs the PWA browser flows. It no longer builds Next.js. The AI Gateway Worker is checked by a separate workflow only when `workers/ai-gateway/**` changes. CI does not build or run the legacy Compose image.
- Legacy examples still use Next.js production mode internally. They are optional development/migration references, outside the supported Cloudflare production application; no default command or CI job starts them.


## Residual legacy-runtime references after cleanup

The following paths still contain one or more of the old Actual server/CLI or filesystem settings. None is imported by the production PWA/Worker module graph. The build rejects root modules outside the audited shared set and rejects Next.js, Actual CLI, and better-sqlite3 modules in that graph.

| Paths | Classification and reason retained | Production runtime reachable? |
| --- | --- | --- |
| `legacy/.env.example`, `legacy/compose.yaml`, `legacy/Dockerfile`, `legacy/README.md` | B/C: optional old-server development and migration references | No; only an explicit legacy command starts this example |
| `package.json`, `pnpm-lock.yaml` | C: CLI is a development dependency for old tests/tools; versions remain locked | No; CLI is absent from production dependencies and bundle graph |
| `src/lib/env.ts`, `actual-gateway.ts`, `actual-receipt-writer.ts`, `actual-reconciliation-writer.ts`, `receipt-storage.ts`, `statement-storage.ts` | B: old server adapters kept for regression/reference | No |
| `src/lib/env.test.ts`, `actual-gateway.test.ts`, `actual-receipt-writer.test.ts`, `statement-import.integration.test.ts`, `test/legacy-fixtures.ts` | C: synthetic regression tests and disposable test paths | No |
| `src/lib/actual-gateway.live.test.ts` | C: explicitly opted-in test against two synthetic server Budgets; excluded by default | No |
| `.github/workflows/ci.yml` | C: unsets the old settings before browser E2E | No |
| `docs/ACTUAL_BROWSER_SPIKE.md`, `docs/ACTUAL_RECEIPT_LIVE_TEST.md`, `docs/CODING_AGENT_PROMPT.md`, `docs/legacy/ARCHITECTURE.md`, `docs/legacy/IMPLEMENTATION_PLAN.md`, this inventory | D: historical evidence and cleanup decisions | No |

Search used: `rg --hidden -l 'ACTUAL_SERVER_URL|ACTUAL_SERVER_PASSWORD|ACTUAL_CLI_DATA_DIR|RECEIPT_STORAGE_DIR|STATEMENT_STORAGE_DIR|actualbudget/actual-server|@actual-app/cli'`, excluding generated output and dependency directories. `@actual-app/api` browser use, Cloudflare D1, and Better Auth are current production dependencies and are intentionally retained.
