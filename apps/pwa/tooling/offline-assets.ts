import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const appBuildDefine = { __APP_BUILD_ID__: JSON.stringify(execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' }).trim()) };

export const offlineAssets = {
  name: 'offline-assets',
  generateBundle(this: {
    environment: { name: string };
    emitFile(asset: { type: 'asset'; fileName: string; source: string }): string;
  }, _options: unknown, bundle: Record<string, unknown>) {
    if (this.environment.name !== 'client') return;
    const assets = Object.keys(bundle).filter(name => /\.(js|css|wasm)$/.test(name)).map(name => `/${name}`);
    this.emitFile({ type: 'asset', fileName: 'offline-assets.json', source: JSON.stringify(assets) });
    const template = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
    const build = createHash('sha256').update(JSON.stringify(assets)).update(readFileSync(new URL('../public/theme.js', import.meta.url))).update(template).digest('hex').slice(0, 20);
    this.emitFile({ type: 'asset', fileName: `offline-assets-${build}.json`, source: JSON.stringify({ build, assets }) });
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: template.replaceAll('__KM_BUILD__', build) });
  },
};
