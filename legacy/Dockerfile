FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/pwa/package.json ./apps/pwa/package.json
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps/pwa/node_modules ./apps/pwa/node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN mkdir -p data && pnpm legacy:db:migrate && pnpm legacy:build

# This optional legacy example needs tools now classified as development-only.
# Do not prune them: its CLI subprocess and SQLite adapter still use them.
FROM dependencies AS runtime-dependencies

# Run the account bootstrap command against the same persistent database volume.
FROM dependencies AS maintenance
COPY . .
CMD ["pnpm", "legacy:user:create"]

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_PATH=/app/data/kakeimatch.db
ENV RECEIPT_STORAGE_DIR=/app/receipts
ENV HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs \
  && mkdir -p /app/data /app/receipts && chown nextjs:nodejs /app/data /app/receipts
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=runtime-dependencies --chown=nextjs:nodejs /app/node_modules ./node_modules
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
