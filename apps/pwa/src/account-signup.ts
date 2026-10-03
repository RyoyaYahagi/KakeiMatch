// Browser side of open signup and Family invites. The server decides every plan;
// nothing here is used for authorization.

const FAMILY_INVITE_KEY = 'kakeimatch.familyInvite';
const FAMILY_INVITE_FRAGMENT = /^#family-invite=([A-Za-z0-9_-]{43})$/;
const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type TurnstileApi = {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};
declare global { interface Window { turnstile?: TurnstileApi } }

export type SignupConfig = { signupAvailable: boolean; turnstileSiteKey: string | null };

/**
 * Moves a Family invite token from the URL fragment to tab-scoped storage and
 * strips it from the address bar, history, and later share/copy actions.
 */
export function captureFamilyInvite(): boolean {
  const match = FAMILY_INVITE_FRAGMENT.exec(location.hash);
  if (!match) return false;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  try {
    sessionStorage.setItem(FAMILY_INVITE_KEY, match[1]);
  } catch {
    // Without storage the invite cannot survive Passkey prompts; the user can reopen the link.
    return false;
  }
  return true;
}

export function pendingFamilyInvite(): string | null {
  try {
    return sessionStorage.getItem(FAMILY_INVITE_KEY);
  } catch {
    return null;
  }
}

export function clearFamilyInvite() {
  try {
    sessionStorage.removeItem(FAMILY_INVITE_KEY);
  } catch {
    // Nothing persisted.
  }
}

export async function fetchSignupConfig(): Promise<SignupConfig> {
  const response = await fetch('/api/account/signup-config', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('signup_config_unavailable');
  return response.json() as Promise<SignupConfig>;
}

let turnstileScript: Promise<TurnstileApi> | null = null;

function loadTurnstileScript(): Promise<TurnstileApi> {
  turnstileScript ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.addEventListener('load', () => window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile_unavailable')));
    script.addEventListener('error', () => reject(new Error('turnstile_unavailable')));
    document.head.append(script);
  }).catch(error => {
    turnstileScript = null;
    throw error;
  });
  return turnstileScript;
}

/** Renders the bot check. `token()` is the latest unused token, or null until the check passes. */
export async function renderBotCheck(container: HTMLElement, siteKey: string, onChange: (ready: boolean) => void) {
  const turnstile = await loadTurnstileScript();
  let token: string | null = null;
  container.replaceChildren();
  const widgetId = turnstile.render(container, {
    sitekey: siteKey,
    action: 'signup',
    language: 'ja',
    size: 'flexible',
    callback: (value: string) => { token = value; onChange(true); },
    'expired-callback': () => { token = null; onChange(false); },
    'error-callback': () => { token = null; onChange(false); },
  });
  return {
    token: () => token,
    // Turnstile tokens are single-use; get a fresh one after each submission attempt.
    reset: () => { token = null; onChange(false); turnstile.reset(widgetId); },
    remove: () => turnstile.remove(widgetId),
  };
}
