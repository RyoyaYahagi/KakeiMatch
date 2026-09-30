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
        CLOUD_ACCOUNT_ORIGIN: production ? bindings.text('https://kakeimatch.workers.dev') : bindings.secret(),
        AI_GATEWAY_AUTH_SECRET: bindings.secret(),
        AI_FREE_MONTHLY_LIMIT: bindings.text('30'),
        GEMINI_API_KEY: bindings.secret(),
        TYPESAFE_API_KEY: bindings.secret(),
        AI_USER_RATE_LIMIT: bindings.rateLimit({ namespace: production ? '600039' : '600035', simple: { limit: 20, period: 60 } }),
        GEMINI_MODEL: bindings.text('gemini-3.5-flash-lite'),
        JEV_MODEL: bindings.text('jev-latest'),
        TYPESAFE_API_URL: bindings.text('https://api.typesafe.ai/v1/systemone'),
      },
    },
  };
});
