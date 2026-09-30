import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

// PWA and Worker may reuse only the browser-safe root modules inventoried in #39.
// Check the bundler's actual module graph, including transitive dependencies.
const sharedRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const productionSharedModules = new Set([
  'lib/actual-browser-ledger.ts', 'lib/actual-ledger.ts', 'lib/local-data.ts',
  'lib/local-backup-format.ts', 'lib/category.ts', 'lib/receipt-extraction.ts',
  'lib/receipt-validation.ts', 'lib/reconciliation-engine.ts', 'lib/statement-parser-core.ts',
]);
const runtimeBoundary: Plugin = {
  name: 'local-first-runtime-boundary',
  generateBundle() {
    for (const id of this.getModuleIds()) {
      const path = id.split('?')[0];
      if (path.startsWith(sharedRoot) && !productionSharedModules.has(path.slice(sharedRoot.length))) {
        this.error(`Legacy or unaudited root module reached the production bundle: ${path}`);
      }
      if (/node_modules\/(?:\.pnpm\/(?:@actual-app\+cli|better-sqlite3|next)@|(?:@actual-app\/cli|better-sqlite3|next)\/)/.test(path)) {
        this.error(`Legacy runtime dependency reached the production bundle: ${path}`);
      }
    }
  },
};

export default defineConfig({
  server: { host: '127.0.0.1', headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  plugins: [cloudflare({ experimental: { newConfig: { cfBuildOutput: true } } }), runtimeBoundary, {
    name: 'offline-assets',
    generateBundle(_options, bundle) {
      if (this.environment.name !== 'client') return;
      const assets = Object.keys(bundle).filter(name => /\.(js|css|wasm)$/.test(name)).map(name => `/${name}`);
      this.emitFile({ type: 'asset', fileName: 'offline-assets.json', source: JSON.stringify(assets) });
    },
  }],
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
});
