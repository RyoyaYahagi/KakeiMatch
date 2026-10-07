import { beforeEach, describe, expect, it, vi } from 'vitest';
import appWorker from '../../../apps/pwa/src/worker';

const state = vi.hoisted(() => ({ status: 401 }));
vi.mock('./admin', () => ({ requireAdmin: async () => state.status === 200 ? { userId: 'synthetic-admin' } : { response: Response.json({ error: 'denied' }, { status: state.status }) } }));
vi.mock('./worker', () => ({ handleRequest: vi.fn(), handleAdminGatewayRequest: async () => Response.json({ overview: 'safe metadata' }) }));
vi.mock('./account-auth', () => ({ handleAuthRequest: vi.fn(), handleAccountRequest: vi.fn() }));

describe('admin document routing', () => {
  beforeEach(() => { state.status = 401; });
  it.each([401, 403])('refuses every admin HTML path with status %s before fetching assets', async status => {
    state.status = status;
    const assets = vi.fn(async () => new Response('<html>admin</html>'));
    for (const path of ['/admin', '/admin/', '/admin/feedback', '/admin.html']) {
      const response = await appWorker.fetch(new Request(`https://app.example.test${path}`), { ASSETS: { fetch: assets } } as never);
      expect(response.status).toBe(status); expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(assets).not.toHaveBeenCalled();
  });
  it('serves the separate admin document only after server authorization and disables caching', async () => {
    state.status = 200;
    const assets = vi.fn(async () => new Response('<html>admin</html>', { headers: { 'content-type': 'text/html' } }));
    const response = await appWorker.fetch(new Request('https://app.example.test/admin/feedback'), { ASSETS: { fetch: assets } } as never);
    expect(assets.mock.calls[0]).toBeDefined();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await response.text()).toContain('admin');
  });
});
