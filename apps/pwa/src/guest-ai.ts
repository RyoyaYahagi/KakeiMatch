// Browser side of guest AI use: AI without an account, a few times a day.
// The server decides every limit; nothing here is used for authorization.

const GUEST_SECRET_KEY = 'kakeimatch.aiGuestSecret';
const GUEST_SECRET = /^[A-Za-z0-9_-]{43}$/;
const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type TurnstileApi = {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
};
declare global { interface Window { turnstile?: TurnstileApi } }

export type GuestUsage = { plan: 'guest'; period: 'day'; day: string; used: number; limit: number; remaining: number };

/** The device's guest secret, or null. Private windows and blocked storage simply start a new guest. */
export function storedGuestSecret(): string | null {
  try {
    const value = localStorage.getItem(GUEST_SECRET_KEY);
    return value && GUEST_SECRET.test(value) ? value : null;
  } catch {
    return null;
  }
}
function storeGuestSecret(value: string) {
  try { localStorage.setItem(GUEST_SECRET_KEY, value); } catch { /* The guest lasts for this page only. */ }
}
export function forgetGuestSecret() {
  try { localStorage.removeItem(GUEST_SECRET_KEY); } catch { /* Nothing persisted. */ }
}

let turnstileScript: Promise<TurnstileApi> | null = null;
function loadTurnstileScript(): Promise<TurnstileApi> {
  turnstileScript ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.addEventListener('load', () => window.turnstile ? resolve(window.turnstile) : reject(new Error('guest_unavailable')));
    script.addEventListener('error', () => reject(new Error('guest_unavailable')));
    document.head.append(script);
  }).catch(error => {
    turnstileScript = null;
    throw error;
  });
  return turnstileScript;
}

/** Shows the bot check in a dialog and resolves with its single-use token. Cancelling rejects. */
function botCheck(siteKey: string): Promise<string> {
  const dialog = document.createElement('dialog');
  dialog.className = 'bot-check-dialog';
  dialog.setAttribute('aria-labelledby', 'bot-check-title');
  const title = document.createElement('h2'); title.id = 'bot-check-title'; title.textContent = '確認しています';
  const lead = document.createElement('p'); lead.className = 'muted';
  lead.textContent = '登録なしでAIを使う前に、ロボットでないことを確かめます。多くの場合は数秒で自動的に終わります。';
  const widget = document.createElement('div'); widget.className = 'bot-check-widget';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = 'やめる';
  dialog.append(title, lead, widget, status, cancel);
  document.body.append(dialog);
  dialog.showModal();
  return new Promise<string>((resolve, reject) => {
    let widgetId: string | null = null;
    const finish = (result: () => void) => {
      if (widgetId !== null) window.turnstile?.remove(widgetId);
      dialog.close(); dialog.remove(); result();
    };
    cancel.addEventListener('click', () => finish(() => reject(new Error('bot_check_cancelled'))));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(() => reject(new Error('bot_check_cancelled'))); });
    loadTurnstileScript().then(turnstile => {
      if (!dialog.isConnected) return;
      widgetId = turnstile.render(widget, {
        sitekey: siteKey,
        action: 'guest',
        language: 'ja',
        size: 'flexible',
        callback: (token: string) => finish(() => resolve(token)),
        'error-callback': () => { status.textContent = '確認できませんでした。通信を確かめて、もう一度お試しください。'; },
      });
    }).catch(() => finish(() => reject(new Error('guest_unavailable'))));
  });
}

/** Creates a guest after the bot check and keeps its secret on this device. */
export async function startGuest(): Promise<string> {
  const configResponse = await fetch('/api/ai/guest', { credentials: 'same-origin' });
  if (!configResponse.ok) throw new Error('guest_unavailable');
  const config = await configResponse.json() as { guestAvailable?: unknown; turnstileSiteKey?: unknown };
  if (config.guestAvailable !== true || typeof config.turnstileSiteKey !== 'string') throw new Error('guest_unavailable');
  const turnstileToken = await botCheck(config.turnstileSiteKey);
  const response = await fetch('/api/ai/guest', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ turnstileToken }),
  });
  if (response.status === 429) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(body?.error === 'guest_limit_reached' ? 'guest_limit_reached' : 'rate_limited');
  }
  if (response.status === 403) throw new Error('bot_check_failed');
  if (!response.ok) throw new Error('guest_unavailable');
  const { guestSecret } = await response.json() as { guestSecret?: unknown };
  if (typeof guestSecret !== 'string' || !GUEST_SECRET.test(guestSecret)) throw new Error('guest_unavailable');
  storeGuestSecret(guestSecret);
  return guestSecret;
}

/** Today's guest usage, or null when this device has no guest yet. */
export async function guestUsage(): Promise<GuestUsage | null> {
  const secret = storedGuestSecret();
  if (!secret) return null;
  const response = await fetch('/api/ai/usage', { credentials: 'same-origin', headers: { authorization: `Guest ${secret}` } });
  if (response.status === 401) { forgetGuestSecret(); return null; }
  if (!response.ok) throw new Error('guest_usage_unavailable');
  return response.json() as Promise<GuestUsage>;
}
