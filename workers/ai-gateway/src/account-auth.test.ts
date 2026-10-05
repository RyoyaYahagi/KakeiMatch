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
      let values: unknown[] = [];
      const statement = {
        query,
        get values() { return values; },
        bind(...nextValues: unknown[]) { values = nextValues; calls.push({ query, values }); return statement; },
        async first<T>() {
          if (query.includes("SELECT id FROM user")) return existingUserId ? { id: existingUserId } as T : null;
          if (query.includes("account_deletion_tombstones")) return hasTombstone ? { user_id: "synthetic-user" } as T : null;
          return null;
        },
        async all<T>() { return { results: [] as T[] }; },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return statement;
    },
    async batch(statements) {
      const queries = statements.map((statement) => "query" in statement ? String(statement.query) : "");
      batches.push(queries);
      if (queries.some((query) => query.includes("account_deletion_tombstones"))) hasTombstone = true;
      return statements.map(() => ({ success: true })) as never[];
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

describe("Cloud account bootstrap and recovery", () => {
  it("rejects unauthenticated operator provisioning and untrusted origins", async () => {
    const { database } = testDatabase();
    const env = envFor(database);
    const unauthorized = await handleAccountRequest(post("https://kakeimatch.example/api/account/invites", {
      email: "person@example.test", name: "Person",
    }, "wrong"), env);
    expect(unauthorized.status).toBe(401);

    const request = new Request("https://kakeimatch.example/api/account/invites", {
      method: "POST",
      headers: { authorization: `Bearer ${env.ACCOUNT_BOOTSTRAP_SECRET}`, "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ email: "person@example.test", name: "Person" }),
    });
    expect((await handleAccountRequest(request, env)).status).toBe(403);
  });

  it("does not expose public email/password signup", async () => {
    const { database } = testDatabase();
    const env = envFor(database);
    const request = new Request("https://kakeimatch.example/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://kakeimatch.example" },
      body: JSON.stringify({ name: "Person", email: "person@example.test", password: "not-a-real-password" }),
    });

    expect((await handleAuthRequest(request, env)).status).toBeGreaterThanOrEqual(400);
  });

  it("creates an expiring invite while storing only its SHA-256 digest", async () => {
    const { database, calls } = testDatabase();
    const response = await handleAccountRequest(post("https://kakeimatch.example/api/account/invites", {
      email: " PERSON@example.test ", name: "Person",
    }), envFor(database));
    const body = await response.json() as { context: string; expiresAt: string; inviteUrl: string };

    expect(response.status).toBe(201);
    expect(body.context).toMatch(/^[A-Za-z0-9_-]{40,50}$/);
    expect(body.inviteUrl).toBe(`https://kakeimatch.example/?invite=${encodeURIComponent(body.context)}`);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(calls.some((call) => call.query.includes("INSERT INTO user") && call.values.includes("person@example.test"))).toBe(true);
    const inviteInsert = calls.find((call) => call.query.includes("INSERT INTO account_invite"));
    expect(inviteInsert).toBeDefined();
    expect(inviteInsert?.values).not.toContain(body.context);
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
