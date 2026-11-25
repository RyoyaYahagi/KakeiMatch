import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { browserBundleSecrets } from "../../apps/pwa/tooling/browser-bundle-secrets";
import { appBuildDefine, offlineAssets } from "../../apps/pwa/tooling/offline-assets";
import { runtimeBoundary } from "../../apps/pwa/tooling/runtime-boundary";

const pwaDocument = fileURLToPath(new URL("./index.html", import.meta.url));

export default defineConfig({
  publicDir: fileURLToPath(new URL("../../apps/pwa/public", import.meta.url)),
  define: appBuildDefine,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
      "/src/main.ts": fileURLToPath(new URL("../../apps/pwa/src/main.ts", import.meta.url)),
    },
  },
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            app: pwaDocument,
            admin: fileURLToPath(new URL("./admin.html", import.meta.url)),
          },
        },
      },
    },
  },
  plugins: [
    cloudflare({ experimental: { newConfig: { cfBuildOutput: true } } }),
    {
      name: "pwa-document-path",
      enforce: "pre",
      resolveId(id) {
        // Keep the linked document inside this build's root for HTML emission.
        if (id === pwaDocument) return pwaDocument;
      },
    },
    runtimeBoundary,
    browserBundleSecrets,
    offlineAssets,
  ],
});
