import { describe, expect, it, vi } from "vitest";
import { handleAccountRequest, handleAuthRequest, getAccountSession, type AccountD1Database, type AccountEnv } from "./account-auth";

const authState = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("better-auth", () => ({
  betterAuth: () => ({
    handler: async () => new Response(null, { status: 404 }),
    api: { getSession: async () => authState.session },
  }),
}));

function testDatabase(existingUserId: string | null = null) {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const batches: string[][] = [];
  let hasTombstone = false;
  const database: AccountD1Database = {
    prepare(query) {
      return {
        bind(...values) {
          calls.push({ query, values });
          const statement = {
            async first<T>() {
              if (query.includes("SELECT id FROM user")) return existingUserId ? { id: existingUserId } as T : null;
              if (query.includes("account_deletion_tombstones")) return hasTombstone ? { user_id: "synthetic-user" } as T : null;
              return null;
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          };
          return Object.assign(statement, { query, values });
        },
      };
    },
    async batch(statements) {
      const queries = statements.map((statement) => (statement as { query: string }).query);
      batches.push(queries);
      if (queries.some((query) => query.includes("account_deletion_tombstones"))) hasTombstone = true;
      return statements.map(() => ({ success: true, meta: { changes: 1 } })) as never[];
    },
  };
  return { database, calls, batches };
}

function post(url: string, body: unknown, secret = "operator-secret-with-at-least-32-characters") {
  return new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", origin: new URL(url).origin },
    body: JSON.stringify(body),
  });
}

const envFor = (ACCOUNT_DB: AccountD1Database): AccountEnv => ({
  ACCOUNT_DB,
  BETTER_AUTH_SECRET: "better-auth-secret-with-at-least-32-characters",
  ACCOUNT_BOOTSTRAP_SECRET: "operator-secret-with-at-least-32-characters",
  CLOUD_ACCOUNT_ORIGIN: "https://kakeimatch.example",
});

const signedIn = (id = "synthetic-self", email = "self@example.test") => {
  authState.session = {
    user: { id, name: "Synthetic Self", email },
    session: { id: "synthetic-session", expiresAt: new Date("2026-10-10T00:00:00Z") },
  };
};

function signupRequest(body: Record<string, unknown>, origin = "https://kakeimatch.example", ip = "203.0.113.7") {
  return new Request("https://kakeimatch.example/api/account/signup", {
    method: "POST",
    headers: { "content-type": "application/json", origin, "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

const signupEnv = (database: AccountD1Database, allow = () => true): AccountEnv => ({
  ...envFor(database),
  TURNSTILE_SITE_KEY: "synthetic-site-key",
  TURNSTILE_SECRET_KEY: "synthetic-turnstile-secret",
  ACCOUNT_RATE_LIMIT: { limit: async () => ({ success: allow() }) },
});

const turnstileResult = (result: Record<string, unknown>) =>
  vi.fn(async () => Response.json(result)) as unknown as typeof fetch;
const humanSignup = turnstileResult({ success: true, hostname: "kakeimatch.example", action: "signup" });

describe("Open signup", () => {
  it("issues a short-lived ticket without creating a user or accepting a plan", async () => {
    const { database, calls } = testDatabase();
    const fetchImpl = turnstileResult({ success: true, hostname: "kakeimatch.example", action: "signup" });
    const response = await handleAccountRequest(signupRequest({
      email: " New@Example.test ", name: "New member", turnstileToken: "synthetic-token", plan: "family", userId: "victim",
    }), signupEnv(database), { fetchImpl });
    const body = await response.json() as { context: string };

    expect(response.status).toBe(201);
    expect(body.context).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(calls.some((call) => call.query.includes("INSERT INTO user"))).toBe(false);
    expect(calls.some((call) => call.query.includes("account_entitlements"))).toBe(false);
    const ticket = calls.find((call) => call.query.includes("INSERT INTO account_signup_tickets"));
    expect(ticket?.values).toContain("new@example.test");
    expect(ticket?.values).not.toContain(body.context);
    expect(ticket?.values).not.toContain("victim");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a failed or mismatched bot check before writing anything", async () => {
    const { database, calls } = testDatabase();
    const env = signupEnv(database);
    for (const fetchImpl of [
      turnstileResult({ success: false, "error-codes": ["invalid-input-response"] }),
      turnstileResult({ success: true, hostname: "attacker.example", action: "signup" }),
      turnstileResult({ success: true, hostname: "kakeimatch.example", action: "login" }),
    ]) {
      const response = await handleAccountRequest(signupRequest({ email: "bot@example.test", name: "Bot", turnstileToken: "token" }), env, { fetchImpl });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bot_check_failed" });
    }
    const missingToken = await handleAccountRequest(signupRequest({ email: "bot@example.test", name: "Bot" }), env, { fetchImpl: humanSignup });
    expect(missingToken.status).toBe(400);
    expect(calls.some((call) => call.query.includes("account_signup_tickets"))).toBe(false);
  });

  it("rate-limits signup per client address and fails closed without protection configured", async () => {
    const { database, calls } = testDatabase();
    const limited = await handleAccountRequest(signupRequest({ email: "a@example.test", name: "A", turnstileToken: "t" }),
      signupEnv(database, () => false), { fetchImpl: humanSignup });
    expect(limited.status).toBe(429);

    const limiter = vi.fn(async () => ({ success: true }));
    await handleAccountRequest(signupRequest({ email: "a@example.test", name: "A", turnstileToken: "t" }),
      { ...signupEnv(database), ACCOUNT_RATE_LIMIT: { limit: limiter } }, { fetchImpl: humanSignup });
    expect(limiter).toHaveBeenCalledWith({ key: "signup:203.0.113.7" });

    const noLimiter = await handleAccountRequest(signupRequest({ email: "a@example.test", name: "A", turnstileToken: "t" }),
      { ...signupEnv(database), ACCOUNT_RATE_LIMIT: undefined }, { fetchImpl: humanSignup });
    expect(noLimiter.status).toBe(503);
    const noTurnstile = await handleAccountRequest(signupRequest({ email: "a@example.test", name: "A", turnstileToken: "t" }),
      { ...signupEnv(database), TURNSTILE_SECRET_KEY: undefined }, { fetchImpl: humanSignup });
    expect(noTurnstile.status).toBe(503);
    expect(calls.filter((call) => call.query.includes("INSERT INTO account_signup_tickets"))).toHaveLength(1);
  });

  it("requires the app origin for signup and reports email already in use", async () => {
    const { database } = testDatabase();
    const foreign = await handleAccountRequest(signupRequest({ email: "a@example.test", name: "A", turnstileToken: "t" }, "https://attacker.example"),
      signupEnv(database), { fetchImpl: humanSignup });
    expect(foreign.status).toBe(403);
    const noOrigin = new Request("https://kakeimatch.example/api/account/signup", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.test", name: "A", turnstileToken: "t" }),
    });
    expect((await handleAccountRequest(noOrigin, signupEnv(database), { fetchImpl: humanSignup })).status).toBe(403);

    const { database: withUser } = testDatabase("existing-user");
    const taken = await handleAccountRequest(signupRequest({ email: "taken@example.test", name: "A", turnstileToken: "t" }),
      signupEnv(withUser), { fetchImpl: humanSignup });
    expect(taken.status).toBe(409);
  });

  it("exposes only the public site key when signup protection is configured", async () => {
    const { database } = testDatabase();
    const configured = await handleAccountRequest(new Request("https://kakeimatch.example/api/account/signup-config"), signupEnv(database));
    expect(await configured.json()).toEqual({ signupAvailable: true, turnstileSiteKey: "synthetic-site-key" });
    const missing = await handleAccountRequest(new Request("https://kakeimatch.example/api/account/signup-config"), envFor(database));
    expect(await missing.json()).toEqual({ signupAvailable: false, turnstileSiteKey: null });
  });

  it("no longer exposes operator account-creation invites or public email/password signup", async () => {
    const { database } = testDatabase();
    const env = envFor(database);
    const legacyInvite = await handleAccountRequest(post("https://kakeimatch.example/api/account/invites", {
      email: "person@example.test", name: "Person",
    }), env);
    expect(legacyInvite.status).toBe(404);

    const request = new Request("https://kakeimatch.example/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://kakeimatch.example" },
      body: JSON.stringify({ name: "Person", email: "person@example.test", password: "not-a-real-password" }),
    });
    expect((await handleAuthRequest(request, env)).status).toBeGreaterThanOrEqual(400);
  });
});

describe("Family invites", () => {
  const issue = (headers: Record<string, string>, body: unknown = {}) =>
    new Request("https://kakeimatch.example/api/account/family-invites", {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
  const accept = (body: unknown, headers: Record<string, string> = { origin: "https://kakeimatch.example" }) =>
    new Request("https://kakeimatch.example/api/account/family-invites/accept", {
      method: "POST", headers: { "content-type": "application/json", cookie: "synthetic-session-cookie", ...headers }, body: JSON.stringify(body),
    });
  const token = "A".repeat(43);

  it("lets only the operator secret issue invites, from no or the same origin", async () => {
    const { database, calls } = testDatabase();
    const env = signupEnv(database);
    signedIn();
    expect((await handleAccountRequest(issue({ cookie: "synthetic-session-cookie", origin: "https://kakeimatch.example" }), env)).status).toBe(401);
    expect((await handleAccountRequest(issue({ authorization: "Bearer wrong" }), env)).status).toBe(401);
    expect((await handleAccountRequest(issue({ authorization: `Bearer ${env.ACCOUNT_BOOTSTRAP_SECRET}`, origin: "https://attacker.example" }), env)).status).toBe(403);
    expect((await handleAccountRequest(issue({ authorization: `Bearer ${env.ACCOUNT_BOOTSTRAP_SECRET}` }), { ...env, ACCOUNT_BOOTSTRAP_SECRET: undefined })).status).toBe(401);
    expect((await handleAccountRequest(issue({ authorization: `Bearer ${env.ACCOUNT_BOOTSTRAP_SECRET}` }), signupEnv(database, () => false))).status).toBe(429);
    expect(calls.some((call) => call.query.includes("INSERT INTO family_invites"))).toBe(false);

    const response = await handleAccountRequest(issue({ authorization: `Bearer ${env.ACCOUNT_BOOTSTRAP_SECRET}` }), env);
    expect(response.status).toBe(201);
    const body = await response.json() as { inviteUrl: string };
    expect(body.inviteUrl).toMatch(/^https:\/\/kakeimatch\.example\/#family-invite=[A-Za-z0-9_-]{43}$/);
    const insert = calls.find((call) => call.query.includes("INSERT INTO family_invites"));
    expect(insert?.values.join(" ")).not.toContain(body.inviteUrl.split("=")[1]);
    expect(insert?.values.join(" ")).not.toContain("family@example.test");
  });

  it("requires a signed-in session and the app origin to accept", async () => {
    const { database, batches } = testDatabase();
    const env = signupEnv(database);
    authState.session = null;
    expect((await handleAccountRequest(accept({ token }), env)).status).toBe(401);
    signedIn();
    expect((await handleAccountRequest(accept({ token }, { origin: "https://attacker.example" }), env)).status).toBe(403);
    expect((await handleAccountRequest(accept({ token }, {}), env)).status).toBe(403);
    expect((await handleAccountRequest(accept({ token }), signupEnv(database, () => false))).status).toBe(429);
    expect(batches).toHaveLength(0);
  });

  it("uses the bearer token as the invite capability, binds the grant to the session user, and ignores client identity claims", async () => {
    const { database, calls, batches } = testDatabase();
    signedIn("synthetic-self", "self@example.test");
    const response = await handleAccountRequest(accept({ token, plan: "family", userId: "another-user", email: "another@example.test" }), signupEnv(database));
    expect(response.status).toBe(200);
    expect(batches).toHaveLength(1);
    const writes = calls.filter((call) => call.query.includes("UPDATE family_invites") || call.query.includes("INSERT INTO account_entitlements"));
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write.values).toContain("synthetic-self");
      expect(write.values).not.toContain("another-user");
    }
  });

  it("does not grant Family through a plan field on signup, usage, or unknown account routes", async () => {
    const { database, calls } = testDatabase();
    signedIn();
    for (const path of ["/api/account/plan", "/api/account/entitlements", "/api/account/family"]) {
      const response = await handleAccountRequest(new Request(`https://kakeimatch.example${path}`, {
        method: "POST", headers: { "content-type": "application/json", origin: "https://kakeimatch.example" }, body: JSON.stringify({ plan: "family" }),
      }), signupEnv(database));
      expect(response.status).toBe(404);
    }
    expect(calls.some((call) => call.query.includes("account_entitlements"))).toBe(false);
  });
});

describe("Cloud account recovery", () => {
  it("rejects unauthenticated operator recovery and untrusted origins", async () => {
    const { database } = testDatabase("user-123");
    const env = envFor(database);
    const unauthorized = await handleAccountRequest(post("https://kakeimatch.example/api/account/recovery", {
      email: "person@example.test",
    }, "wrong"), env);
    expect(unauthorized.status).toBe(401);

    const request = new Request("https://kakeimatch.example/api/account/recovery", {
      method: "POST",
      headers: { authorization: `Bearer ${env.ACCOUNT_BOOTSTRAP_SECRET}`, "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ email: "person@example.test" }),
    });
    expect((await handleAccountRequest(request, env)).status).toBe(403);
  });

  it("revokes sessions and passkeys before issuing recovery invite", async () => {
    const { database, calls } = testDatabase("user-123");
    const batch = vi.spyOn(database, "batch");
    const response = await handleAccountRequest(post("https://kakeimatch.example/api/account/recovery", {
      email: "person@example.test",
    }), envFor(database));
    const body = await response.json() as { context: string; inviteUrl: string };

    expect(response.status).toBe(201);
    expect(body.context).toBeTruthy();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.query)).toContain("DELETE FROM session WHERE userId = ?");
    expect(calls.map((call) => call.query)).toContain("DELETE FROM passkey WHERE userId = ?");
    expect(calls.map((call) => call.query)).toContain("UPDATE account_invite SET used_at = ? WHERE user_id = ? AND used_at IS NULL");
  });

  it("does not resolve a session without a valid Better Auth session cookie", async () => {
    authState.session = null;
    const { database } = testDatabase();
    const request = new Request("https://kakeimatch.example/api/ai/token");
    await expect(getAccountSession(request, envFor(database))).resolves.toBeNull();
  });

  it("deletes only the signed-in account after a same-origin request", async () => {
    authState.session = {
      user: { id: "synthetic-self", name: "Synthetic Self", email: "self@example.test" },
      session: { id: "synthetic-session", expiresAt: new Date("2026-10-10T00:00:00Z") },
    };
    const { database, calls, batches } = testDatabase();
    const response = await handleAccountRequest(new Request("https://kakeimatch.example/api/account/delete", {
      method: "DELETE", headers: { origin: "https://kakeimatch.example", cookie: "synthetic-session-cookie" },
    }), envFor(database));
    const body = await response.json() as { deleted: boolean; localHouseholdDataPreserved: boolean };

    expect(response.status).toBe(200);
    expect(body).toEqual({ deleted: true, localHouseholdDataPreserved: true });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.some((query) => query.includes("INSERT INTO account_deletion_tombstones"))).toBe(true);
    expect(batches[0]?.some((query) => query.includes("DELETE FROM user"))).toBe(true);
    expect(calls.some((call) => call.query.includes("DELETE FROM user") && call.values.includes("synthetic-self"))).toBe(true);
  });

  it("accepts an empty request stream, as Cloudflare delivers a bodiless DELETE", async () => {
    authState.session = {
      user: { id: "synthetic-self", name: "Synthetic Self", email: "self@example.test" },
      session: { id: "synthetic-session", expiresAt: new Date("2026-10-10T00:00:00Z") },
    };
    const { database, batches } = testDatabase();
    const response = await handleAccountRequest(new Request("https://kakeimatch.example/api/account/delete", {
      method: "DELETE", headers: { origin: "https://kakeimatch.example", cookie: "synthetic-session-cookie" }, body: new Uint8Array(0),
    }), envFor(database));

    expect(response.status).toBe(200);
    expect(batches).toHaveLength(1);
  });

  it("treats a repeated deletion attempt as successful and idempotent", async () => {
    authState.session = {
      user: { id: "synthetic-self", name: "Synthetic Self", email: "self@example.test" },
      session: { id: "synthetic-session", expiresAt: new Date("2026-10-10T00:00:00Z") },
    };
    const { database, batches } = testDatabase();
    const makeRequest = () => new Request("https://kakeimatch.example/api/account/delete", {
      method: "DELETE", headers: { origin: "https://kakeimatch.example", cookie: "synthetic-session-cookie" },
    });

    const first = await handleAccountRequest(makeRequest(), envFor(database));
    const retry = await handleAccountRequest(makeRequest(), envFor(database));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(batches).toHaveLength(2);
  });

  it("rejects missing sessions, external origins, and caller-supplied user IDs", async () => {
    authState.session = null;
    const { database, batches } = testDatabase();
    const env = envFor(database);
    const url = "https://kakeimatch.example/api/account/delete";
    const noSession = await handleAccountRequest(new Request(url, { method: "DELETE", headers: { origin: "https://kakeimatch.example" } }), env);
    expect(noSession.status).toBe(401);
    const foreignOrigin = await handleAccountRequest(new Request(url, { method: "DELETE", headers: { origin: "https://attacker.example" } }), env);
    expect(foreignOrigin.status).toBe(403);
    const missingOrigin = await handleAccountRequest(new Request(url, { method: "DELETE" }), env);
    expect(missingOrigin.status).toBe(403);
    const suppliedId = await handleAccountRequest(new Request(url, {
      method: "DELETE", headers: { origin: "https://kakeimatch.example", "content-type": "application/json" }, body: JSON.stringify({ userId: "another-user" }),
    }), env);
    expect(suppliedId.status).toBe(400);
    expect(batches).toHaveLength(0);
  });
});
