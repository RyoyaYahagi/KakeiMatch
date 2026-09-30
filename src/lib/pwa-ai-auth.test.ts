import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('PWA AI session token', () => {
  it('silently caches and refreshes tokens from an existing session without a Passkey operation', async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T00:00:00Z'));
    const fetchImpl = vi.fn(async () => Response.json({ token: 'synthetic-token', expiresAt: Math.floor(Date.now() / 1000) + 600 }));
    vi.stubGlobal('fetch', fetchImpl);
    const { getAiAccessToken, clearAiAccessToken } = await import('../../apps/pwa/src/ai-auth');
    await getAiAccessToken(); await getAiAccessToken(); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('/api/ai/token', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
    vi.advanceTimersByTime(571000); await getAiAccessToken(); expect(fetchImpl).toHaveBeenCalledTimes(2);
    clearAiAccessToken(); await getAiAccessToken(); expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('requires a session only for AI and rejects malformed token responses', async () => {
    vi.resetModules(); const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(Response.json({ token: '', expiresAt: 'invalid' }));
    vi.stubGlobal('fetch', fetchImpl);
    const { getAiAccessToken } = await import('../../apps/pwa/src/ai-auth');
    await expect(getAiAccessToken()).rejects.toThrow('account_session_required');
    await expect(getAiAccessToken()).rejects.toThrow('invalid_ai_token_response');
  });
});
