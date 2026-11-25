import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { browserBundleSecrets } from "./tooling/browser-bundle-secrets";

export default defineConfig({
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: fileURLToPath(new URL("./admin.html", import.meta.url)),
        },
      },
    },
  },
  plugins: [
    cloudflare({ experimental: { newConfig: { cfBuildOutput: true } } }),
    browserBundleSecrets,
  ],
});
