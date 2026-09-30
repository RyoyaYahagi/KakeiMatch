type TokenResponse = { token: string; expiresAt: number };

let cachedToken: TokenResponse | null = null;

/** Get an in-memory AI JWT, refreshing it silently from the account session when near expiry. */
export async function getAiAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 30) return cachedToken.token;

  const response = await fetch('/api/ai/token', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'account_session_required' : 'ai_token_unavailable');
  const result = await response.json() as TokenResponse;
  if (typeof result.token !== 'string' || !result.token || !Number.isSafeInteger(result.expiresAt)) {
    throw new Error('invalid_ai_token_response');
  }
  cachedToken = result;
  return result.token;
}

/** Drop the in-memory token on logout so it cannot be reused by later local UI state. */
export function clearAiAccessToken() {
  cachedToken = null;
}
