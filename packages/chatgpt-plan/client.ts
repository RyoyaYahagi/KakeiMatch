import { z } from 'zod';
import { ChatGptPlanAuth, ChatGptPlanError } from './auth';

const modelsSchema = z.object({ models: z.array(z.object({ slug: z.string().min(1).max(128), display_name: z.string().max(128), visibility: z.string() })).max(1000) });
export class ChatGptPlanClient {
  constructor(readonly auth: ChatGptPlanAuth, private readonly fetchImpl = fetch) {}
  async models() {
    const token = await this.auth.access();
    const response = await this.request('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${token.accessToken}` } });
    try { return modelsSchema.parse(await response.json()).models.filter(model => model.visibility === 'list').map(model => ({ id: model.slug, name: model.display_name })); }
    catch { throw new ChatGptPlanError('invalid_response'); }
  }
  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try { response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(90_000), redirect: 'error' }); }
    catch { throw new ChatGptPlanError('provider_unavailable'); }
    if (!response.ok) throw new ChatGptPlanError(response.status === 429 ? 'rate_limited' : response.status === 401 ? 'reauthentication_required' : 'provider_unavailable');
    return response;
  }
  /** API-only adapter: all Preview restrictions remain here, independent of household/UI code. */
  async jsonResponse(input: { instructions: string; content: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }> }): Promise<unknown> {
    const record = await this.auth.record();
    if (!record.enabled || !record.model) throw new ChatGptPlanError('permission_required');
    if (!(await this.models()).some(model => model.id === record.model)) throw new ChatGptPlanError('provider_unavailable');
    const token = await this.auth.access();
    const response = await this.request('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${token.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: record.model, instructions: input.instructions, input: [{ role: 'user', content: input.content }],
        store: false, stream: true, text: { format: { type: 'json_object' } } }),
    });
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new ChatGptPlanError('invalid_response');
    const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = ''; let size = 0; let result: unknown; let completed = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength; if (size > 8 * 1024 * 1024) throw new ChatGptPlanError('invalid_response');
        buffer += decoder.decode(value, { stream: true });
        // Accept LF and CRLF without losing a CRLF split across network chunks.
        const normalized = buffer.replaceAll('\r\n', '\n'); const frames = normalized.split('\n\n'); buffer = frames.pop()!;
        for (const frame of frames) {
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          const event = JSON.parse(data) as { type?: string; response?: { status?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> } };
          if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') throw new ChatGptPlanError('invalid_response');
          if (event.type === 'response.completed') {
            if (completed || event.response?.status !== 'completed') throw new ChatGptPlanError('invalid_response');
            const text = event.response.output?.filter(output => output.type === 'message').flatMap(output => output.content ?? []).filter(content => content.type === 'output_text').map(content => content.text ?? '').join('');
            if (!text || text.length > 1024 * 1024) throw new ChatGptPlanError('invalid_response');
            result = JSON.parse(text); completed = true;
          }
        }
      }
      decoder.decode();
      if (!completed || buffer.trim()) throw new ChatGptPlanError('invalid_response');
      return result;
    } catch (error) { if (error instanceof ChatGptPlanError) throw error; throw new ChatGptPlanError('invalid_response'); }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
