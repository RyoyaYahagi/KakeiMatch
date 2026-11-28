import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_OPERATOR_PRINCIPAL_ID, handleAdminRequest, type AdminEnv } from "./admin";
import { sqliteD1 } from "./test-support/sqlite-d1";

const migrationNames = [
  "0001_auth.sql", "0002_entitlements_usage.sql", "0003_receipt_ai_flows.sql", "0004_ai_provider_costs.sql",
  "0005_ai_global_guardrails.sql", "0006_contact_submissions.sql", "0007_account_deletion.sql", "0014_guest_ai.sql",
  "0015_uncounted_provider_errors.sql", "0016_category_suggestion_flows.sql", "0016_feedback_inbox.sql",
  "0017_jev_upstream_circuits.sql", "0018_native_app_auth.sql", "0019_admin_operator_principal.sql",
];
const origin = "https://kakeimatch.example";
const teamDomain = "https://example.cloudflareaccess.com";
const audience = "admin-aud";
const now = Math.floor(Date.parse("2026-10-08T04:00:00Z") / 1000);
let sqlite: DatabaseSync | undefined;

afterEach(() => { sqlite?.close(); sqlite = undefined; });

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function createAccessFixture() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwks = { keys: [{ ...publicJwk, kid: "key-1", alg: "RS256", use: "sig" }] };
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } });
  const sign = async (claims: Record<string, unknown>) => {
    const header = encode({ alg: "RS256", typ: "JWT", kid: "key-1" });
    const payload = encode({ iss: teamDomain, aud: [audience], exp: now + 60, ...claims });
    const signature = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)),
    );
    let binary = "";
    for (const byte of signature) binary += String.fromCharCode(byte);
    return `${header}.${payload}.${btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
  };
  return { fetchImpl, sign };
}

async function setup() {
  sqlite = new DatabaseSync(":memory:");
  const db = sqliteD1(sqlite);
  const migrations = migrationNames.map(name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
    .replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim()).join(" ");
  sqlite.exec(migrations);
  for (const [id, email] of [["admin-user", "admin@example.test"], ["member-user", "member@example.test"], ["guest-user", "guest@example.invalid"]]) {
    await db.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES (?, 'Synthetic', ?, ?, ?)")
      .bind(id, email, (now - 3600) * 1000, (now - 3600) * 1000).run();
  }
  await db.prepare("INSERT INTO guest_devices(user_id,secret_hash,created_at,created_day,created_ip_day_mac,last_used_at) VALUES ('guest-user','hash','1','2026-10-08','address-mac',?)").bind(now).run();
  await db.prepare("INSERT INTO account_entitlements(user_id,plan,monthly_ai_limit) VALUES ('member-user','pro',100)").bind().run();
  await db.prepare(`INSERT INTO ai_provider_cost_events(id,user_id,provider,requested_model,model,input_tokens,output_tokens,total_tokens,
    estimated_cost_usd_micros,metering_status,safe_error_code,dispatched_at,completed_at)
    VALUES ('event-gemini','member-user','gemini','model','model',10,2,12,300,'metered','provider_unavailable',?,?),
    ('event-jev','guest-user','jev','model','model',8,1,9,50,'metered','rate_limited',?,?)`)
    .bind(now - 60, now - 30, now - 120, now - 20).run();
  await db.prepare(`INSERT INTO feedback_submissions(id,created_at,updated_at,kind,status,message_original_encrypted,message_sanitized,retention_expires_at)
    VALUES ('feedback-open',?,?, 'bug','new','encrypted-original','safe summary',?),
    ('feedback-expired',?,?, 'question','new','expired-original','expired',?)`)
    .bind(now - 50, now - 40, now + 86400, now - 200, now - 200, now - 1).run();
  await db.prepare("INSERT INTO admin_audit_log(id,admin_user_id,action,target_type,target_id,created_at) VALUES ('audit1','access:seed-sub','feedback_analyzed','feedback','feedback-open',?)")
    .bind(now - 10).run();
  const env: AdminEnv = {
    ACCOUNT_DB: db,
    CF_ACCESS_TEAM_DOMAIN: teamDomain,
    CF_ACCESS_AUD: audience,
    ADMIN_ACCESS_EMAILS: "admin@example.test",
  };
  return { db, env };
}

const get = (path: string, jwt?: string) => new Request(`${origin}${path}`, jwt ? { headers: { "cf-access-jwt-assertion": jwt } } : undefined);

describe("admin D1 APIs", () => {
  it("lists feedback for an allowed Access email without cookies or session, and records access:<sub> in audit logs", async () => {
    const { db, env } = await setup();
    const { fetchImpl, sign } = await createAccessFixture();
    const jwt = await sign({ email: "admin@example.test", sub: "admin-sub-1" });
    const options = { fetchImpl, nowSeconds: () => now };

    const feedback = await handleAdminRequest(get("/api/admin/feedback", jwt), env, options);
    expect(feedback.status).toBe(200);
    expect(feedback.headers.get("cache-control")).toBe("no-store");
    expect(await feedback.json()).toMatchObject({
      items: [{ id: "feedback-open", kind: "bug", status: "new", message: "safe summary" }],
    });

    const patch = await handleAdminRequest(new Request(`${origin}/api/admin/feedback/feedback-open/status`, {
      method: "PATCH",
      headers: { origin, "content-type": "application/json", "cf-access-jwt-assertion": jwt },
      body: JSON.stringify({ status: "reviewing" }),
    }), env, options);
    expect(patch.status).toBe(200);

    const audit = await handleAdminRequest(get("/api/admin/audit", jwt), env, options);
    expect(await audit.json()).toMatchObject({
      entries: [
        { adminUserId: "access:admin-sub-1", action: "feedback_status_updated", targetId: "feedback-open" },
        { adminUserId: "access:seed-sub", action: "feedback_analyzed", targetId: "feedback-open" },
      ],
    });

    const overview = await handleAdminRequest(get("/api/admin/overview", jwt), env, options);
    expect(overview.status).toBe(200);
    expect(overview.headers.get("cache-control")).toBe("no-store");
    expect(await overview.json()).toMatchObject({
      accounts: { registered: 2, usedAiToday: 2 },
      ai: { requestsToday: 2, requestsLast30Days: 2, monthUsdMicros: 350, unknownRequests: 0, last30DaysErrors: 2, last30DaysRateLimits: 1 },
      feedback: { open: 1 },
      recentErrors: [{ code: "provider_unavailable", requests: 1, lastSeen: now - 60 }, { code: "rate_limited", requests: 1, lastSeen: now - 120 }],
    });
    const expired = await db.prepare("SELECT id FROM feedback_submissions WHERE id='feedback-expired'").bind().first();
    expect(expired).toBeNull();

    const costs = await handleAdminRequest(get("/api/admin/ai/costs?month=2026-10", jwt), env, options);
    expect(await costs.json()).toMatchObject({ totalUsdMicros: 350, providers: { gemini: { requests: 1 }, jev: { requests: 1 } } });

    const users = await handleAdminRequest(get("/api/admin/users", jwt), env, options);
    const userBody = await users.json() as { users: Array<{ id: string; subject: string; entitlement: string | null; createdAt: number }> };
    expect(userBody.users.some(user => user.id === ADMIN_OPERATOR_PRINCIPAL_ID)).toBe(false);
    expect(userBody.users.find(user => user.id === "guest-user")).toMatchObject({ subject: "guest", entitlement: null, createdAt: now - 3600 });
    expect(userBody.users.find(user => user.id === "member-user")).toMatchObject({ subject: "account", entitlement: "pro" });
    expect(JSON.stringify(userBody)).not.toContain("@example");
  });

  it("keeps calendar-month costs outside the rolling 30-day window and counts every error group", async () => {
    const { db, env } = await setup();
    const { fetchImpl, sign } = await createAccessFixture();
    const monthEnd = Date.parse("2026-10-31T14:59:00Z") / 1000;
    const monthStart = Date.parse("2026-09-30T15:01:00Z") / 1000;
    const jwt = await sign({ email: "admin@example.test", sub: "admin-sub-1", exp: monthEnd + 60 });
    await db.prepare(`INSERT INTO ai_provider_cost_events(id,user_id,provider,requested_model,model,estimated_cost_usd_micros,metering_status,dispatched_at)
      VALUES ('month-start','member-user','gemini','model','model',777,'metered',?)`).bind(monthStart).run();
    for (let index = 0; index < 12; index++) await db.prepare(`INSERT INTO ai_provider_cost_events(id,user_id,provider,requested_model,model,metering_status,safe_error_code,dispatched_at)
      VALUES (?,'member-user','gemini','model','model','unknown',?,?)`).bind(`error-${index}`, `safe_code_${index}`, monthEnd - 10).run();
    const response = await handleAdminRequest(get("/api/admin/overview", jwt), env, { fetchImpl, nowSeconds: () => monthEnd });
    const data = await response.json() as { ai: { monthUsdMicros: number; last30DaysErrors: number }; recentErrors: unknown[] };
    expect(data.ai.monthUsdMicros).toBe(1127);
    expect(data.ai.last30DaysErrors).toBe(14);
    expect(data.recentErrors).toHaveLength(10);
  });

  it("rejects missing, invalid, wrong-aud, expired, disallowed, service-token, unconfigured, and cross-origin requests", async () => {
    const { env } = await setup();
    const { fetchImpl, sign } = await createAccessFixture();
    const otherSigner = await createAccessFixture();
    const options = { fetchImpl, nowSeconds: () => now };

    const validJwt = await sign({ email: "admin@example.test", sub: "admin-sub-1" });
    const wrongSigJwt = await otherSigner.sign({ email: "admin@example.test", sub: "admin-sub-1" });
    const wrongAudJwt = await sign({ email: "admin@example.test", sub: "admin-sub-1", aud: ["other-aud"] });
    const expiredJwt = await sign({ email: "admin@example.test", sub: "admin-sub-1", exp: now - 1 });
    const disallowedJwt = await sign({ email: "member@example.test", sub: "member-sub-1" });
    const serviceTokenJwt = await sign({ sub: "svc-sub-1", common_name: "svc" });

    for (const req of [
      get("/api/admin/feedback"),
      get("/api/admin/feedback", wrongSigJwt),
      get("/api/admin/feedback", wrongAudJwt),
      get("/api/admin/feedback", expiredJwt),
      get("/api/admin/feedback", disallowedJwt),
      get("/api/admin/feedback", serviceTokenJwt),
    ]) {
      const response = await handleAdminRequest(req, env, options);
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    const mutation = new Request(`${origin}/api/admin/feedback/feedback-open/status`, {
      method: "PATCH",
      headers: { origin: "https://attacker.example", "content-type": "application/json", "cf-access-jwt-assertion": validJwt },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect((await handleAdminRequest(mutation, env, options)).status).toBe(403);

    const noDomainEnv: AdminEnv = { ...env };
    delete noDomainEnv.CF_ACCESS_TEAM_DOMAIN;
    expect((await handleAdminRequest(get("/api/admin/feedback", validJwt), noDomainEnv, options)).status).toBe(503);

    const noAudEnv: AdminEnv = { ...env };
    delete noAudEnv.CF_ACCESS_AUD;
    expect((await handleAdminRequest(get("/api/admin/feedback", validJwt), noAudEnv, options)).status).toBe(503);

    const neitherEnv: AdminEnv = { ...env };
    delete neitherEnv.CF_ACCESS_TEAM_DOMAIN;
    delete neitherEnv.CF_ACCESS_AUD;
    expect((await handleAdminRequest(get("/api/admin/feedback", validJwt), neitherEnv, options)).status).toBe(503);
  });
});
