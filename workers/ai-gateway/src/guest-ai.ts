import type { AccountEnv } from "./account-db";
import { dayKey } from "./receipt-ai-usage";

type Db = AccountEnv["ACCOUNT_DB"];
interface RateLimitBinding { limit(input: { key: string }): Promise<{ success: boolean }> }
export interface GuestEnv {
  ACCOUNT_DB?: Db; AI_GATEWAY_AUTH_SECRET?: string; AI_USER_RATE_LIMIT?: RateLimitBinding;
}

// A shared address (a home router, or a carrier's) still lets a household start a few guests.
export const GUEST_CREATIONS_PER_ADDRESS_DAILY = 10;

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
