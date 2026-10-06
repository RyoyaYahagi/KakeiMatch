// HTTP and token helpers shared by the Cloud account routes.

const MAX_BODY_BYTES = 16 * 1024;

export interface RateLimitBinding { limit(input: { key: string }): Promise<{ success: boolean }> }

/** Returns the trusted app origin, or null when the request host is not the configured one. */
export function configuredOrigin(configured: string | undefined, request: Request): URL | null {
  const requestUrl = new URL(request.url);
  if (configured) {
    let allowlisted: URL;
    try {
      allowlisted = new URL(configured);
    } catch {
      return null;
    }
    if (allowlisted.origin !== configured || allowlisted.origin !== requestUrl.origin) return null;
    return allowlisted;
  }
  if (requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1") return requestUrl;
  return null;
}

export function secureEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/** Checks the operator-only bearer secret. Missing or short secrets fail closed. */
export function hasOperatorSecret(request: Request, expectedSecret: string | undefined): boolean {
  const match = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "");
  return Boolean(expectedSecret && expectedSecret.length >= 32 && match && secureEqual(match[1], expectedSecret));
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** A 256-bit URL-safe random token. Only its digest is persisted. */
export function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isTokenShape(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(bytes));
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return null;
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function isEmail(value: unknown): value is string {
  return typeof value === "string" && value.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120;
}

/** Applies a Cloudflare rate-limit binding. A missing or failing binding fails closed. */
export async function withinRateLimit(binding: RateLimitBinding | undefined, key: string): Promise<"ok" | "limited" | "unavailable"> {
  if (!binding) return "unavailable";
  try {
    return (await binding.limit({ key })).success ? "ok" : "limited";
  } catch {
    return "unavailable";
  }
}
