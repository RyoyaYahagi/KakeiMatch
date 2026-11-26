import { beforeEach, describe, expect, it, vi } from 'vitest';
import appWorker from './hosting';

const state = vi.hoisted(() => ({ status: 403 }));
const handlers = vi.hoisted(() => ({
  aiRequest: vi.fn(async () => Response.json({ source: 'ai' })),
  adminGateway: vi.fn(async () => Response.json({ source: 'admin-gateway' })),
  nativeRequest: vi.fn(async () => Response.json({ source: 'native' })),
  appleAppSiteAssociation: vi.fn(() => Response.json({ webcredentials: { apps: [] } })),
}));
vi.mock('./admin', () => ({
  requireAdmin: async () => state.status === 200
    ? { adminSubject: 'access:synthetic-sub', principalId: 'admin-operator' }
    : { response: Response.json({ error: 'denied' }, { status: state.status }) },
}));
vi.mock('./worker', () => ({ handleRequest: handlers.aiRequest, handleAdminGatewayRequest: handlers.adminGateway }));
vi.mock('./native-auth', () => ({
  handleNativeRequest: handlers.nativeRequest,
  appleAppSiteAssociation: handlers.appleAppSiteAssociation,
  purgeNativeCredentials: vi.fn(),
}));

function run(path: string, assets: (request: Request) => Promise<Response> = async () => new Response('asset'), init?: RequestInit) {
  return appWorker.fetch(new Request(`https://app.example.test${path}`, init), { ASSETS: { fetch: assets } } as never);
}

const BROWSER_HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

function expectNoRetiredHandlersOrAssets(assets: { mock: unknown }) {
  expect(handlers.aiRequest).not.toHaveBeenCalled();
  expect(assets).not.toHaveBeenCalled();
}

async function runIsolated(path: string, init?: RequestInit): Promise<Response> {
  state.status = 200;
  const assets = vi.fn(async () => new Response('asset'));
  const response = await run(path, assets, init);
  expectNoRetiredHandlersOrAssets(assets);
  return response;
}

describe('worker route allowlist', () => {
  beforeEach(() => {
    state.status = 403;
    vi.clearAllMocks();
  });

  it('passes the iOS entry points to their handlers', async () => {
    const aasa = await run('/.well-known/apple-app-site-association');
    expect(aasa.status).toBe(200);
    expect(handlers.appleAppSiteAssociation).toHaveBeenCalledTimes(1);

    const native = await run('/api/native/config');
    expect(native.status).toBe(200);
    expect(await native.json()).toEqual({ source: 'native' });
    expect(handlers.nativeRequest).toHaveBeenCalledTimes(1);
  });

  it('passes admin API requests to the admin gateway', async () => {
    const response = await run('/api/admin/overview');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source: 'admin-gateway' });
  });

  it('serves admin documents and admin static files only after the Access check passes', async () => {
    state.status = 200;
    const assets = vi.fn<(request: Request) => Promise<Response>>(async () => new Response('asset'));
    expect((await run('/admin/feedback', assets)).status).toBe(200);
    expect((await run('/theme.js', assets)).status).toBe(200);
    expect((await run('/assets/admin-abc123.js', assets)).status).toBe(200);
    expect(assets.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(['/admin.html', '/theme.js', '/assets/admin-abc123.js']);
  });

  it.each(['/admin/feedback', '/admin.html', '/theme.js', '/assets/admin-abc123.js'])('does not hand %s to ASSETS without a verified Access JWT', async path => {
    state.status = 403;
    const assets = vi.fn(async () => new Response('asset'));
    const response = await run(path, assets);
    expect(response.status).toBe(403);
    expect(assets).not.toHaveBeenCalled();
  });

  it.each([
    '/',
    '/index.html',
    '/api/auth/get-session',
    '/api/account/delete',
    '/api/account/recovery',
    '/api/ai/gemini',
    '/api/ai/jev',
    '/api/contact',
    '/api/contact/interview',
  ])('answers %s with 410 JSON without calling any retired handler', async path => {
    const response = await runIsolated(path);
    expect(response.status).toBe(410);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ error: 'gone' });
  });

  it.each(['/', '/index.html'])('answers GET %s with 410 self-contained HTML when Accept includes text/html', async path => {
    const response = await runIsolated(path, {
      method: 'GET',
      headers: { accept: BROWSER_HTML_ACCEPT },
    });
    expect(response.status).toBe(410);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Accept');
    expect(response.headers.get('content-security-policy')).toContain("style-src 'self' 'unsafe-inline'");

    const body = await response.text();
    expect(body).toContain('KakeiMatch の Web 版は終了しました');
    expect(body).toContain('これからはアプリ版をご利用ください。');
    expect(body).toContain('yappapp.support@gmail.com');
    expect(body).not.toMatch(/<link\b|<script\b|<img\b|\bsrc\s*=|\bhref\s*=\s*["']\s*(?:\/|https?:)|url\s*\(/i);
  });

  it.each([
    { path: '/', accept: 'application/json' },
    { path: '/', accept: '*/*' },
    { path: '/', accept: 'text/html;q=0' },
    { path: '/', accept: undefined },
    { path: '/index.html', accept: 'application/json' },
    { path: '/index.html', accept: '*/*' },
    { path: '/index.html', accept: 'text/html;q=0' },
    { path: '/index.html', accept: undefined },
  ])('answers GET $path with 410 JSON when Accept is $accept', async ({ path, accept }) => {
    const headers = accept === undefined ? undefined : { accept };
    const response = await runIsolated(path, { method: 'GET', headers });
    expect(response.status).toBe(410);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ error: 'gone' });
  });

  it.each(['/', '/index.html'])('answers POST %s with 410 JSON even when Accept includes text/html', async path => {
    const response = await runIsolated(path, {
      method: 'POST',
      headers: { accept: BROWSER_HTML_ACCEPT },
    });
    expect(response.status).toBe(410);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ error: 'gone' });
  });

  it.each([
    '/api/auth/get-session',
    '/api/account/delete',
    '/api/ai/gemini',
    '/api/contact',
  ])('answers retired API %s with 410 JSON even when Accept includes text/html', async path => {
    const response = await runIsolated(path, {
      method: 'GET',
      headers: { accept: BROWSER_HTML_ACCEPT },
    });
    expect(response.status).toBe(410);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ error: 'gone' });
  });

  it.each([
    '/api/unknown',
    '/api/receipts/receipt-a/analyze',
    '/sw.js',
    '/manifest.webmanifest',
    '/icon.svg',
    '/administrator',
  ])('answers unlisted %s with 404', async path => {
    const response = await runIsolated(path);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it.each([
    '/sw.js',
    '/manifest.webmanifest',
    '/icon.svg',
  ])('answers unlisted %s with 404 JSON even when Accept includes text/html', async path => {
    const response = await runIsolated(path, {
      method: 'GET',
      headers: { accept: BROWSER_HTML_ACCEPT },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});
