import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { handleRequest, type AccountD1Binding, type GatewayEnv } from "./worker";
import { addressDayMac } from "./guest-ai";
import { dayKey, reserveFlow, uncountFlow, type FlowLimits } from "./receipt-ai-usage";
import { sqliteD1 } from "./test-support/sqlite-d1";

const origin = "https://guest.example.test";
const secret = "synthetic-guest-signing-secret";
const now = Date.parse("2026-10-06T03:00:00Z") / 1000;
const limits: FlowLimits = { guestDaily: 5, guestAddressDaily: 20, contactSubmitAddressDaily: 10 };

let sqlite: DatabaseSync;
let db: AccountD1Binding;
let env: GatewayEnv;
let guestCount = 0;
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter(name => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(name, dir), "utf8"));
  db = sqliteD1(sqlite);
  env = { ACCOUNT_DB: db, AI_GATEWAY_AUTH_SECRET: secret, AI_USER_RATE_LIMIT: { limit: async () => ({ success: true }) } };
});

/**
 * Seeds a guest the way the native guest route stores one: a user row, and a device row
 * holding only the digest of the guest secret and the keyed address MAC.
 */
async function guestSecret(address = "192.0.2.10", at = now): Promise<string> {
  guestCount++;
  const value = `synthetic-guest-${guestCount}`.padEnd(43, "x");
  const userId = `guest-user-${guestCount}`;
  const mac = await addressDayMac(secret, new Request(origin, { headers: { "cf-connecting-ip": address } }), at);
  sqlite.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Guest', ?, 0, ?, ?)")
    .run(userId, `${userId}@guest.kakeimatch.invalid`, at * 1000, at * 1000);
  sqlite.prepare(`INSERT INTO guest_devices (user_id, secret_hash, created_at, created_day, created_ip_day_mac, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(userId, createHash("sha256").update(value).digest("hex"), at, dayKey(at), mac, at);
  return value;
}
const guestId = () => (sqlite.prepare("SELECT user_id FROM guest_devices ORDER BY rowid DESC LIMIT 1").get() as { user_id: string }).user_id;
function tokenRequest(guest: string) {
  return new Request(`${origin}/api/ai/token`, { method: "POST", headers: { origin, authorization: `Guest ${guest}` } });
}

describe("guest AI", () => {
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
    // The developer cost route was retired with the account features.
    expect((await handleRequest(new Request(`${origin}/api/ai/costs`, { headers: { authorization: `Guest ${value}` } }), env)).status).toBe(404);
  });

  it("rejects a Web request that carries no guest secret, even with a valid origin", async () => {
    expect((await handleRequest(new Request(`${origin}/api/ai/usage`, { headers: { origin } }), env)).status).toBe(401);
    expect((await handleRequest(new Request(`${origin}/api/ai/token`, { method: "POST", headers: { origin } }), env)).status).toBe(401);
  });

  it("allows five receipts per guest per Tokyo day and twenty per address", async () => {
    await guestSecret(); const first = guestId();
    const reserve = (user: string, address: string, at = now) => reserveFlow(db, user, crypto.randomUUID(), "mac", at, limits, "receipt", address);
    for (let index = 0; index < 5; index++) expect(await reserve(first, "address-a")).toBe("reserved");
    expect(await reserve(first, "address-a")).toBe("ai_quota_exceeded");
    // A flow the provider answered with an error status gives its slot back.
    const failed = (sqlite.prepare("SELECT flow_id FROM ai_receipt_flows WHERE user_id = ? LIMIT 1").get(first) as { flow_id: string }).flow_id;
    await uncountFlow(db, first, failed);
    expect(await reserve(first, "address-a")).toBe("reserved");
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
});
