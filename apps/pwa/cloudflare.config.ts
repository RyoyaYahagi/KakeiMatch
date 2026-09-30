import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'kakeimatch-issue-35-preview',
    compatibilityDate: '2026-09-29',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint: './src/worker.ts',
    assets: { runWorkerFirst: ['/api/*'] },
    env: {
      ACCOUNT_DB: bindings.d1({ name: 'kakeimatch-issue-35-preview', id: '25111b8d-a7ec-4765-b53e-5b5d0ad6fd39' }),
      BETTER_AUTH_SECRET: bindings.secret(),
      ACCOUNT_BOOTSTRAP_SECRET: bindings.secret(),
      CLOUD_ACCOUNT_ORIGIN: bindings.secret(),
      AI_GATEWAY_AUTH_SECRET: bindings.secret(),
      AI_FREE_MONTHLY_LIMIT: bindings.text('30'),
      GEMINI_API_KEY: bindings.secret(),
      TYPESAFE_API_KEY: bindings.secret(),
      AI_USER_RATE_LIMIT: bindings.rateLimit({ namespace: '600035', simple: { limit: 20, period: 60 } }),
      GEMINI_MODEL: bindings.text('gemini-3.5-flash-lite'),
      JEV_MODEL: bindings.text('jev-latest'),
      TYPESAFE_API_URL: bindings.text('https://api.typesafe.ai/v1/systemone'),
    },
  },
});
