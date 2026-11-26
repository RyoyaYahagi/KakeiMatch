import type { AccountEnv } from './account-db';
import { handleRequest as handleAiRequest } from './worker';
import { requireAdmin, type AdminEnv } from './admin';
import { handleAdminGatewayRequest } from './worker';
import { purgeExpiredFeedback } from './feedback';
import { PWA_CONTENT_SECURITY_POLICY } from './security-policy';
import { appleAppSiteAssociation, handleNativeRequest, purgeNativeCredentials, type NativeEnv } from './native-auth';

type AppEnv = AccountEnv & Parameters<typeof handleAiRequest>[1] & AdminEnv & NativeEnv & {
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

const RETIRED_PWA_NOTICE_HTML = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="#FAF6F1" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#17120E" media="(prefers-color-scheme: dark)" />
    <title>KakeiMatch の Web 版は終了しました</title>
    <style>
      :root {
        --bg: #FAF6F1;
        --surface: #FFFFFF;
        --text: #2E2219;
        --border: #ECE2D7;
        --primary: #A94C16;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #17120E;
          --surface: #221B15;
          --text: #F2E9E0;
          --border: #382D24;
          --primary: #FFA56B;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100svh;
        display: grid;
        place-items: center;
        padding:
          calc(24px + env(safe-area-inset-top))
          calc(16px + env(safe-area-inset-right))
          calc(24px + env(safe-area-inset-bottom))
          calc(16px + env(safe-area-inset-left));
        background: var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", system-ui, sans-serif;
        font-size: 16px;
        line-height: 1.6;
      }
      main {
        width: 100%;
        max-width: 440px;
        padding: 24px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 18px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 20px;
        line-height: 1.4;
      }
      p {
        margin: 0;
      }
      p + p {
        margin-top: 12px;
      }
      a {
        color: var(--primary);
        overflow-wrap: anywhere;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>KakeiMatch の Web 版は終了しました</h1>
      <p>これからはアプリ版をご利用ください。</p>
      <p>お困りの場合は <a href="mailto:yappapp.support@gmail.com">yappapp.support@gmail.com</a> までご連絡ください。</p>
    </main>
  </body>
</html>
`;

// Paths the admin page needs: the document, the theme script and the built bundles. Served only after requireAdmin passes.
function isAdminDocumentPath(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/') || path === '/admin.html';
}

function isAdminStaticPath(path: string): boolean {
  return path === '/theme.js' || path.startsWith('/assets/');
}

function isRetiredPwaDocumentPath(path: string): boolean {
  return path === '/' || path === '/index.html';
}

function hasNonZeroQ(params: string[]): boolean {
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    if (param.slice(0, eq).trim().toLowerCase() !== 'q') continue;
    const rawValue = param.slice(eq + 1).trim();
    if (rawValue.length === 0) continue;
    const q = Number(rawValue);
    if (Number.isFinite(q) && q <= 0) return false;
  }
  return true;
}

function acceptsHtml(request: Request): boolean {
  const accept = request.headers.get('accept');
  if (!accept) return false;
  return accept.split(',').some(part => {
    const [mediaType = '', ...params] = part.split(';');
    if (mediaType.trim().toLowerCase() !== 'text/html') return false;
    return hasNonZeroQ(params);
  });
}

function retiredPwaNoticeResponse(): Response {
  return new Response(RETIRED_PWA_NOTICE_HTML, {
    status: 410,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      vary: 'Accept',
    },
  });
}

// Retired PWA screens and APIs. They answer 410 so clients see they are gone.
function isRetiredPath(path: string): boolean {
  return isRetiredPwaDocumentPath(path) ||
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
    if (request.method === 'GET' && isRetiredPwaDocumentPath(path) && acceptsHtml(request)) {
      return secureApiResponse(retiredPwaNoticeResponse());
    }
    if (isRetiredPath(path)) return secureApiResponse(jsonError(410, 'gone'));
    return secureApiResponse(jsonError(404, 'not_found'));
  },
};

export default appWorker;
