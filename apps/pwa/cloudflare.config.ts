import { bindings, defineConfig, triggers } from 'cf/config';
import process from 'node:process';

// Ordinary builds and previews never select the canonical production Worker.
export default defineConfig(({ mode, isPreview }) => {
  const production = mode === 'production-deploy' && !isPreview;
  const databaseId = production ? process.env.ACCOUNT_D1_ID : '25111b8d-a7ec-4765-b53e-5b5d0ad6fd39';
  const databaseName = production ? process.env.ACCOUNT_D1_NAME : 'kakeimatch-issue-35-preview';
  if (!databaseId || !databaseName) {
    throw new Error('Production requires explicit ACCOUNT_D1_ID and ACCOUNT_D1_NAME for the account-only D1 database.');
  }
  // Device sync (Issue #143) stays unavailable (`/api/sync/*` answers 503) unless
  // an existing private R2 bucket is named here. No bucket is created by this config.
  const syncBucketName = process.env.SYNC_R2_BUCKET_NAME?.trim();
  // Public OAuth client ID. Google Drive is offered for sync only when it is set.
  const googleOAuthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  return {
    worker: {
      name: production ? 'kakeimatch' : 'kakeimatch-issue-39-preview',
      compatibilityDate: '2026-09-29',
      compatibilityFlags: ['nodejs_compat'],
      entrypoint: './src/worker.ts',
      assets: { runWorkerFirst: ['/api/*'] },
      // Daily device sync cleanup at 03:17 JST: expired uploads, old history, and objects of
      // deleted households and accounts. Only added when sync storage is configured.
      ...(syncBucketName ? { triggers: [triggers.scheduled({ schedule: '17 18 * * *' })] } : {}),
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
        GEMINI_MODEL: bindings.text('gemini-3.5-flash-lite'),
        JEV_MODEL: bindings.text('jev-latest'),
        TYPESAFE_API_URL: bindings.text('https://api.typesafe.ai/v1/systemone'),
        ...(syncBucketName ? { SYNC_BUCKET: bindings.r2({ name: syncBucketName }) } : {}),
        ...(googleOAuthClientId ? { GOOGLE_OAUTH_CLIENT_ID: bindings.text(googleOAuthClientId) } : {}),
      },
    },
  };
});
