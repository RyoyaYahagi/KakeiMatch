import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { PWA_CONTENT_SECURITY_POLICY } from '../../workers/ai-gateway/src/security-policy';
import { browserBundleSecrets } from './tooling/browser-bundle-secrets';
import { appBuildDefine, offlineAssets } from './tooling/offline-assets';
import { runtimeBoundary } from './tooling/runtime-boundary';

export default defineConfig({
  define: appBuildDefine,
  server: { host: '127.0.0.1', headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Content-Security-Policy': PWA_CONTENT_SECURITY_POLICY } },
  // Built assets are served from the app's own origin, as on Cloudflare.
  // Vite's default CORS adds Vary: Origin, unlike the deployed asset response.
  preview: { cors: false, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Content-Security-Policy': PWA_CONTENT_SECURITY_POLICY } },
  plugins: [runtimeBoundary, browserBundleSecrets, offlineAssets],
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
});
