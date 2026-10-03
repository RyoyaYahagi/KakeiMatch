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
    throw new Error('Production requires TURNSTILE_SITE_KEY so public signup has bot protection.');
  }
  return {
    worker: {
      name: production ? 'kakeimatch' : 'kakeimatch-issue-39-preview',
      compatibilityDate: '2026-09-29',
      compatibilityFlags: ['nodejs_compat'],
      entrypoint: './src/worker.ts',
      assets: { runWorkerFirst: ['/api/*'] },
      env: {
        ACCOUNT_DB: bindings.d1({ name: databaseName, id: databaseId }),
        BETTER_AUTH_SECRET: bindings.secret(),
        ACCOUNT_BOOTSTRAP_SECRET: bindings.secret(),
        CLOUD_ACCOUNT_ORIGIN: production ? bindings.text('https://kakeimatch.yhgry.workers.dev') : bindings.secret(),
        AI_GATEWAY_AUTH_SECRET: bindings.secret(),
        AI_EMERGENCY_STOP: bindings.secret(),
        AI_GUARDRAILS_JSON: bindings.secret(),
        AI_FREE_MONTHLY_LIMIT: bindings.text('30'),
        GEMINI_API_KEY: bindings.secret(),
        GITHUB_ISSUES_TOKEN: bindings.secret(),
        GITHUB_ISSUES_REPOSITORY: bindings.text('RyoyaYahagi/KakeiMatch'),
        TYPESAFE_API_KEY: bindings.secret(),
        AI_USER_RATE_LIMIT: bindings.rateLimit({ namespace: production ? '600039' : '600035', simple: { limit: 20, period: 60 } }),
        ACCOUNT_RATE_LIMIT: bindings.rateLimit({ namespace: production ? '600144' : '600145', simple: { limit: 5, period: 60 } }),
        TURNSTILE_SITE_KEY: bindings.text(turnstileSiteKey),
        TURNSTILE_SECRET_KEY: bindings.secret(),
        GEMINI_MODEL: bindings.text('gemini-3.5-flash-lite'),
        JEV_MODEL: bindings.text('jev-latest'),
        TYPESAFE_API_URL: bindings.text('https://api.typesafe.ai/v1/systemone'),
      },
    },
  };
});
