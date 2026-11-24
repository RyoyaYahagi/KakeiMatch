import { handleAuthRequest } from './account-auth';
import { handleRequest as handleAiRequest } from './worker';
import { requireAdmin, type AdminEnv } from './admin';
import { handleAdminGatewayRequest } from './worker';
import { purgeExpiredFeedback } from './feedback';
import { PWA_CONTENT_SECURITY_POLICY } from './security-policy';
import { appleAppSiteAssociation, handleNativeRequest, purgeNativeCredentials, type NativeEnv } from './native-auth';

type AppEnv = Parameters<typeof handleAuthRequest>[1] & Parameters<typeof handleAiRequest>[1] & AdminEnv & NativeEnv & {
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

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Paths the admin page needs: the document, the theme script and the built bundles. Served only after requireAdmin passes.
function isAdminDocumentPath(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/') || path === '/admin.html';
}

function isAdminStaticPath(path: string): boolean {
  return path === '/theme.js' || path.startsWith('/assets/');
}

// Retired PWA screens and APIs. They answer 410 so clients see they are gone, while the code stays for a later cleanup.
function isRetiredPath(path: string): boolean {
  return path === '/' || path === '/index.html' ||
    path.startsWith('/api/auth/') || path.startsWith('/api/account/') || path.startsWith('/api/ai/') ||
    path === '/api/contact' || path.startsWith('/api/contact/');
}

const appWorker = {
  async scheduled(event: { scheduledTime: number }, env: AppEnv): Promise<void> {
    await purgeExpiredFeedback(env.ACCOUNT_DB, Math.floor(event.scheduledTime / 1000));
    await purgeNativeCredentials(env.ACCOUNT_DB, Math.floor(event.scheduledTime / 1000));
  },
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/.well-known/apple-app-site-association') return secureApiResponse(appleAppSiteAssociation(request, env));
    if (path.startsWith('/api/native/')) return secureApiResponse(await handleNativeRequest(request, env));
    if (isAdminDocumentPath(path) || isAdminStaticPath(path)) {
      const auth = await requireAdmin(request, env);
      if ('response' in auth) return secureApiResponse(auth.response);
      if (request.method !== 'GET' && request.method !== 'HEAD') return secureApiResponse(new Response(null, { status: 405 }));
      const assetUrl = new URL(isAdminDocumentPath(path) ? '/admin.html' : path, request.url);
      return secureApiResponse(await env.ASSETS.fetch(new Request(assetUrl, { method: request.method })));
    }
    if (path === '/api/admin' || path.startsWith('/api/admin/')) {
      return secureApiResponse(await handleAdminGatewayRequest(request, env));
    }
    if (isRetiredPath(path)) return secureApiResponse(jsonError(410, 'gone'));
    return secureApiResponse(jsonError(404, 'not_found'));
  },
};

export default appWorker;
