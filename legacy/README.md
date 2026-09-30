# Legacy Next.js runtime

The files in this directory preserve the pre-local-first deployment for development and reference. The active application is the PWA in `apps/pwa`, served with its Cloudflare Worker routes.

## Run the legacy app locally

From the repository root, install the workspace dependencies and start the old Next.js server with the `legacy:*` commands:

```sh
corepack pnpm install
cp legacy/.env.example .env.local
# Set APP_URL to http://localhost:3000 in .env.local for the default Next.js dev port.
corepack pnpm legacy:dev
```

The legacy server uses the SQLite database and file storage configured in `.env.local`. Keep real secrets and household data out of Git.

## Run the legacy Docker Compose deployment

Copy the environment template to a private file, set the required legacy values, then run Compose from the repository root:

```sh
cp legacy/.env.example legacy/.env
# Set AUTH_SECRET and ACTUAL_SERVER_PASSWORD in legacy/.env.
docker compose --env-file legacy/.env -f legacy/compose.yaml up --build -d
docker compose --env-file legacy/.env -f legacy/compose.yaml run --rm bootstrap
```

Compose builds with the repository root as its context and `legacy/Dockerfile` as the Dockerfile. This is needed because the image copies root source and workspace files. The app and Actual UI ports bind to localhost by default.

To stop the legacy services, run:

```sh
docker compose --env-file legacy/.env -f legacy/compose.yaml down
```

The named volumes remain after `down`. Deleting them with `down --volumes` permanently removes the legacy database, receipts, statements, and Actual data.

## Legacy root commands

The root package remains a pnpm workspace member because the PWA imports shared browser-safe modules from root `src/lib`. Root `dev`, `build`, and `start` commands target the PWA. Commands that explicitly start or operate the old Next.js runtime use the `legacy:*` prefix, including `legacy:dev`, `legacy:build`, `legacy:start`, `legacy:db:migrate`, `legacy:user:create`, `legacy:actual:link-user`, and `legacy:actual:map-categories`.

`legacy:test:live` is the opt-in Actual Server integration test. It requires a dedicated test server and two synthetic test Budgets. The default root test command excludes that live test. Other legacy regression tests use disposable fixtures; they do not connect to the runtime household database.
