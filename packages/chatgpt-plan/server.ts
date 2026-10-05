import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { ChatGptPlanAuth, ChatGptPlanError } from './auth';
import { ChatGptPlanClient } from './client';
import { RECEIPT_EXTRACTION_PROMPT, receiptExtractionJsonSchema, validateReceiptExtraction } from '../../src/lib/receipt-extraction';
import { validateReceiptImage } from '../../src/lib/receipt-validation';

const imageSchema = z.object({ flowId: z.uuid(), contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']), imageBase64: z.string().min(1).max(8 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
const settingsSchema = z.object({ model: z.string().min(1).max(128).nullable(), enabled: z.boolean() }).strict();
async function json(request: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { size += chunk.length; if (size > 9 * 1024 * 1024) throw new ChatGptPlanError('invalid_response'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ChatGptPlanError('invalid_response'); }
}
function reply(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }

/** One local user, exact loopback Host, no CORS, fixed same-origin mutation header. Never a public multi-tenant server. */
export async function startChatGptPlanServer(options: { auth: ChatGptPlanAuth; client: ChatGptPlanClient; assetsDirectory: string; port?: number }) {
  await options.auth.record();
  const assetsRoot = await realpath(options.assetsDirectory);
  const configuredHeaders = await readFile(resolve(assetsRoot, '_headers'), 'utf8').catch(() => '');
  const csp = configuredHeaders.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1];
  let origin = ''; let busy = false;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (csp) response.setHeader('Content-Security-Policy', csp);
    if (request.headers.host !== origin.slice('http://'.length)) { reply(response, 403, { error: 'forbidden' }); return; }
    const url = new URL(request.url ?? '/', origin);
    if (request.headers.origin && request.headers.origin !== origin) { reply(response, 403, { error: 'forbidden' }); return; }
    try {
      if (url.pathname === '/auth/callback') {
        if (request.method !== 'GET') { reply(response, 405, { error: 'invalid_request' }); return; }
        if (busy) { reply(response, 409, { error: 'request_in_progress' }); return; }
        busy = true;
        try { await options.auth.complete(url.searchParams); } finally { busy = false; }
        response.writeHead(303, { Location: '/#settings' }); response.end(); return;
      }
      if (url.pathname.startsWith('/api/self-hosted/chatgpt/')) {
        const route = url.pathname.slice('/api/self-hosted/chatgpt/'.length);
        if (request.method === 'GET' && route === 'status') {
          const record = await options.auth.record();
          reply(response, 200, { connected: !!record.session, allowed: !!record.session?.scopes.includes('chatgpt.tokens.use.direct'), enabled: record.enabled, model: record.model }); return;
        }
        if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['x-kakeimatch-self-hosted'] !== '1' || !request.headers['content-type']?.startsWith('application/json') || busy) {
          reply(response, busy ? 409 : 403, { error: busy ? 'request_in_progress' : 'forbidden' }); return;
        }
        // Serialize settings/auth/inference, including token-store writes and rotating refreshes.
        busy = true;
        try {
          if (route === 'sign-in') { reply(response, 200, { url: await options.auth.begin(`${origin}/auth/callback`) }); return; }
          if (route === 'sign-out') { reply(response, 200, { revoked: await options.auth.signOut() }); return; }
          if (route === 'models') { reply(response, 200, { models: await options.client.models() }); return; }
          if (route === 'settings') {
            const parsed = settingsSchema.safeParse(await json(request)); if (!parsed.success) throw new ChatGptPlanError('invalid_response');
            const record = await options.auth.record();
            if (parsed.data.enabled && (!parsed.data.model || !(await options.client.models()).some(model => model.id === parsed.data.model))) throw new ChatGptPlanError('permission_required');
            await options.auth.store.write({ ...record, ...parsed.data }); reply(response, 200, { saved: true }); return;
          }
          if (route === 'receipt') {
            const parsed = imageSchema.safeParse(await json(request)); if (!parsed.success) throw new ChatGptPlanError('invalid_response');
            const bytes = Buffer.from(parsed.data.imageBase64, 'base64');
            if (bytes.length > 6 * 1024 * 1024 || bytes.toString('base64') !== parsed.data.imageBase64) throw new ChatGptPlanError('invalid_response');
            validateReceiptImage({ bytes, declaredContentType: parsed.data.contentType });
            const output = await options.client.jsonResponse({ instructions: `${RECEIPT_EXTRACTION_PROMPT}\nReturn JSON matching this schema: ${JSON.stringify(receiptExtractionJsonSchema)}`,
              content: [{ type: 'input_text', text: 'Read this receipt.' }, { type: 'input_image', image_url: `data:${parsed.data.contentType};base64,${parsed.data.imageBase64}` }] });
            reply(response, 200, validateReceiptExtraction(output)); return;
          }
          reply(response, 404, { error: 'not_found' }); return;
        } finally { busy = false; }
      }
      if (url.pathname.startsWith('/api/')) { reply(response, 503, { error: 'self_hosted_provider_only' }); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { reply(response, 405, { error: 'invalid_request' }); return; }
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.')) || pathname.includes('\0')) throw new Error();
      const filename = await realpath(resolve(assetsRoot, `.${pathname === '/' ? '/index.html' : pathname}`));
      if (!filename.startsWith(assetsRoot + sep)) throw new Error();
      const contentType = filename.endsWith('.html') ? 'text/html' : filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.wasm') ? 'application/wasm' : filename.endsWith('.json') ? 'application/json' : filename.endsWith('.svg') ? 'image/svg+xml' : filename.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      const content = request.method === 'HEAD' ? undefined : await readFile(filename);
      response.writeHead(200, { 'content-type': contentType }); response.end(content);
    } catch (error) {
      const code = error instanceof ChatGptPlanError ? error.code : 'invalid_response';
      reply(response, code === 'rate_limited' ? 429 : code === 'reauthentication_required' ? 401 : 400, { error: code });
    }
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port ?? 1455, '127.0.0.1', accept); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Loopback listener unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  return { server, origin };
}
