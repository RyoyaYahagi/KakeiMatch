import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAdminRequest, type AdminEnv } from "./admin";
import { sqliteD1 } from "./test-support/sqlite-d1";

const authState = vi.hoisted(() => ({ userId: "admin-user" as string | null }));
vi.mock("./account-auth", () => ({
  getAccountSession: async () => authState.userId ? {
    user: { id: authState.userId, email: `${authState.userId}@example.test`, name: "Synthetic" },
    session: { id: "synthetic-session", expiresAt: new Date(Date.now() + 60_000) },
  } : null,
}));

const migrationNames = ["0001_auth.sql", "0002_entitlements_usage.sql", "0003_receipt_ai_flows.sql", "0004_ai_provider_costs.sql",
  "0005_ai_global_guardrails.sql", "0006_contact_submissions.sql", "0007_account_deletion.sql", "0014_guest_ai.sql", "0015_uncounted_provider_errors.sql", "0016_feedback_inbox.sql"];
const origin = "https://kakeimatch.example";
const now = Math.floor(Date.parse("2026-10-08T04:00:00Z") / 1000);
let sqlite: DatabaseSync | undefined;

afterEach(() => { sqlite?.close(); sqlite = undefined; authState.userId = "admin-user"; });

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
  await db.prepare("INSERT INTO admin_audit_log(id,admin_user_id,action,target_type,target_id,created_at) VALUES ('audit1','admin-user','feedback_analyzed','feedback','feedback-open',?)")
    .bind(now - 10).run();
  const env: AdminEnv = { ACCOUNT_DB: db, BETTER_AUTH_SECRET: "synthetic-better-auth-secret-long-enough",
    CLOUD_ACCOUNT_ORIGIN: origin, ADMIN_USER_IDS: "admin-user" };
  return { db, env };
}

const get = (path: string) => new Request(`${origin}${path}`);

describe("admin D1 APIs", () => {
  it("aggregates only account and AI operations metadata and purges expired inbox data", async () => {
    const { db, env } = await setup();
    const options = { nowSeconds: () => now };
    const overview = await handleAdminRequest(get("/api/admin/overview"), env, options);
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

    const costs = await handleAdminRequest(get("/api/admin/ai/costs?month=2026-10"), env, options);
    expect(await costs.json()).toMatchObject({ totalUsdMicros: 350, providers: { gemini: { requests: 1 }, jev: { requests: 1 } } });
    const users = await handleAdminRequest(get("/api/admin/users"), env, options);
    const userBody = await users.json() as { users: Array<{ id: string; kind: string; plan: string; enabled: boolean; createdAt: number }> };
    expect(userBody.users.find(user => user.id === "guest-user")).toMatchObject({ kind: "guest", plan: "guest", enabled: true, createdAt: now - 3600 });
    expect(JSON.stringify(userBody)).not.toContain("@example");
    const audit = await handleAdminRequest(get("/api/admin/audit"), env, options);
    expect(await audit.json()).toMatchObject({ entries: [{ adminUserId: "admin-user", action: "feedback_analyzed", targetId: "feedback-open" }] });
  });

  it("keeps calendar-month costs outside the rolling 30-day window and counts every error group", async () => {
    const { db, env } = await setup();
    const monthEnd = Date.parse("2026-10-31T14:59:00Z") / 1000;
    const monthStart = Date.parse("2026-09-30T15:01:00Z") / 1000;
    await db.prepare(`INSERT INTO ai_provider_cost_events(id,user_id,provider,requested_model,model,estimated_cost_usd_micros,metering_status,dispatched_at)
      VALUES ('month-start','member-user','gemini','model','model',777,'metered',?)`).bind(monthStart).run();
    for (let index = 0; index < 12; index++) await db.prepare(`INSERT INTO ai_provider_cost_events(id,user_id,provider,requested_model,model,metering_status,safe_error_code,dispatched_at)
      VALUES (?,'member-user','gemini','model','model','unknown',?,?)`).bind(`error-${index}`, `safe_code_${index}`, monthEnd - 10).run();
    const response = await handleAdminRequest(get("/api/admin/overview"), env, { nowSeconds: () => monthEnd });
    const data = await response.json() as { ai: { monthUsdMicros: number; last30DaysErrors: number }; recentErrors: unknown[] };
    expect(data.ai.monthUsdMicros).toBe(1127);
    expect(data.ai.last30DaysErrors).toBe(14);
    expect(data.recentErrors).toHaveLength(10);
  });

  it("rejects unauthenticated and non-admin requests and blocks cross-origin mutations", async () => {
    const { env } = await setup();
    authState.userId = null;
    expect((await handleAdminRequest(get("/api/admin/users"), env, { nowSeconds: () => now })).status).toBe(401);
    authState.userId = "member-user";
    const forbidden = await handleAdminRequest(get("/api/admin/users"), env, { nowSeconds: () => now });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("cache-control")).toBe("no-store");
    authState.userId = "admin-user";
    const mutation = new Request(`${origin}/api/admin/feedback/feedback-open/status`, { method: "PATCH",
      headers: { origin: "https://attacker.example", "content-type": "application/json" }, body: JSON.stringify({ status: "resolved" }) });
    expect((await handleAdminRequest(mutation, env, { nowSeconds: () => now })).status).toBe(403);
  });
});
