import type { AccountEnv } from "./account-db";
import { dayKey } from "./receipt-ai-usage";

type Db = AccountEnv["ACCOUNT_DB"];
interface RateLimitBinding { limit(input: { key: string }): Promise<{ success: boolean }> }
export interface GuestEnv {
  ACCOUNT_DB?: Db; AI_GATEWAY_AUTH_SECRET?: string; AI_USER_RATE_LIMIT?: RateLimitBinding;
}

// A shared address (a home router, or a carrier's) still lets a household start a few guests.
export const GUEST_CREATIONS_PER_ADDRESS_DAILY = 10;
const GUEST_SECRET = /^[A-Za-z0-9_-]{43}$/;

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * An HMAC of the client address keyed by the Tokyo day. It caps use per address
 * without storing the address, and the same address gives a new value each day.
 */
export async function addressDayMac(secret: string, request: Request, now: number): Promise<string> {
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`address-day\n${dayKey(now)}\n${address}`)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The guest's user ID for a `Guest <secret>` header, or null. */
export async function guestFromRequest(request: Request, db: Db): Promise<string | null> {
  const match = /^Guest ([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match || !GUEST_SECRET.test(match[1])) return null;
  const row = await db.prepare("SELECT user_id AS userId FROM guest_devices WHERE secret_hash = ?")
    .bind(await sha256Hex(match[1])).first<{ userId: string }>();
  return row?.userId ?? null;
}
export function hasGuestAuthorization(request: Request): boolean {
  return (request.headers.get("authorization") ?? "").startsWith("Guest ");
}
export async function touchGuest(db: Db, userId: string, now: number): Promise<void> {
  await db.prepare("UPDATE guest_devices SET last_used_at = ? WHERE user_id = ?").bind(now, userId).run();
}
