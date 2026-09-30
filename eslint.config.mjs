import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });
const eslintConfig = [
  { ignores: [".worktrees/**", ".next/**", "node_modules/**", "next-env.d.ts", "spikes/actual-browser/dist/**", "spikes/actual-browser/.cloudflare/**", "apps/pwa/.cloudflare/**", "apps/pwa/dist/**", "workers/ai-gateway/.cloudflare/**", "workers/ai-gateway/dist/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];
export default eslintConfig;
