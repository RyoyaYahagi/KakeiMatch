import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [cloudflare(), {
    name: 'offline-assets',
    generateBundle(_options, bundle) {
      if (this.environment.name !== 'client') return;
      const assets = Object.keys(bundle).filter(name => /\.(js|css|wasm)$/.test(name)).map(name => `/${name}`);
      this.emitFile({ type: 'asset', fileName: 'offline-assets.json', source: JSON.stringify(assets) });
    },
  }],
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
});
