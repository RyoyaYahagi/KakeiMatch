import { createHmac } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { handleRequest, type AccountD1Binding, type GatewayEnv } from "./worker";

const accountState = vi.hoisted(() => ({ session: true }));
vi.mock("./account-auth", () => ({ getAccountSession: vi.fn(async () => accountState.session ? { user: { id: "synthetic-user", email: "test@example.invalid", name: "Test" }, session: { id: "session", expiresAt: new Date() } } : null) }));

const secret = "synthetic-ai-gateway-signing-secret-for-tests";
const now = 1_800_000_000;
const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");
function bearer(sub = "synthetic-user", claims: Record<string, unknown> = {}): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ sub, aud: "kakeimatch-ai", iat: now, exp: now + 300, ...claims }));
  const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  return `Bearer ${head}.${body}.${b64url(signature)}`;
}
function makeRequest(path: string, body: unknown, authorization = bearer(), headers: Record<string, string> = {}): Request {
  const url = `https://kakeimatch-pr-36.workers.dev${path}`;
  return new Request(url, { method: "POST", headers: { origin: new URL(url).origin, "content-type": "application/json", authorization, ...headers }, body: JSON.stringify(body) });
}
function fakeDb() {
  const counts = new Map<string, { gemini: number; jev: number }>();
  const plans = new Map<string, { plan: string; monthlyAiLimit: number | null }>();
  return {
    counts, plans,
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) { params = args; return statement; },
        async first() {
          if (sql.includes("FROM account_entitlements")) return plans.get(String(params[0])) ?? null;
          if (sql.includes("FROM ai_usage")) return counts.get(`${params[0]}:${params[1]}`) ?? null;
          return null;
        },
        async run() {
          const [, month, g, j, , , defaultLimit] = params;
          const key = `${params[0]}:${month}`;
          const current = counts.get(key) ?? { gemini: 0, jev: 0 };
          const plan = plans.get(String(params[0]));
          const limit = plan ? plan.monthlyAiLimit : Number(defaultLimit);
          if (limit !== null && current.gemini + current.jev >= limit) return { meta: { changes: 0 } };
          counts.set(key, { gemini: current.gemini + Number(g), jev: current.jev + Number(j) });
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
}
function sqliteDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE account_entitlements (user_id TEXT PRIMARY KEY, plan TEXT NOT NULL, monthly_ai_limit INTEGER);
    CREATE TABLE ai_usage (user_id TEXT NOT NULL, month TEXT NOT NULL, gemini_used INTEGER NOT NULL DEFAULT 0, jev_used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, month));`);
  return {
    sqlite,
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) { params = args; return statement; },
        async first<T>() { return sqlite.prepare(sql).get(...params as SQLInputValue[]) as T | undefined ?? null; },
        async run() {
          const result = sqlite.prepare(sql).run(...params as SQLInputValue[]);
          return { meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
  };
}
function env(overrides: Partial<GatewayEnv> = {}): GatewayEnv {
  return { AI_GATEWAY_AUTH_SECRET: secret, BETTER_AUTH_SECRET: "synthetic-auth-secret-for-tests", ACCOUNT_DB: fakeDb() as unknown as AccountD1Binding, GEMINI_API_KEY: "synthetic-gemini-key", TYPESAFE_API_KEY: "synthetic-jev-key", AI_USER_RATE_LIMIT: { limit: vi.fn(async () => ({ success: true })) }, ...overrides };
}
const fetchOk = (value: unknown, status = 200): typeof fetch => vi.fn(async () => Response.json(value, { status })) as typeof fetch;
const receipt = { documentKind: "receipt", merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: "12:30", totalAmountYen: 3284, taxAmountYen: null, items: [{ name: "Synthetic Item", amountYen: 3284 }], warnings: [] };
const jev = { model: "jev-latest", answers: { category: { type: "choice", choice: "food", probabilities: { food: 0.9, household: 0.02, transport: 0.01, medical: 0.01, clothing: 0.01, entertainment: 0.01, utilities: 0.01, communications: 0.01, other: 0.02 }, confidence: 0.9 } } };

describe("AI gateway", () => {
  it("issues an AI-only token from the authenticated session and supports silent renewal", async () => {
    accountState.session = true;
    const response = await handleRequest(new Request("https://kakeimatch-pr-36.workers.dev/api/ai/token", { method: "POST", headers: { origin: "https://kakeimatch-pr-36.workers.dev", "content-type": "application/json" }, body: JSON.stringify({ sub: "attacker-selected-user", userId: "attacker-selected-user" }) }), env(), { nowSeconds: () => now });
    expect(response.status).toBe(200);
    const result = await response.json() as { token: string; expiresAt: number };
    const [, payload] = result.token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    expect(claims).toMatchObject({ aud: "kakeimatch-ai", sub: "synthetic-user", iat: now, exp: now + 600 });
    expect(result.expiresAt).toBe(now + 600);
    expect((await handleRequest(new Request("https://kakeimatch-pr-36.workers.dev/api/ai/token", { method: "POST", headers: { origin: "https://kakeimatch-pr-36.workers.dev" } }), env(), { nowSeconds: () => now + 601 })).status).toBe(200);
  });

  it("requires an account session for AI token and usage routes", async () => {
    accountState.session = false;
    const token = await handleRequest(new Request("https://kakeimatch-pr-36.workers.dev/api/ai/token", { method: "POST", headers: { origin: "https://kakeimatch-pr-36.workers.dev" } }), env(), { nowSeconds: () => now });
    expect(token.status).toBe(401);
    const usage = await handleRequest(new Request("https://kakeimatch-pr-36.workers.dev/api/ai/usage"), env(), { nowSeconds: () => now });
    expect(usage.status).toBe(401);
    accountState.session = true;
  });

  it("reports free and family entitlement usage", async () => {
    const free = env();
    const response = await handleRequest(new Request("https://kakeimatch-pr-36.workers.dev/api/ai/usage"), free, { nowSeconds: () => now });
    expect(await response.json()).toMatchObject({ plan: "free", used: 0, limit: 30, remaining: 30, month: "2027-01" });
    const db = fakeDb();
    db.plans.set("synthetic-user", { plan: "family", monthlyAiLimit: null });
    db.counts.set("synthetic-user:2027-01", { gemini: 4, jev: 3 });
    const family = await handleRequest(new Request("https://kakeimatch-pr-36.workers.dev/api/ai/usage"), env({ ACCOUNT_DB: db as unknown as AccountD1Binding }), { nowSeconds: () => now });
    expect(await family.json()).toMatchObject({ plan: "family", used: 7, limit: null, remaining: null });
  });

  it("applies monthly quota before provider calls while preserving family unlimited", async () => {
    const db = fakeDb();
    const provider = fetchOk({ ...jev });
    const first = await handleRequest(makeRequest("/api/ai/jev", { receipt: { merchant: "Shop", totalAmountYen: 50, items: [] } }), env({ ACCOUNT_DB: db as unknown as AccountD1Binding, AI_FREE_MONTHLY_LIMIT: "1" }), { nowSeconds: () => now, fetchImpl: provider });
    const exceeded = await handleRequest(makeRequest("/api/ai/jev", { receipt: { merchant: "Shop", totalAmountYen: 50, items: [] } }), env({ ACCOUNT_DB: db as unknown as AccountD1Binding, AI_FREE_MONTHLY_LIMIT: "1" }), { nowSeconds: () => now, fetchImpl: provider });
    expect(first.status).toBe(200);
    expect(exceeded.status).toBe(429);
    expect(await exceeded.json()).toEqual({ error: "ai_quota_exceeded" });
    expect(provider).toHaveBeenCalledTimes(1);
    db.plans.set("synthetic-user", { plan: "family", monthlyAiLimit: null });
    const family = await handleRequest(makeRequest("/api/ai/jev", { receipt: { merchant: "Shop", totalAmountYen: 50, items: [] } }), env({ ACCOUNT_DB: db as unknown as AccountD1Binding, AI_FREE_MONTHLY_LIMIT: "1" }), { nowSeconds: () => now, fetchImpl: provider });
    expect(family.status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("reserves quota atomically under concurrent requests and starts a new UTC month", async () => {
    const db = fakeDb();
    const config = env({ ACCOUNT_DB: db as unknown as AccountD1Binding, AI_FREE_MONTHLY_LIMIT: "2" });
    const provider = fetchOk({ ...jev });
    const input = () => makeRequest("/api/ai/jev", { receipt: { merchant: "Shop", totalAmountYen: 50, items: [] } });
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => handleRequest(input(), config, { nowSeconds: () => now, fetchImpl: provider })));
    expect(outcomes.filter((response) => response.status === 200)).toHaveLength(2);
    expect(outcomes.filter((response) => response.status === 429)).toHaveLength(6);
    expect(provider).toHaveBeenCalledTimes(2);
    const boundary = Date.UTC(2027, 1, 1) / 1000;
    const nextMonth = await handleRequest(makeRequest("/api/ai/jev", { receipt: { merchant: "Shop", totalAmountYen: 50, items: [] } }, bearer("synthetic-user", { iat: boundary, exp: boundary + 300 })), config, { nowSeconds: () => boundary, fetchImpl: provider });
    expect(nextMonth.status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(3);
  });

  it("does not count malformed requests", async () => {
    const config = env({ AI_FREE_MONTHLY_LIMIT: "1" });
    const request = makeRequest("/api/ai/jev", { receipt: { merchant: "Shop", totalAmountYen: 1.5, items: [] } });
    const response = await handleRequest(request, config, { nowSeconds: () => now });
    expect(response.status).toBe(400);
    const usage = await handleRequest(new Request("https://kakeimatch-pr-36.workers.dev/api/ai/usage"), config, { nowSeconds: () => now });
    expect(await usage.json()).toMatchObject({ used: 0 });
  });

  it("counts a validated provider failure, but not an authorization failure", async () => {
    const db = fakeDb();
    const config = env({ ACCOUNT_DB: db as unknown as AccountD1Binding });
    const body = { receipt: { merchant: "Shop", totalAmountYen: 50, items: [] } };
    const unauthorized = await handleRequest(makeRequest("/api/ai/jev", body, "Bearer invalid"), config, { nowSeconds: () => now });
    expect(unauthorized.status).toBe(401);
    const providerFailure = await handleRequest(makeRequest("/api/ai/jev", body), config, { nowSeconds: () => now, fetchImpl: fetchOk({ error: "private provider detail" }, 500) });
    expect(providerFailure.status).toBe(503);
    expect(db.counts.get("synthetic-user:2027-01")).toEqual({ gemini: 0, jev: 1 });
  });

  it("rejects a zero-limit user's first reservation in real SQLite", async () => {
    const db = sqliteDb();
    db.sqlite.prepare("INSERT INTO account_entitlements(user_id, plan, monthly_ai_limit) VALUES (?, 'free', 0)").run("synthetic-user");
    const provider = fetchOk({ ...jev });
    const response = await handleRequest(makeRequest("/api/ai/jev", { receipt: { merchant: "Shop", totalAmountYen: 50, items: [] } }), env({ ACCOUNT_DB: db as unknown as AccountD1Binding }), { nowSeconds: () => now, fetchImpl: provider });
    expect(response.status).toBe(429);
    expect(provider).not.toHaveBeenCalled();
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM ai_usage").get()).toMatchObject({ count: 0 });
    db.sqlite.close();
  });

  it("requires a signed AI-only identity token and same-origin call", async () => {
    const request = makeRequest("/api/ai/jev", { receipt: { merchant: "Synthetic Shop", totalAmountYen: 100, items: [] } }, "Bearer invalid");
    expect((await handleRequest(request, env(), { nowSeconds: () => now })).status).toBe(401);
    const foreign = new Request(request, { headers: { origin: "https://attacker.invalid" } });
    expect((await handleRequest(foreign, env(), { nowSeconds: () => now })).status).toBe(403);
  });

  it("rejects expired, overlong, and wrong-audience tokens", async () => {
    for (const claims of [{ exp: now }, { exp: now + 901 }, { aud: "other" }]) {
      const request = makeRequest("/api/ai/jev", {}, bearer("synthetic-user", claims));
      expect((await handleRequest(request, env(), { nowSeconds: () => now })).status).toBe(401);
    }
    const token = bearer().slice("Bearer ".length).split(".");
    token[1] = `${token[1].startsWith("A") ? "B" : "A"}${token[1].slice(1)}`;
    const tampered = `Bearer ${token.join(".")}`;
    expect((await handleRequest(makeRequest("/api/ai/jev", {}, tampered), env(), { nowSeconds: () => now })).status).toBe(401);
  });

  it("enforces user keyed rate limits and fails closed without the binding", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const response = await handleRequest(makeRequest("/api/ai/jev", { receipt: { merchant: "Synthetic Shop", totalAmountYen: 100, items: [] } }), env({ AI_USER_RATE_LIMIT: { limit } }), { nowSeconds: () => now });
    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "synthetic-user:jev" });
    expect((await handleRequest(makeRequest("/api/ai/jev", {}), env({ AI_USER_RATE_LIMIT: undefined }), { nowSeconds: () => now })).status).toBe(503);
  });

  it("rejects oversized and malformed requests before calling a provider", async () => {
    const provider = fetchOk(jev);
    const tooLarge = new Request("https://kakeimatch-pr-36.workers.dev/api/ai/jev", { method: "POST", headers: { origin: "https://kakeimatch-pr-36.workers.dev", "content-type": "application/json", authorization: bearer(), "content-length": "10000000" }, body: "{}" });
    expect((await handleRequest(tooLarge, env(), { nowSeconds: () => now, fetchImpl: provider })).status).toBe(413);
    expect((await handleRequest(makeRequest("/api/ai/jev", { receipt: { merchant: "Synthetic Shop", totalAmountYen: 4.4, items: [] } }), env(), { nowSeconds: () => now, fetchImpl: provider })).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it("sends only validated category facts to Jev and never returns its secret or extra data", async () => {
    const provider = fetchOk({ ...jev, extra: "provider detail" });
    const response = await handleRequest(makeRequest("/api/ai/jev", { receipt: { merchant: " Synthetic Shop ", totalAmountYen: 3284, items: [{ name: " Synthetic Item ", amountYen: 3284 }], ignored: "drop" } }), env(), { nowSeconds: () => now, fetchImpl: provider });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(jev);
    const [url, init] = vi.mocked(provider).mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-jev-key");
    expect(JSON.parse(String(init?.body)).state.receipt).toEqual({ merchant: "Synthetic Shop", totalAmountYen: 3284, items: [{ name: "Synthetic Item", amountYen: 3284 }] });
  });

  it("sends receipt bytes to Gemini only for the Gemini route and validates output", async () => {
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64");
    const provider = fetchOk({ output_text: JSON.stringify(receipt) });
    const response = await handleRequest(makeRequest("/api/ai/gemini", { contentType: "image/png", imageBase64: pngBase64 }), env(), { nowSeconds: () => now, fetchImpl: provider });
    expect(response.status).toBe(200);
    const responseBody = await response.text();
    expect(JSON.parse(responseBody)).toEqual(receipt);
    expect(responseBody).not.toContain("synthetic-gemini-key");
    const [, init] = vi.mocked(provider).mock.calls[0];
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("synthetic-gemini-key");
    expect(JSON.parse(String(init?.body)).store).toBe(false);
    const invalid = await handleRequest(makeRequest("/api/ai/gemini", { contentType: "image/png", imageBase64: Buffer.from("not a png").toString("base64") }), env(), { nowSeconds: () => now, fetchImpl: provider });
    expect(invalid.status).toBe(400);
  });

  it("normalizes upstream failures and rejects malformed provider responses", async () => {
    const request = makeRequest("/api/ai/jev", { receipt: { merchant: "Synthetic Shop", totalAmountYen: 10, items: [] } });
    const privateError = await handleRequest(request, env(), { nowSeconds: () => now, fetchImpl: fetchOk({ message: "synthetic sensitive upstream detail" }, 500) });
    expect(privateError.status).toBe(503);
    expect(await privateError.text()).not.toContain("synthetic sensitive upstream detail");
    const malformed = await handleRequest(makeRequest("/api/ai/jev", { receipt: { merchant: "Synthetic Shop", totalAmountYen: 10, items: [] } }), env(), { nowSeconds: () => now, fetchImpl: fetchOk({ model: "jev-latest", answers: {} }) });
    expect(malformed.status).toBe(502);
  });
});
