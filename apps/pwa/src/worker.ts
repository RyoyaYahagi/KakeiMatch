import { handleAccountRequest, handleAuthRequest } from '../../../workers/ai-gateway/src/account-auth';
import { handleRequest as handleAiRequest } from '../../../workers/ai-gateway/src/worker';
import { requireAdmin, type AdminEnv } from '../../../workers/ai-gateway/src/admin';
import { handleAdminGatewayRequest } from '../../../workers/ai-gateway/src/worker';
import { purgeExpiredFeedback } from '../../../workers/ai-gateway/src/feedback';
import { PWA_CONTENT_SECURITY_POLICY } from './security-policy';

type AppEnv = Parameters<typeof handleAuthRequest>[1] & Parameters<typeof handleAiRequest>[1] & AdminEnv & {
  ASSETS: { fetch(request: Request): Promise<Response> };
};

function secureApiResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-embedder-policy', 'require-corp');
  headers.set('content-security-policy', PWA_CONTENT_SECURITY_POLICY);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const appWorker = {
  async scheduled(event: { scheduledTime: number }, env: AppEnv): Promise<void> {
    await purgeExpiredFeedback(env.ACCOUNT_DB, Math.floor(event.scheduledTime / 1000));
  },
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/admin' || path.startsWith('/admin/') || path === '/admin.html') {
      const auth = await requireAdmin(request, env);
      if ('response' in auth) return secureApiResponse(auth.response);
      if (request.method !== 'GET' && request.method !== 'HEAD') return secureApiResponse(new Response(null, { status: 405 }));
      const assetUrl = new URL('/admin.html', request.url);
      return secureApiResponse(await env.ASSETS.fetch(new Request(assetUrl, { method: request.method })));
    }
    if (path === '/api/admin' || path.startsWith('/api/admin/')) {
      return secureApiResponse(await handleAdminGatewayRequest(request, env));
    }
    if (path.startsWith('/api/auth/')) {
      return secureApiResponse(await handleAuthRequest(request, env));
    }
    if (path.startsWith('/api/account/')) {
      return secureApiResponse(await handleAccountRequest(request, env));
    }
    if (path.startsWith('/api/ai/') || path === '/api/contact' || path.startsWith('/api/contact/')) {
      return secureApiResponse(await handleAiRequest(request, env));
    }
    return secureApiResponse(new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }));
  },
};

export default appWorker;
