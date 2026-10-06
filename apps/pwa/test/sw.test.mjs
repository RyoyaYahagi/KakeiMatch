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
assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
assert.match(csp, /connect-src 'self' https:\/\/challenges\.cloudflare\.com/);

function worker(build = 'old', stores = new Map()) {
  const handlers = new Map();
  let online = true;
  let deployed = build;
  let failAssets = false;
  let malformed = false;
  let skipCount = 0;
  let networkCalls = 0;
  const key = request => typeof request === 'string' ? request : new URL(request.url).pathname;
  const caches = {
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        put: async (request, value) => entries.set(key(request), value),
        match: async request => entries.get(key(request))?.clone(),
        addAll: async urls => {
          if (failAssets) throw new Error('download failed');
          for (const url of urls) entries.set(url, new Response(`${deployed}:${url}`));
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
  };
  const self = { location: { origin: 'https://example.test' }, addEventListener: (name, handler) => handlers.set(name, handler), skipWaiting: async () => { skipCount++; }, clients: { claim: async () => {} } };
  const fetch = async request => {
    networkCalls++;
    if (!online) throw new Error('offline');
    if (request === `/offline-assets-${build}.json`) return new Response(JSON.stringify({ build, assets: malformed ? ['https://external.test/unsafe.js'] : [`/assets/${build}.js`, `/assets/${build}-browser.js`] }));
    if (request === '/') return new Response(`<script src="/assets/${deployed}.js"></script>`, { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Content-Security-Policy': csp } });
    return new Response('online');
  };
  runInNewContext(source.replaceAll('__KM_BUILD__', build), { self, caches, fetch, Response, URL, Error, Set });
  async function lifecycle(name) { let pending; handlers.get(name)({ waitUntil: promise => { pending = promise; } }); await pending; }
  function request(path, mode = 'cors', method = 'GET') {
    let promise;
    handlers.get('fetch')({ request: { method, url: `https://example.test${path}`, mode }, respondWith: value => { promise = value; } });
    return promise;
  }
  return { stores, request, lifecycle, setOnline: value => { online = value; }, deploy: value => { deployed = value; }, failAssets: () => { failAssets = true; }, malformed: () => { malformed = true; }, skipCount: () => skipCount, networkCalls: () => networkCalls };
}

test('complete shell installs without forcing activation; offline preserves isolation headers', async () => {
  const context = worker(); await context.lifecycle('install');
  const entries = context.stores.get('kakeimatch-shell-old');
  assert.ok(entries.has('/assets/old.js')); assert.ok(entries.has('/assets/old-browser.js')); assert.ok(entries.has('/manifest.webmanifest'));
  assert.equal(context.skipCount(), 0);
  context.setOnline(false);
  const response = await context.request('/', 'navigate');
  assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin'); assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal(response.headers.get('Content-Security-Policy'), csp);
});

test('online navigation stays on the active shell when a newer deployment appears', async () => {
  const context = worker(); await context.lifecycle('install'); context.deploy('new');
  const before = context.networkCalls();
  assert.match(await (await context.request('/', 'navigate')).text(), /old\.js/);
  assert.equal(context.networkCalls(), before);
});

test('waiting build retains old cache and never globally matches a different generation', async () => {
  const old = worker(); await old.lifecycle('install');
  const fresh = worker('new', old.stores); await fresh.lifecycle('install');
  assert.equal(old.stores.size, 2);
  assert.match(await (await old.request('/', 'navigate')).text(), /old\.js/);
  assert.match(await (await fresh.request('/', 'navigate')).text(), /new\.js/);
  assert.equal((await old.request('/assets/new.js')).status, 503);
  await fresh.lifecycle('activate');
  assert.equal(old.stores.has('kakeimatch-shell-old'), false); assert.equal(old.stores.has('kakeimatch-shell-new'), true);
});

test('failed asset download discards only incomplete installation and retains active shell', async () => {
  const old = worker(); await old.lifecycle('install');
  const fresh = worker('new', old.stores); fresh.failAssets();
  await assert.rejects(fresh.lifecycle('install'), /download failed/);
  assert.equal(old.stores.has('kakeimatch-shell-new'), false);
  assert.match(await (await old.request('/', 'navigate')).text(), /old\.js/);
});

test('deployment changes during installation and unsafe asset manifests are rejected', async () => {
  const mismatch = worker(); mismatch.deploy('new');
  await assert.rejects(mismatch.lifecycle('install'), /build changed/);
  assert.equal(mismatch.stores.size, 0);
  const invalid = worker(); invalid.malformed();
  await assert.rejects(invalid.lifecycle('install'), /Invalid offline/);
  assert.equal(invalid.stores.size, 0);
});

test('all API requests including GET auth/session bypass the service worker', () => {
  const context = worker();
  for (const path of ['/api/auth/get-session', '/api/account/usage', '/api/ai/gemini', '/api/contact', '/api/contact/transcribe', '/api/contact/interview']) {
    for (const method of ['GET', 'POST']) assert.equal(context.request(path, 'cors', method), undefined);
  }
});
