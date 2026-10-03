import { handleAccountRequest, handleAuthRequest } from '../../../workers/ai-gateway/src/account-auth';
import { handleRequest as handleAiRequest } from '../../../workers/ai-gateway/src/worker';
import { PWA_CONTENT_SECURITY_POLICY } from './security-policy';

type AppEnv = Parameters<typeof handleAuthRequest>[1] & Parameters<typeof handleAiRequest>[1];

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
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
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
