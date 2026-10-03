import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { PWA_CONTENT_SECURITY_POLICY } from './src/security-policy';

// PWA and Worker may reuse only the browser-safe root modules inventoried in #39.
// Check the bundler's actual module graph, including transitive dependencies.
const sharedRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const productionSharedModules = new Set([
  'lib/actual-browser-ledger.ts', 'lib/actual-ledger.ts', 'lib/local-data.ts',
  'lib/local-backup-format.ts', 'lib/category.ts', 'lib/receipt-extraction.ts',
  'lib/receipt-validation.ts', 'lib/reconciliation-engine.ts', 'lib/statement-parser-core.ts',
  'lib/recurring-schedule.ts',
  'lib/category-learning.ts',
  'lib/monthly-budget-settings.ts',
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

const browserBundleSecrets: Plugin = {
  name: 'browser-bundle-secret-material-boundary',
  generateBundle(_options, bundle) {
    if (this.environment.name !== 'client') return;
    const secretBindingNames = [
      'BETTER_AUTH_SECRET', 'ACCOUNT_BOOTSTRAP_SECRET', 'AI_GATEWAY_AUTH_SECRET',
      'GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'GITHUB_ISSUES_TOKEN', 'AI_EMERGENCY_STOP',
    ];
    const buildSecrets = secretBindingNames.flatMap(name => {
      const value = process.env[name];
      return value ? [{ name, value }] : [];
    });
    for (const [fileName, item] of Object.entries(bundle)) {
      if (item.type !== 'chunk') continue;
      const match = buildSecrets.find(secret => item.code.includes(secret.value));
      if (match) this.error(`Build secret ${match.name} reached browser chunk ${fileName}`);
      if (/AIza[0-9A-Za-z_-]{30,}/.test(item.code)) this.error(`A Google API key-shaped value reached browser chunk ${fileName}`);
    }
  },
};

export default defineConfig({
  define: { __APP_BUILD_ID__: JSON.stringify(execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' }).trim()) },
  server: { host: '127.0.0.1', headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Content-Security-Policy': PWA_CONTENT_SECURITY_POLICY } },
  // Built assets are served from the app's own origin, as on Cloudflare.
  // Vite's default CORS adds Vary: Origin, unlike the deployed asset response.
  preview: { cors: false, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Content-Security-Policy': PWA_CONTENT_SECURITY_POLICY } },
  plugins: [cloudflare({ experimental: { newConfig: { cfBuildOutput: true } } }), runtimeBoundary, browserBundleSecrets, {
    name: 'offline-assets',
    generateBundle(_options, bundle) {
      if (this.environment.name !== 'client') return;
      const assets = Object.keys(bundle).filter(name => /\.(js|css|wasm)$/.test(name)).map(name => `/${name}`);
      this.emitFile({ type: 'asset', fileName: 'offline-assets.json', source: JSON.stringify(assets) });
      const template = readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8');
      const build = createHash('sha256').update(JSON.stringify(assets)).update(template).digest('hex').slice(0, 20);
      this.emitFile({ type: 'asset', fileName: `offline-assets-${build}.json`, source: JSON.stringify({ build, assets }) });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: template.replaceAll('__KM_BUILD__', build) });
    },
  }],
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
});
