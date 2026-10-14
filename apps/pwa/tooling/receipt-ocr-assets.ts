import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import type { Plugin } from 'vite';

/** Self-host code and language models: receipt processing must never use a third-party CDN. */
export function receiptOcrAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const core = dirname(require.resolve('tesseract.js-core', { paths: [dirname(require.resolve('tesseract.js'))] }));
  const files = new Map<string, string>([
    ['worker.min.js', require.resolve('tesseract.js/dist/worker.min.js')],
    ...(['jpn', 'eng'] as const).map(language => [`${language}.traineddata.gz`,
      join(dirname(require.resolve(`@tesseract.js-data/${language}`)), '4.0.0_best_int', `${language}.traineddata.gz`)] as [string, string]),
    ...readdirSync(core).filter(name => /-lstm\.wasm(?:\.js)?$/.test(name)).map(name => [name, join(core, name)] as [string, string]),
  ]);
  return {
    name: 'receipt-ocr-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = (request.url ?? '').split('?')[0].replace(/^\/receipt-ocr\//, '');
        const path = files.get(name);
        if (!request.url?.startsWith('/receipt-ocr/') || !path) return next();
        response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        response.end(readFileSync(path));
      });
    },
    generateBundle() {
      if (this.environment.name !== 'client') return;
      for (const [name, path] of files) this.emitFile({ type: 'asset', fileName: `receipt-ocr/${name}`, source: readFileSync(path) });
    },
  };
}
