import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "kakeimatch-pr-36",
    compatibilityDate: "2026-09-29",
    entrypoint: "./src/worker.ts",
    env: {
      AI_GATEWAY_AUTH_SECRET: bindings.secret(),
      GEMINI_API_KEY: bindings.secret(),
      GITHUB_ISSUES_TOKEN: bindings.secret(),
      GITHUB_ISSUES_REPOSITORY: bindings.text('RyoyaYahagi/KakeiMatch'),
      TYPESAFE_API_KEY: bindings.secret(),
      AI_USER_RATE_LIMIT: bindings.rateLimit({ namespace: "360036", simple: { limit: 20, period: 60 } }),
      AI_EMERGENCY_STOP: bindings.secret(),
      AI_GUARDRAILS_JSON: bindings.secret(),
      GEMINI_MODEL: bindings.text("gemini-3.5-flash-lite"),
      JEV_MODEL: bindings.text("jev-latest"),
      TYPESAFE_API_URL: bindings.text("https://api.typesafe.ai/v1/systemone"),
    },
  },
});
