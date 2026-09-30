import { describe, expect, it, vi } from "vitest";
import { handleAccountRequest, handleAuthRequest, getAccountSession, type AccountD1Database, type AccountEnv } from "./account-auth";

function testDatabase(existingUserId: string | null = null) {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const database: AccountD1Database = {
    prepare(query) {
      return {
        bind(...values) {
          calls.push({ query, values });
          return {
            async first<T>() {
              if (query.includes("SELECT id FROM user")) return existingUserId ? { id: existingUserId } as T : null;
              return null;
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          };
        },
      };
    },
    async batch(statements) {
      return statements.map(() => ({ success: true })) as never[];
    },
  };
  return { database, calls };
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
    const { database } = testDatabase();
    const request = new Request("https://kakeimatch.example/api/ai/token");
    await expect(getAccountSession(request, envFor(database))).resolves.toBeNull();
  });
});
