import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type AccountD1Binding, type GatewayEnv } from "./worker";
import { reserveFlow, type FlowLimits } from "./receipt-ai-usage";
import { GUEST_CREATIONS_PER_ADDRESS_DAILY } from "./guest-ai";
import { sqliteD1 } from "./test-support/sqlite-d1";

const origin = "https://guest.example.test";
const secret = "synthetic-guest-signing-secret";
const testingTurnstileSecret = "1x0000000000000000000000000000000AA";
const now = Date.parse("2026-10-06T03:00:00Z") / 1000;
const limits: FlowLimits = { monthlyDefault: 30, guestDaily: 5, guestAddressDaily: 20, contactSubmitAddressDaily: 10 };
const turnstilePass = () => vi.fn<typeof fetch>(async () => Response.json({ success: true, hostname: "guest.example.test", action: "guest" }));

let sqlite: DatabaseSync;
let db: AccountD1Binding;
let env: GatewayEnv;
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter(name => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(name, dir), "utf8"));
  db = sqliteD1(sqlite);
  env = { ACCOUNT_DB: db, AI_GATEWAY_AUTH_SECRET: secret, TURNSTILE_SITE_KEY: "synthetic-site-key", TURNSTILE_SECRET_KEY: testingTurnstileSecret,
    AI_USER_RATE_LIMIT: { limit: async () => ({ success: true }) } };
});

function guestRequest(method: string, headers: Record<string, string> = {}, body?: unknown) {
  return new Request(`${origin}/api/ai/guest`, { method, headers: { origin, "cf-connecting-ip": "192.0.2.10", ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
}
async function createGuest(fetchImpl = turnstilePass(), address = "192.0.2.10", at = now): Promise<Response> {
  return handleRequest(guestRequest("POST", { "cf-connecting-ip": address }, { turnstileToken: "synthetic-turnstile-token" }), env, { fetchImpl, nowSeconds: () => at });
}
async function guestSecret(address?: string, at?: number): Promise<string> {
  const response = await createGuest(turnstilePass(), address, at);
  expect(response.status).toBe(201);
  return (await response.json() as { guestSecret: string }).guestSecret;
}
const guestId = () => (sqlite.prepare("SELECT user_id FROM guest_devices ORDER BY rowid DESC LIMIT 1").get() as { user_id: string }).user_id;
function tokenRequest(guest: string) {
  return new Request(`${origin}/api/ai/token`, { method: "POST", headers: { origin, authorization: `Guest ${guest}` } });
}

describe("guest AI", () => {
  it("tells the PWA whether guests are available, with the public site key only", async () => {
    const config = await handleRequest(new Request(`${origin}/api/ai/guest`), env);
    expect(await config.json()).toEqual({ guestAvailable: true, turnstileSiteKey: "synthetic-site-key" });
    env.TURNSTILE_SECRET_KEY = undefined;
    expect(await (await handleRequest(new Request(`${origin}/api/ai/guest`), env)).json()).toEqual({ guestAvailable: false, turnstileSiteKey: null });
  });

  it("creates a guest only after the bot check, storing a digest and no address", async () => {
    const failed = vi.fn<typeof fetch>(async () => Response.json({ success: false }));
    expect((await createGuest(failed)).status).toBe(403);
    expect((await handleRequest(guestRequest("POST", { origin: "https://evil.example.test" }, { turnstileToken: "x" }), env, { fetchImpl: turnstilePass() })).status).toBe(403);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM user").get()).toEqual({ count: 0 });

    const value = await guestSecret();
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = sqlite.prepare("SELECT secret_hash, created_ip_day_mac FROM guest_devices").get() as { secret_hash: string; created_ip_day_mac: string };
    expect(row.secret_hash).not.toContain(value);
    expect(JSON.stringify(sqlite.prepare("SELECT * FROM guest_devices").all())).not.toContain("192.0.2.10");
  });

  it("checks the action and hostname with a production Turnstile secret", async () => {
    env.TURNSTILE_SECRET_KEY = "synthetic-production-turnstile-secret";
    const signup = vi.fn<typeof fetch>(async () => Response.json({ success: true, hostname: "guest.example.test", action: "signup" }));
    expect((await createGuest(signup)).status).toBe(403);
    const otherHost = vi.fn<typeof fetch>(async () => Response.json({ success: true, hostname: "evil.example.test", action: "guest" }));
    expect((await createGuest(otherHost)).status).toBe(403);
    expect((await createGuest(turnstilePass())).status).toBe(201);
  });

  it("caps new guests per address per Tokyo day", async () => {
    for (let index = 0; index < GUEST_CREATIONS_PER_ADDRESS_DAILY; index++) await guestSecret();
    const capped = await createGuest();
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ error: "guest_limit_reached" });
    expect((await createGuest(turnstilePass(), "198.51.100.7")).status).toBe(201);
    expect((await createGuest(turnstilePass(), "192.0.2.10", now + 24 * 60 * 60)).status).toBe(201);
  });

  it("exchanges the guest secret for a short AI token and reports today's usage", async () => {
    const value = await guestSecret();
    const token = await handleRequest(tokenRequest(value), env, { nowSeconds: () => now });
    expect(token.status).toBe(200);
    const { token: jwt } = await token.json() as { token: string };
    expect(JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString())).toMatchObject({ sub: guestId(), aud: "kakeimatch-ai" });
    expect((await handleRequest(tokenRequest("A".repeat(43)), env)).status).toBe(401);

    await reserveFlow(db, guestId(), crypto.randomUUID(), "mac", now, limits, "receipt", "address");
    sqlite.exec("UPDATE ai_receipt_flows SET dispatched = 1");
    const usage = await handleRequest(new Request(`${origin}/api/ai/usage`, { headers: { authorization: `Guest ${value}` } }), env, { nowSeconds: () => now });
    expect(await usage.json()).toEqual({ plan: "guest", period: "day", day: "2026-10-06", used: 1, limit: 5, remaining: 4 });
    // Developer costs stay account-only.
    expect((await handleRequest(new Request(`${origin}/api/ai/costs`, { headers: { authorization: `Guest ${value}` } }), env)).status).not.toBe(200);
  });

  it("allows five receipts per guest per Tokyo day and twenty per address", async () => {
    await guestSecret(); const first = guestId();
    const reserve = (user: string, address: string, at = now) => reserveFlow(db, user, crypto.randomUUID(), "mac", at, limits, "receipt", address);
    for (let index = 0; index < 5; index++) expect(await reserve(first, "address-a")).toBe("reserved");
    expect(await reserve(first, "address-a")).toBe("ai_quota_exceeded");
    // Tokyo midnight is 15:00 UTC; the next day starts a new count.
    expect(await reserve(first, "address-a", Date.parse("2026-10-06T15:00:00Z") / 1000)).toBe("reserved");

    // New guests from one address still stop at the address cap.
    for (let guest = 0; guest < 4; guest++) {
      await guestSecret(`198.51.100.${guest}`);
      for (let index = 0; index < 5; index++) expect(await reserve(guestId(), "address-b")).toBe("reserved");
    }
    await guestSecret("198.51.100.9");
    expect(await reserve(guestId(), "address-b")).toBe("ai_quota_exceeded");
    expect(await reserve(guestId(), "address-c")).toBe("reserved");
  });

  it("does not count contact features, and caps contact submissions per address", async () => {
    await guestSecret(); const user = guestId();
    for (let index = 0; index < 5; index++) await reserveFlow(db, user, crypto.randomUUID(), "mac", now, limits, "receipt", "address");
    for (const kind of ["contact-transcribe", "contact-interview"] as const) {
      for (let index = 0; index < 12; index++) expect(await reserveFlow(db, user, crypto.randomUUID(), "mac", now, limits, kind, "address")).toBe("reserved");
    }
    for (let index = 0; index < 10; index++) expect(await reserveFlow(db, user, crypto.randomUUID(), "mac", now, limits, "contact-submit", "address")).toBe("reserved");
    expect(await reserveFlow(db, user, crypto.randomUUID(), "mac", now, limits, "contact-submit", "address")).toBe("ai_quota_exceeded");
  });

  it("retires a guest so its secret stops working, while usage still counts", async () => {
    const value = await guestSecret(); const user = guestId();
    for (let index = 0; index < 5; index++) await reserveFlow(db, user, crypto.randomUUID(), "mac", now, limits, "receipt", "address");
    sqlite.prepare("INSERT INTO contact_submissions(user_id, flow_id, input_mac, state, updated_at) VALUES (?, 'synthetic-flow', 'mac', 'done', 1)").run(user);

    expect((await handleRequest(guestRequest("DELETE", { authorization: "Guest " + "B".repeat(43) }), env)).status).toBe(401);
    const retired = await handleRequest(guestRequest("DELETE", { authorization: `Guest ${value}` }), env);
    expect(await retired.json()).toEqual({ retired: true });
    expect((await handleRequest(tokenRequest(value), env)).status).toBe(401);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM guest_devices").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM contact_submissions").get()).toEqual({ count: 0 });
    // Retiring and starting over does not reset the address cap.
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM ai_receipt_flows WHERE ip_day_mac = 'address'").get()).toEqual({ count: 5 });
  });
});
