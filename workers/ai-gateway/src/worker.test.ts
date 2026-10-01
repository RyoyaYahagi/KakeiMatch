import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monthKey } from "./receipt-ai-usage";
import { handleRequest, type AccountD1Binding, type GatewayEnv } from "./worker";

const accountState = vi.hoisted(() => ({ session: true }));
vi.mock("./account-auth", () => ({ getAccountSession: vi.fn(async () => accountState.session ? { user: { id: "synthetic-user" }, session: { id: "session" } } : null) }));
const secret = "synthetic-ai-gateway-signing-secret-for-tests";
const now = Date.parse("2026-09-30T14:59:00Z") / 1000;
const receipt = { documentKind: "receipt", merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: "12:30", totalAmountYen: 3284, taxAmountYen: null, items: [{ name: "Synthetic Item", amountYen: 3284 }], warnings: [] };
const category = { receipt: { merchant: receipt.merchant, totalAmountYen: receipt.totalAmountYen, items: receipt.items } };
const image = { contentType: "image/png", imageBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64") };
const jev = { model: "jev-latest", answers: { category: { type: "choice", choice: "food", probabilities: { food: 0.9, household: 0.02, transport: 0.01, medical: 0.01, clothing: 0.01, entertainment: 0.01, utilities: 0.01, communications: 0.01, other: 0.02 }, confidence: 0.9 } } };
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
const migrations = ["0001_auth.sql", "0002_entitlements_usage.sql", "0003_receipt_ai_flows.sql"].map(name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
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
    const provider = fetchOk({ ...jev, extra: "private" });
    const response = await handleRequest(request("jev", { receipt: { ...category.receipt, ignored: "drop" }, flowId }), env, options(provider));
    expect(await response.json()).toEqual(jev);
    const [, init] = vi.mocked(provider).mock.calls[0];
    expect(JSON.parse(String(init?.body)).state).toEqual(category);
    const malformed = await handleRequest(request("jev", { ...category, flowId }), env, options(fetchOk({ model: "jev-latest", answers: {} })));
    expect(malformed.status).toBe(502);
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
