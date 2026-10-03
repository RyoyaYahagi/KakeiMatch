import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
const csp = headers.match(/Content-Security-Policy:\s*(.+)/)?.[1];
assert.ok(csp, 'Static PWA responses must define CSP.');
assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
assert.match(csp, /worker-src 'self' blob: data:/);
const scriptSrc = csp.split(';').find(directive => directive.trim().startsWith('script-src'));
assert.doesNotMatch(scriptSrc, /'unsafe-inline'|'unsafe-eval'/);

function worker() {
  const handlers = new Map();
  const entries = new Map();
  const cache = {
    put: async (key, value) => { entries.set(String(key), value); },
    addAll: async urls => { for (const url of urls) entries.set(url, new Response(url)); },
  };
  let online = true;
  const self = {
    location: { origin: 'https://example.test' },
    addEventListener: (name, handler) => handlers.set(name, handler),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const caches = {
    open: async () => cache,
    match: async key => entries.get(String(key)),
    keys: async () => ['kakeimatch-shell-v1'],
    delete: async () => true,
  };
  const fetch = async request => {
    if (!online) throw new Error('offline');
    if (request === '/offline-assets.json') return new Response(JSON.stringify(['/assets/browser.js']));
    if (request === '/') return new Response('<script src="/assets/app.js"></script>', { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Content-Security-Policy': csp } });
    return new Response('online');
  };
  runInNewContext(source, { self, caches, fetch, Response, URL, Error });
  return { handlers, entries, setOnline: value => { online = value; } };
}

test('install caches the app shell and offline navigation keeps isolation headers', async () => {
  const context = worker();
  let pending;
  context.handlers.get('install')({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.ok(context.entries.has('/assets/app.js'));
  assert.ok(context.entries.has('/assets/browser.js'));
  assert.ok(context.entries.has('/manifest.webmanifest'));
  context.setOnline(false);
  let response;
  context.handlers.get('fetch')({
    request: { method: 'GET', url: 'https://example.test/', mode: 'navigate' },
    respondWith: promise => { response = promise; },
  });
  const cached = await response;
  assert.equal(cached.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(cached.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal(cached.headers.get('Content-Security-Policy'), csp);
});

test('AI and contact API requests are never cached or intercepted', () => {
  const context = worker();
  let intercepted = false;
  for (const path of ['/api/ai/gemini', '/api/contact', '/api/contact/transcribe', '/api/contact/interview']) {
    context.handlers.get('fetch')({
      request: { method: 'POST', url: `https://example.test${path}`, mode: 'cors' },
      respondWith: () => { intercepted = true; },
    });
  }
  assert.equal(intercepted, false);
});
