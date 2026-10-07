import { bindings, defineConfig } from 'cf/config';
import process from 'node:process';

// Ordinary builds and previews never select the canonical production Worker.
export default defineConfig(({ mode, isPreview }) => {
  const production = mode === 'production-deploy' && !isPreview;
  const databaseId = production ? process.env.ACCOUNT_D1_ID : '25111b8d-a7ec-4765-b53e-5b5d0ad6fd39';
  const databaseName = production ? process.env.ACCOUNT_D1_NAME : 'kakeimatch-issue-35-preview';
  if (!databaseId || !databaseName) {
    throw new Error('Production requires explicit ACCOUNT_D1_ID and ACCOUNT_D1_NAME for the account-only D1 database.');
  }
  // The Turnstile site key is public. Previews use Cloudflare's always-pass testing key with synthetic data only.
  const turnstileSiteKey = production ? process.env.TURNSTILE_SITE_KEY : '1x00000000000000000000AA';
  if (!turnstileSiteKey) {
    throw new Error('Production requires TURNSTILE_SITE_KEY so guest AI use has bot protection.');
  }
  return {
    worker: {
      name: production ? 'kakeimatch' : 'kakeimatch-issue-39-preview',
      compatibilityDate: '2026-09-29',
      compatibilityFlags: ['nodejs_compat'],
      entrypoint: './src/worker.ts',
      triggers: [{ type: 'scheduled', schedule: '0 18 * * *' }],
      assets: { runWorkerFirst: ['/api/*', '/admin', '/admin/*', '/admin.html'] },
      env: {
        ASSETS: bindings.assets(),
        ACCOUNT_DB: bindings.d1({ name: databaseName, id: databaseId }),
        BETTER_AUTH_SECRET: bindings.secret(),
        ACCOUNT_BOOTSTRAP_SECRET: bindings.secret(),
        CLOUD_ACCOUNT_ORIGIN: production ? bindings.text('https://kakeimatch.yhgry.workers.dev') : bindings.secret(),
        AI_GATEWAY_AUTH_SECRET: bindings.secret(),
        AI_EMERGENCY_STOP: bindings.secret(),
        AI_GUARDRAILS_JSON: bindings.secret(),
        AI_FREE_MONTHLY_LIMIT: bindings.text('30'),
        AI_GUEST_DAILY_LIMIT: bindings.text('5'),
        GEMINI_API_KEY: bindings.secret(),
        GITHUB_ISSUES_TOKEN: bindings.secret(),
        GITHUB_ISSUES_REPOSITORY: bindings.text('RyoyaYahagi/KakeiMatch'),
        ADMIN_USER_IDS: bindings.secret(),
        CF_ACCESS_TEAM_DOMAIN: bindings.secret(),
        CF_ACCESS_AUD: bindings.secret(),
        FEEDBACK_ENCRYPTION_KEY: bindings.secret(),
        TYPESAFE_API_KEY: bindings.secret(),
        AI_USER_RATE_LIMIT: bindings.rateLimit({ namespace: production ? '600039' : '600035', simple: { limit: 20, period: 60 } }),
        // Contact AI is not counted against a plan, so it gets its own tighter limit per identity and per address.
        CONTACT_RATE_LIMIT: bindings.rateLimit({ namespace: production ? '600146' : '600147', simple: { limit: 5, period: 60 } }),
        TURNSTILE_SITE_KEY: bindings.text(turnstileSiteKey),
        TURNSTILE_SECRET_KEY: bindings.secret(),
        GEMINI_MODEL: bindings.text('gemini-3.5-flash-lite'),
        JEV_MODEL: bindings.text('jev-latest'),
        TYPESAFE_API_URL: bindings.text('https://api.typesafe.ai/v1/systemone'),
      },
    },
  };
});
