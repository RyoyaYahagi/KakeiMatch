import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monthKey } from "./receipt-ai-usage";
import { handleRequest, type AccountD1Binding, type GatewayEnv } from "./worker";

const accountState = vi.hoisted(() => ({ session: true, userId: "synthetic-user" }));
vi.mock("./account-auth", () => ({ getAccountSession: vi.fn(async () => accountState.session ? { user: { id: accountState.userId }, session: { id: "session" } } : null) }));
const secret = "synthetic-ai-gateway-signing-secret-for-tests";
const now = Date.parse("2026-09-30T14:59:00Z") / 1000;
const receipt = { documentKind: "receipt", merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: "12:30", totalAmountYen: 3284, taxAmountYen: null, items: [{ name: "Synthetic Item", amountYen: 3284 }], warnings: [] };
const category = { receipt: { merchant: receipt.merchant, totalAmountYen: receipt.totalAmountYen, items: receipt.items } };
const image = { contentType: "image/png", imageBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64") };
const choice = { type: "choice", choice: "food", probabilities: { food: 0.9, household: 0.02, transport: 0.01, medical: 0.01, clothing: 0.01, entertainment: 0.01, utilities: 0.01, communications: 0.01, other: 0.02 }, confidence: 0.9 };
const jev = { model: "jev-latest", answers: { item_0: choice } };
const origin = "https://kakeimatch-pr-60.workers.dev";
function bearer(user = "synthetic-user", at = now, claims = {}) {
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ sub: user, aud: "kakeimatch-ai", iat: at, exp: at + 300, ...claims })).toString("base64url");
  return `Bearer ${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
function request(stage: string, body: unknown, token = bearer(), headers = {}) {
  return new Request(`${origin}/api/ai/${stage}`, { method: "POST", headers: { origin, authorization: token, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const fetchOk = (value: unknown, status = 200): typeof fetch => vi.fn(async () => Response.json(value, { status })) as typeof fetch;
const migrations = ["0001_auth.sql", "0002_entitlements_usage.sql", "0003_receipt_ai_flows.sql", "0004_ai_provider_costs.sql"].map(name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
function sqliteDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) sqlite.exec(migration);
  const db: AccountD1Binding = {
    async batch<T>(): Promise<T[]> { throw new Error("batch not used by flow tests"); },
    prepare(sql: string) {
      let params: SQLInputValue[] = [];
      const statement = {
        bind(...args: unknown[]) { params = args as SQLInputValue[]; return statement; },
        async first<T>() { return sqlite.prepare(sql).get(...params) as T | undefined ?? null; },
        async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }; },
      };
      return statement;
    },
  };
  return { db, dispose: async () => sqlite.close() };
}

it("uses Tokyo month buckets across year and leap-year boundaries", () => {
  expect(monthKey(Date.parse("2026-12-31T14:59:59Z") / 1000)).toBe("2026-12");
  expect(monthKey(Date.parse("2026-12-31T15:00:00Z") / 1000)).toBe("2027-01");
  expect(monthKey(Date.parse("2028-02-29T15:00:00Z") / 1000)).toBe("2028-03");
});

describe.each(["SQLite", "D1"])("AI gateway receipt flows with %s", mode => {
  let db: AccountD1Binding;
  let dispose: () => Promise<void>;
  let env: GatewayEnv;
  beforeEach(async () => {
    accountState.session = true;
    accountState.userId = "synthetic-user";
    if (mode === "D1") {
      const instance = new Miniflare({ script: "export default { fetch() { return new Response('ok'); } }", modules: true, compatibilityDate: "2026-09-30", d1Databases: { ACCOUNT_DB: "ai-flow-test" } });
      dispose = () => instance.dispose();
      const d1 = await instance.getD1Database("ACCOUNT_DB");
      db = d1;
      for (const migration of migrations) await d1.exec(migration.replace(/^--.*$/gm, "").replace(/\s+/g, " "));
    } else { ({ db, dispose } = sqliteDb()); }
    for (const user of ["synthetic-user", "other-user"]) await db.prepare("INSERT INTO user(id, name, email, createdAt, updatedAt) VALUES (?, 'Test', ?, 0, 0)").bind(user, `${user}@example.invalid`).run();
    env = { ACCOUNT_DB: db, AI_GATEWAY_AUTH_SECRET: secret, BETTER_AUTH_SECRET: "synthetic-auth-secret", GEMINI_API_KEY: "synthetic-gemini-key", TYPESAFE_API_KEY: "synthetic-jev-key", AI_USER_RATE_LIMIT: { limit: vi.fn(async () => ({ success: true })) } };
  });
  afterEach(async () => { await dispose(); });
  const options = (fetchImpl = fetchOk({ output_text: JSON.stringify(receipt) }), at = now) => ({ fetchImpl, nowSeconds: () => at });
  const gemini = (flowId = crypto.randomUUID(), at = now, provider?: typeof fetch) => handleRequest(request("gemini", { ...image, flowId }, bearer("synthetic-user", at)), env, options(provider, at));
  const usage = async (at = now) => (await handleRequest(new Request(`${origin}/api/ai/usage`), env, options(undefined, at))).json();
  const costs = async (month: string, at = now) => (await handleRequest(new Request(`${origin}/api/ai/costs?month=${month}`), env, options(undefined, at))).json();

  it("counts Gemini and its validated Jev continuation once, including retries at quota", async () => {
    env.AI_FREE_MONTHLY_LIMIT = "1";
    const flowId = crypto.randomUUID();
    expect((await gemini(flowId)).status).toBe(200);
    expect((await gemini(flowId)).status).toBe(200);
    const provider = fetchOk(jev);
    for (let i = 0; i < 2; i++) expect((await handleRequest(request("jev", { ...category, flowId }), env, options(provider))).status).toBe(200);
    expect(await usage()).toMatchObject({ used: 1, remaining: 0, limit: 1, month: "2026-09" });
    expect((await gemini()).status).toBe(429);
  });
  it("counts an explicit reanalysis as a new flow and reports the default Free 30", async () => {
    expect((await gemini()).status).toBe(200);
    expect((await gemini()).status).toBe(200);
    expect(await usage()).toMatchObject({ used: 2, limit: 30, remaining: 28, plan: "free" });
  });
  it("reserves quota atomically under concurrent distinct and duplicate flows", async () => {
    env.AI_FREE_MONTHLY_LIMIT = "2";
    const results = await Promise.all(Array.from({ length: 8 }, () => gemini()));
    expect(results.filter(result => result.status === 200)).toHaveLength(2);
    expect(results.filter(result => result.status === 429)).toHaveLength(6);
    expect(await usage()).toMatchObject({ used: 2 });
    const flowId = crypto.randomUUID();
    env.AI_FREE_MONTHLY_LIMIT = "3";
    const duplicates = await Promise.all([gemini(flowId), gemini(flowId)]);
    expect(duplicates.map(result => result.status)).toEqual([200, 200]);
    expect(await usage()).toMatchObject({ used: 3 });
  });
  it("resets at midnight in Asia/Tokyo and keeps a cross-month continuation in its starting month", async () => {
    const flowId = crypto.randomUUID();
    expect((await gemini(flowId)).status).toBe(200);
    const midnight = now + 60;
    expect(await usage(midnight)).toMatchObject({ month: "2026-10", used: 0, remaining: 30 });
    expect((await handleRequest(request("jev", { ...category, flowId }, bearer("synthetic-user", midnight)), env, options(fetchOk(jev), midnight))).status).toBe(200);
    expect((await gemini(flowId, midnight)).status).toBe(200);
    expect(await usage(midnight)).toMatchObject({ used: 0 });
    expect((await gemini(crypto.randomUUID(), midnight)).status).toBe(200);
    expect(await usage(midnight)).toMatchObject({ used: 1 });
    expect(await usage()).toMatchObject({ used: 1 });
  });
  it("keeps Family unlimited and respects zero-limit entitlements", async () => {
    await db.prepare("INSERT INTO account_entitlements(user_id, plan, monthly_ai_limit) VALUES (?, 'free', 0)").bind("synthetic-user").run();
    expect((await gemini()).status).toBe(429);
    expect(await usage()).toMatchObject({ used: 0, remaining: 0 });
    await db.prepare("UPDATE account_entitlements SET plan = 'family', monthly_ai_limit = NULL WHERE user_id = ?").bind("synthetic-user").run();
    env.AI_FREE_MONTHLY_LIMIT = "1";
    for (let i = 0; i < 3; i++) expect((await gemini()).status).toBe(200);
    expect(await usage()).toMatchObject({ plan: "family", used: 3, limit: null, remaining: null });
  });
  it("never reports negative remaining when a finite plan is lowered", async () => {
    await gemini();
    await gemini();
    await db.prepare("INSERT INTO account_entitlements VALUES (?, 'pro', 1, 0)").bind("synthetic-user").run();
    expect(await usage()).toMatchObject({ plan: "pro", used: 2, remaining: 0, limit: 1 });
    expect((await gemini()).status).toBe(429);
  });
  it("does not add legacy provider rows to new usage, even in the cutover month", async () => {
    await db.prepare("INSERT INTO ai_usage VALUES (?, '2026-09', 40, 25)").bind("synthetic-user").run();
    expect(await usage()).toMatchObject({ used: 0, remaining: 30 });
    expect((await gemini()).status).toBe(200);
    expect(await usage()).toMatchObject({ used: 1, remaining: 29 });
  });
  it("binds the flow to the user, image and server-validated category facts", async () => {
    const flowId = crypto.randomUUID();
    const provider = fetchOk(jev);
    expect((await handleRequest(request("jev", { ...category, flowId }), env, options(provider))).status).toBe(409);
    expect((await gemini(flowId)).status).toBe(200);
    const changed = { ...image, imageBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]).toString("base64"), flowId };
    expect((await handleRequest(request("gemini", changed), env, options(provider))).status).toBe(409);
    expect((await handleRequest(request("jev", { receipt: { ...category.receipt, merchant: "Different Shop" }, flowId }), env, options(provider))).status).toBe(409);
    expect((await handleRequest(request("jev", { ...category, flowId }, bearer("other-user")), env, options(provider))).status).toBe(409);
    expect(await usage()).toMatchObject({ used: 1 });
    expect(provider).not.toHaveBeenCalled();
    const row = await db.prepare("SELECT image_mac, category_mac FROM ai_receipt_flows").bind().first<{ image_mac: string; category_mac: string }>();
    expect(row?.image_mac).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.category_mac).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain("Synthetic");
  });
  it("limits replay to three attempts per stage and expires image retries after ten minutes", async () => {
    const flowId = crypto.randomUUID();
    for (let i = 0; i < 3; i++) expect((await gemini(flowId)).status).toBe(200);
    expect((await gemini(flowId)).status).toBe(409);
    for (let i = 0; i < 3; i++) expect((await handleRequest(request("jev", { ...category, flowId }), env, options(fetchOk(jev)))).status).toBe(200);
    expect((await handleRequest(request("jev", { ...category, flowId }), env, options(fetchOk(jev)))).status).toBe(409);
    const expiring = crypto.randomUUID();
    await gemini(expiring);
    expect((await gemini(expiring, now + 600)).status).toBe(409);
    expect(await usage()).toMatchObject({ used: 2 });
  });
  it("allows a delayed category suggestion for saved extraction without another AI use", async () => {
    const flowId = crypto.randomUUID();
    await gemini(flowId);
    const later = now + 60 * 60;
    const response = await handleRequest(request("jev", { ...category, flowId }, bearer("synthetic-user", later)), env, options(fetchOk(jev), later));
    expect(response.status).toBe(200);
    expect(await usage()).toMatchObject({ used: 1 });
    const expiry = now + 30 * 24 * 60 * 60;
    const expiredProvider = fetchOk(jev);
    expect((await handleRequest(request("jev", { ...category, flowId }, bearer("synthetic-user", expiry)), env, options(expiredProvider, expiry))).status).toBe(409);
    expect(expiredProvider).not.toHaveBeenCalled();
  });
  it("counts provider failures once and permits the same-flow recovery", async () => {
    const flowId = crypto.randomUUID();
    expect((await gemini(flowId, now, fetchOk({ detail: "private provider error" }, 500))).status).toBe(503);
    expect((await gemini(flowId)).status).toBe(200);
    expect(await usage()).toMatchObject({ used: 1 });
    const failedJev = await handleRequest(request("jev", { ...category, flowId }), env, options(fetchOk({ private: true }, 500)));
    expect(failedJev.status).toBe(503);
    expect(await failedJev.text()).not.toContain("private");
    expect((await handleRequest(request("jev", { ...category, flowId }), env, options(fetchOk(jev)))).status).toBe(200);
    expect(await usage()).toMatchObject({ used: 1 });
  });
  it("persists one metering snapshot for every dispatched retry and keeps rejected requests out", async () => {
    const flowId = crypto.randomUUID();
    const interaction = {
      status: "completed",
      modelVersion: "gemini-3.5-flash-lite",
      usage: { total_input_tokens: 10, total_output_tokens: 5, total_thought_tokens: 2, total_cached_tokens: 0, total_tokens: 17 },
      steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(receipt) }] }],
    };
    const provider = fetchOk(interaction);
    expect((await gemini(flowId, now, provider)).status).toBe(200);
    expect((await gemini(flowId, now, provider)).status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(2);
    // Aggregate both event rows to verify retries create independent snapshots.
    const summary = await db.prepare("SELECT COUNT(*) AS requests, SUM(input_tokens) AS input_tokens, SUM(total_tokens) AS total_tokens, SUM(estimated_cost_usd_micros) AS cost, SUM(CASE WHEN model='gemini-3.5-flash-lite' THEN 1 ELSE 0 END) AS actual_model_rows, SUM(CASE WHEN pricing_version='2026-10-02-gemini-standard' THEN 1 ELSE 0 END) AS priced_rows FROM ai_provider_cost_events WHERE flow_id=?")
      .bind(flowId).first<{ requests: number; input_tokens: number; total_tokens: number; cost: number; actual_model_rows: number; priced_rows: number }>();
    expect(summary).toEqual({ requests: 2, input_tokens: 20, total_tokens: 34, cost: 42, actual_model_rows: 2, priced_rows: 2 });

    const invalid = await handleRequest(request("gemini", { ...image, imageBase64: "bad", flowId: crypto.randomUUID() }), env, options(provider));
    expect(invalid.status).toBe(400);
    expect(provider).toHaveBeenCalledTimes(2);
    const count = await db.prepare("SELECT COUNT(*) AS requests FROM ai_provider_cost_events").bind().first<{ requests: number }>();
    expect(count?.requests).toBe(2);
  });
  it("uses actual Gemini GenerateContent metadata and preserves Jev's versioned model", async () => {
    const geminiFlow = crypto.randomUUID();
    const generateContent = {
      model: "gemini-3.5-flash-lite",
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 2, cachedContentTokenCount: 0, totalTokenCount: 18 },
      output_text: JSON.stringify(receipt),
    };
    expect((await gemini(geminiFlow, now, fetchOk(generateContent))).status).toBe(200);
    const jevFlow = crypto.randomUUID();
    expect((await gemini(jevFlow)).status).toBe(200);
    const versionedJev = { model: "jev-1.13.0", answers: { item_0: choice }, usage: { input_tokens: 20, output_tokens: 3 } };
    expect((await handleRequest(request("jev", { ...category, flowId: jevFlow }), env, options(fetchOk(versionedJev)))).status).toBe(200);
    const geminiRow = await db.prepare("SELECT model, input_tokens, output_tokens, thinking_tokens, total_tokens, metering_status FROM ai_provider_cost_events WHERE flow_id=?")
      .bind(geminiFlow).first<{ model: string; input_tokens: number; output_tokens: number; thinking_tokens: number; total_tokens: number; metering_status: string }>();
    expect(geminiRow).toEqual({ model: "gemini-3.5-flash-lite", input_tokens: 12, output_tokens: 4, thinking_tokens: 2, total_tokens: 18, metering_status: "metered" });
    const jevRow = await db.prepare("SELECT requested_model, model, pricing_version, input_tokens, output_tokens, total_tokens, metering_status FROM ai_provider_cost_events WHERE flow_id=? AND provider='jev'")
      .bind(jevFlow).first<{ requested_model: string; model: string; pricing_version: string; input_tokens: number; output_tokens: number; total_tokens: number; metering_status: string }>();
    expect(jevRow).toEqual({ requested_model: "jev-latest", model: "jev-1.13.0", pricing_version: "2026-10-02-jev-1.13", input_tokens: 20, output_tokens: 3, total_tokens: 23, metering_status: "metered" });
  });
  it("keeps provider failures and missing usage unknown with safe operational metadata only", async () => {
    const failedFlow = crypto.randomUUID();
    expect((await gemini(failedFlow, now, fetchOk({ detail: "private receipt and provider response" }, 500))).status).toBe(503);
    const noUsageFlow = crypto.randomUUID();
    const noUsage = { model: "gemini-3.5-flash-lite", output_text: JSON.stringify(receipt), private: "should not persist" };
    expect((await gemini(noUsageFlow, now, fetchOk(noUsage))).status).toBe(200);
    const failedRow = await db.prepare("SELECT metering_status, safe_error_code, estimated_cost_usd_micros FROM ai_provider_cost_events WHERE flow_id=?")
      .bind(failedFlow).first<{ metering_status: string; safe_error_code: string; estimated_cost_usd_micros: number | null }>();
    expect(failedRow).toEqual({ metering_status: "unknown", safe_error_code: "provider_http_500", estimated_cost_usd_micros: null });
    const unknownRow = await db.prepare("SELECT metering_status, safe_error_code, estimated_cost_usd_micros FROM ai_provider_cost_events WHERE flow_id=?")
      .bind(noUsageFlow).first<{ metering_status: string; safe_error_code: string; estimated_cost_usd_micros: number | null }>();
    expect(unknownRow).toEqual({ metering_status: "unknown", safe_error_code: "usage_or_pricing_unknown", estimated_cost_usd_micros: null });
    const timeoutFlow = crypto.randomUUID();
    const timeout = vi.fn(async () => { throw new Error("private timeout detail"); }) as typeof fetch;
    expect((await gemini(timeoutFlow, now, timeout)).status).toBe(504);
    const timeoutRow = await db.prepare("SELECT metering_status, safe_error_code, estimated_cost_usd_micros FROM ai_provider_cost_events WHERE flow_id=?")
      .bind(timeoutFlow).first<{ metering_status: string; safe_error_code: string; estimated_cost_usd_micros: number | null }>();
    expect(timeoutRow).toEqual({ metering_status: "unknown", safe_error_code: "provider_timeout", estimated_cost_usd_micros: null });
    const persisted = await db.prepare("SELECT * FROM ai_provider_cost_events ORDER BY dispatched_at").bind().first<Record<string, unknown>>();
    expect(JSON.stringify(persisted)).not.toContain("Synthetic Shop");
    expect(JSON.stringify(persisted)).not.toContain("private receipt");
    expect(JSON.stringify(persisted)).not.toContain("should not persist");
    expect(Object.keys(persisted ?? {}).sort()).toEqual([
      "billing_mode", "cached_input_tokens", "completed_at", "dispatched_at", "estimated_cost_usd_micros", "flow_id", "id", "input_tokens", "input_usd_per_million_micros", "metering_status", "model", "output_tokens", "output_usd_per_million_micros", "pricing_version", "provider", "requested_model", "safe_error_code", "thinking_tokens", "total_tokens", "user_id",
    ].sort());
  });
  it("isolates monthly costs by authenticated user and Tokyo dispatch month", async () => {
    const flowId = crypto.randomUUID();
    const metered = { modelVersion: "gemini-3.5-flash-lite", usage: { total_input_tokens: 1, total_output_tokens: 0, total_thought_tokens: 0, total_cached_tokens: 0, total_tokens: 1 }, output_text: JSON.stringify(receipt) };
    expect((await gemini(flowId, now, fetchOk(metered))).status).toBe(200);
    const october = now + 60;
    expect((await gemini(crypto.randomUUID(), october, fetchOk(metered))).status).toBe(200);
    expect(await costs("2026-09", now)).toMatchObject({ totalUsdMicros: 1, unknownRequests: 0, providers: { gemini: { requests: 1, inputTokens: 1 } } });
    expect(await costs("2026-10", october)).toMatchObject({ totalUsdMicros: 1, unknownRequests: 0, providers: { gemini: { requests: 1, inputTokens: 1 } } });
    accountState.userId = "other-user";
    const otherUserCosts = await handleRequest(new Request(`${origin}/api/ai/costs?month=2026-09&userId=synthetic-user`), env, options());
    expect(await otherUserCosts.json()).toMatchObject({ totalUsdMicros: 0, unknownRequests: 0, providers: { gemini: { requests: 0, inputTokens: 0 } } });
    accountState.userId = "synthetic-user";
    expect((await handleRequest(new Request(`${origin}/api/ai/costs?month=2026-13`), env, options())).status).toBe(400);
    accountState.session = false;
    expect((await handleRequest(new Request(`${origin}/api/ai/costs?month=2026-09`), env, options())).status).toBe(401);
  });
  it("rejects unsafe monthly sums rather than returning rounded token counts", async () => {
    for (let i = 0; i < 2; i++) {
      const provider = fetchOk({ model: "gemini-3.5-flash-lite", output_text: JSON.stringify(receipt), usageMetadata: { promptTokenCount: Number.MAX_SAFE_INTEGER, candidatesTokenCount: 0, totalTokenCount: Number.MAX_SAFE_INTEGER } });
      expect((await gemini(crypto.randomUUID(), now, provider)).status).toBe(200);
    }
    expect((await handleRequest(new Request(`${origin}/api/ai/costs?month=2026-09`), env, options())).status).toBe(503);
  });
  it("does not count malformed, missing-flow, unauthorized or unconfigured requests", async () => {
    expect((await handleRequest(request("gemini", image), env, options())).status).toBe(400);
    expect((await handleRequest(request("gemini", { ...image, flowId: crypto.randomUUID(), imageBase64: "bad" }), env, options())).status).toBe(400);
    expect((await handleRequest(request("gemini", { ...image, flowId: crypto.randomUUID() }, "Bearer invalid"), env, options())).status).toBe(401);
    env.GEMINI_API_KEY = undefined;
    expect((await gemini()).status).toBe(503);
    expect(await usage()).toMatchObject({ used: 0 });
  });
  it("maintains the separate per-user/provider rate limit for retries and Family", async () => {
    const flowId = crypto.randomUUID();
    await gemini(flowId);
    await db.prepare("INSERT INTO account_entitlements VALUES (?, 'family', NULL, 0)").bind("synthetic-user").run();
    const limit = vi.fn(async () => ({ success: false }));
    env.AI_USER_RATE_LIMIT = { limit };
    const provider = fetchOk(jev);
    expect((await gemini(flowId, now, provider)).status).toBe(429);
    expect((await handleRequest(request("jev", { ...category, flowId }), env, options(provider))).status).toBe(429);
    expect(limit.mock.calls).toEqual([[{ key: "synthetic-user:gemini" }], [{ key: "synthetic-user:jev" }]]);
    expect(provider).not.toHaveBeenCalled();
    env.AI_USER_RATE_LIMIT = undefined;
    expect((await gemini(flowId)).status).toBe(503);
  });
  it("validates provider results and sends only allowed category facts", async () => {
    const flowId = crypto.randomUUID();
    expect((await gemini(flowId, now, fetchOk({ output_text: JSON.stringify({ ...receipt, totalAmountYen: 1.5 }) }))).status).toBe(502);
    expect((await handleRequest(request("jev", { ...category, flowId }), env, options(fetchOk(jev)))).status).toBe(409);
    const extracted = await gemini(flowId);
    expect(await extracted.json()).toEqual(receipt);
    const provider = fetchOk(jev);
    const response = await handleRequest(request("jev", { receipt: { ...category.receipt, ignored: "drop" }, flowId }), env, options(provider));
    expect(await response.json()).toEqual(jev);
    const [, init] = vi.mocked(provider).mock.calls[0];
    expect(JSON.parse(String(init?.body)).state).toEqual(category);
    const malformed = await handleRequest(request("jev", { ...category, flowId }), env, options(fetchOk({ model: "jev-latest", answers: { item_0: { ...choice, unexpected: true } } })));
    expect(malformed.status).toBe(502);
  });
  it("classifies every item in one Jev call and rejects incomplete indexed answers", async () => {
    const flowId = crypto.randomUUID();
    const twoItems = { receipt: { ...category.receipt, items: [...category.receipt.items, { name: "Synthetic Tea", amountYen: 400 }] }, flowId };
    const twoItemReceipt = { ...receipt, items: twoItems.receipt.items };
    const extracted = await handleRequest(request("gemini", { ...image, flowId }), env, options(fetchOk({ output_text: JSON.stringify(twoItemReceipt) })));
    expect(extracted.status).toBe(200);
    const second = { ...choice, choice: "household" };
    const provider = fetchOk({ model: "jev-latest", answers: { item_0: choice, item_1: second } });
    const response = await handleRequest(request("jev", twoItems), env, options(provider));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ model: "jev-latest", answers: { item_0: choice, item_1: second } });
    expect(provider).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(provider).mock.calls[0];
    expect(Object.keys(JSON.parse(String(init?.body)).questions)).toEqual(["item_0", "item_1"]);
    const incomplete = await handleRequest(request("jev", twoItems), env, options(fetchOk({ model: "jev-latest", answers: { item_0: choice } })));
    expect(incomplete.status).toBe(502);
  });
  it("sends only requested unresolved items with original indexes and validates custom category choices", async () => {
    const flowId = crypto.randomUUID();
    const items = [
      { name: "Synthetic Bread", amountYen: 300 },
      { name: "Synthetic Soap", amountYen: 500 },
      { name: "Synthetic Apples", amountYen: 700 },
    ];
    const receiptBody = { receipt: { ...category.receipt, items }, flowId };
    expect((await gemini(flowId, now, fetchOk({ output_text: JSON.stringify({ ...receipt, items }) }))).status).toBe(200);
    const choices = [{ id: "groceries", name: "食料品" }, { id: "home", name: "住まい用品" }];
    const customAnswer = { type: "choice", choice: "home", probabilities: { groceries: 0.1, home: 0.9 }, confidence: 0.9 };
    const provider = fetchOk({ model: "jev-latest", answers: { item_2: customAnswer } });
    const response = await handleRequest(request("jev", { ...receiptBody, itemIndexes: [2], categories: choices }), env, options(provider));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ model: "jev-latest", answers: { item_2: customAnswer } });
    const [, init] = vi.mocked(provider).mock.calls[0];
    const payload = JSON.parse(String(init?.body));
    expect(payload.state.receipt.items).toEqual([items[2]]);
    expect(payload.state.receipt).toMatchObject({ merchant: receiptBody.receipt.merchant, totalAmountYen: receiptBody.receipt.totalAmountYen });
    expect(Object.keys(payload.questions)).toEqual(["item_2"]);
    expect(payload.questions.item_2.instructions).toContain("state.receipt.items[0]");
    expect(payload.questions.item_2.criteria).toEqual({ groceries: "食料品", home: "住まい用品" });
    expect(JSON.stringify(payload)).not.toContain("Synthetic Bread");
    expect(JSON.stringify(payload)).not.toContain("Synthetic Soap");
  });
  it("rejects invalid item indexes and invalid custom category lists before calling Jev", async () => {
    const flowId = crypto.randomUUID();
    const body = { ...category, flowId };
    const provider = fetchOk(jev);
    const invalidBodies = [
      { ...body, itemIndexes: [] },
      { ...body, itemIndexes: [0, 0] },
      { ...body, itemIndexes: [1] },
      { ...body, itemIndexes: [0.5] },
      { ...body, categories: [] },
      { ...body, categories: [{ id: "same", name: "One" }, { id: "same", name: "Two" }] },
      { ...body, categories: [{ id: "food", name: "Food", extra: true }] },
    ];
    for (const invalid of invalidBodies) expect((await handleRequest(request("jev", invalid), env, options(provider))).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });
  it("supports a merchant-only category question and rejects answers outside declared categories", async () => {
    const flowId = crypto.randomUUID();
    const merchantOnly = { receipt: { merchant: "Synthetic Cafe", totalAmountYen: 900, items: [] }, flowId, categories: [{ id: "meals", name: "外食" }] };
    expect((await gemini(flowId, now, fetchOk({ output_text: JSON.stringify({ ...receipt, merchant: "Synthetic Cafe", totalAmountYen: 900, items: [] }) }))).status).toBe(200);
    const answer = { type: "choice", choice: "food", probabilities: { food: 1 }, confidence: 1 };
    const response = await handleRequest(request("jev", merchantOnly), env, options(fetchOk({ model: "jev-latest", answers: { category: answer } })));
    expect(response.status).toBe(502);
    const validAnswer = { type: "choice", choice: "meals", probabilities: { meals: 1 }, confidence: 1 };
    const provider = fetchOk({ model: "jev-latest", answers: { category: validAnswer } });
    expect((await handleRequest(request("jev", merchantOnly), env, options(provider))).status).toBe(200);
    const [, init] = vi.mocked(provider).mock.calls[0];
    expect(JSON.parse(String(init?.body)).state).toEqual({ receipt: merchantOnly.receipt });
    expect(Object.keys(JSON.parse(String(init?.body)).questions)).toEqual(["category"]);
    expect((await handleRequest(request("jev", merchantOnly), env, options(fetchOk({ model: "jev-latest", answers: { category: validAnswer }, extra: true })))).status).toBe(200);
  });
  it("extracts receipt JSON from the current Gemini Interactions REST response", async () => {
    const flowId = crypto.randomUUID();
    const currentRestResponse = {
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(receipt) }] }],
    };
    const response = await gemini(flowId, now, fetchOk(currentRestResponse));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(receipt);
    expect(await usage()).toMatchObject({ used: 1 });
  });
  it("requires same origin, signed AI audience and an account session for token/usage", async () => {
    expect((await handleRequest(request("gemini", { ...image, flowId: crypto.randomUUID() }, bearer(), { origin: "https://attacker.invalid" }), env, options())).status).toBe(403);
    for (const claims of [{ exp: now }, { exp: now + 901 }, { aud: "other" }]) expect((await handleRequest(request("gemini", image, bearer("synthetic-user", now, claims)), env, options())).status).toBe(401);
    accountState.session = false;
    expect((await handleRequest(new Request(`${origin}/api/ai/usage`), env, options())).status).toBe(401);
    expect((await handleRequest(request("token", {}), env, options())).status).toBe(401);
    accountState.session = true;
    const token = await handleRequest(request("token", { userId: "attacker" }), env, options());
    const body = await token.json() as { token: string; expiresAt: number };
    expect(JSON.parse(Buffer.from(body.token.split(".")[1], "base64url").toString())).toMatchObject({ sub: "synthetic-user", aud: "kakeimatch-ai" });
    expect(body.expiresAt).toBe(now + 600);
  });
  it("rejects oversized requests and converts timeouts into safe errors", async () => {
    const tooLarge = request("gemini", image, bearer(), { "content-length": "10000000" });
    expect((await handleRequest(tooLarge, env, options())).status).toBe(413);
    const timeout = vi.fn(async () => { throw new Error("private timeout"); }) as typeof fetch;
    expect((await gemini(crypto.randomUUID(), now, timeout)).status).toBe(504);
  });
});
