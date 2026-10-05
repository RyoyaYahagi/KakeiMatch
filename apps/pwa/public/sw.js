/* Generated builds replace __KM_BUILD__ with their asset/source fingerprint. */
const BUILD = '__KM_BUILD__';
const CACHE_NAME = `kakeimatch-shell-${BUILD}`;
const MANIFEST_PATH = `/offline-assets-${BUILD}.json`;
const SHELL = ['/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const bundled = await fetch(MANIFEST_PATH, { cache: 'reload' });
      if (!bundled.ok) throw new Error('Offline asset list download failed');
      const manifest = await bundled.json();
      if (manifest.build !== BUILD || !Array.isArray(manifest.assets) || !manifest.assets.length ||
          manifest.assets.some(asset => typeof asset !== 'string' || !/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|wasm)$/.test(asset))) {
        throw new Error('Invalid offline asset list');
      }
      const response = await fetch('/', { cache: 'reload' });
      if (!response.ok) throw new Error('App shell download failed');
      const html = await response.clone().text();
      const assets = [...html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)].map(match => match[1]);
      const scripts = assets.filter(asset => asset.startsWith('/assets/'));
      if (!scripts.length || scripts.some(asset => !manifest.assets.includes(asset))) throw new Error('App build changed during download');
      await cache.addAll([...new Set([...SHELL, ...assets, ...manifest.assets])]);
      // Publish the entry point only after every asset succeeded. Failure leaves the old worker intact.
      await cache.put('/', response);
      // No skipWaiting: open screens retain their worker/bundle until all controlled screens close.
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Natural activation occurs after all screens controlled by the previous worker close.
    for (const name of await caches.keys()) {
      if (name.startsWith('kakeimatch-shell-') && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/auth/callback') return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await (await caches.open(CACHE_NAME)).match('/');
      if (!cached) return new Response('Offline app is unavailable. Close all app screens and reopen online.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return cached;
    })());
    return;
  }
  // Look only in this generation. A global caches.match() could serve a different build's files.
  event.respondWith((async () => {
    const cached = await (await caches.open(CACHE_NAME)).match(request);
    if (cached) return cached;
    // Never fill an older app shell with assets from a newer deployment.
    if (url.pathname.startsWith('/assets/')) return new Response('App asset is not available in this version.', { status: 503 });
    return fetch(request);
  })());
});
