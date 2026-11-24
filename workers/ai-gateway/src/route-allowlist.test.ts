import { beforeEach, describe, expect, it, vi } from 'vitest';
import appWorker from '../../../apps/pwa/src/worker';

const state = vi.hoisted(() => ({ status: 403 }));
const handlers = vi.hoisted(() => ({
  aiRequest: vi.fn(async () => Response.json({ source: 'ai' })),
  adminGateway: vi.fn(async () => Response.json({ source: 'admin-gateway' })),
  authRequest: vi.fn(async () => Response.json({ source: 'auth' })),
  accountRequest: vi.fn(async () => Response.json({ source: 'account' })),
  nativeRequest: vi.fn(async () => Response.json({ source: 'native' })),
  appleAppSiteAssociation: vi.fn(() => Response.json({ webcredentials: { apps: [] } })),
}));
vi.mock('./admin', () => ({
  requireAdmin: async () => state.status === 200
    ? { adminSubject: 'access:synthetic-sub', principalId: 'admin-operator' }
    : { response: Response.json({ error: 'denied' }, { status: state.status }) },
}));
vi.mock('./worker', () => ({ handleRequest: handlers.aiRequest, handleAdminGatewayRequest: handlers.adminGateway }));
vi.mock('./account-auth', () => ({ handleAuthRequest: handlers.authRequest, handleAccountRequest: handlers.accountRequest }));
vi.mock('./native-auth', () => ({
  handleNativeRequest: handlers.nativeRequest,
  appleAppSiteAssociation: handlers.appleAppSiteAssociation,
  purgeNativeCredentials: vi.fn(),
}));

function run(path: string, assets: (request: Request) => Promise<Response> = async () => new Response('asset')) {
  return appWorker.fetch(new Request(`https://app.example.test${path}`), { ASSETS: { fetch: assets } } as never);
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
    const assets = vi.fn(async (_request: Request) => new Response('asset'));
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
  ])('answers %s with 410 without calling any retired handler', async path => {
    state.status = 200;
    const assets = vi.fn(async () => new Response('asset'));
    const response = await run(path, assets);
    expect(response.status).toBe(410);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'gone' });
    expect(handlers.aiRequest).not.toHaveBeenCalled();
    expect(handlers.authRequest).not.toHaveBeenCalled();
    expect(handlers.accountRequest).not.toHaveBeenCalled();
    expect(assets).not.toHaveBeenCalled();
  });

  it.each([
    '/api/unknown',
    '/api/receipts/receipt-a/analyze',
    '/sw.js',
    '/manifest.webmanifest',
    '/icon.svg',
    '/administrator',
  ])('answers unlisted %s with 404', async path => {
    state.status = 200;
    const assets = vi.fn(async () => new Response('asset'));
    const response = await run(path, assets);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(assets).not.toHaveBeenCalled();
  });
});
