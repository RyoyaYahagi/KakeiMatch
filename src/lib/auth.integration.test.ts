import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseDirectory = mkdtempSync(join(tmpdir(), "kakeimatch-auth-"));
const databasePath = join(databaseDirectory, "auth.sqlite");
const testEnvironment = process.env as Record<string, string | undefined>;
testEnvironment.NODE_ENV = "production";
testEnvironment.APP_URL = "http://localhost:3000";
testEnvironment.DATABASE_PATH = databasePath;
testEnvironment.AUTH_SECRET = "test-only-auth-secret-at-least-32-characters-long";

type AuthModule = typeof import("./auth");
type CurrentUserModule = typeof import("./current-user");
let authModule: AuthModule;
let currentUserModule: CurrentUserModule;
let signupAuth: ReturnType<AuthModule["createAuth"]>;
let resourceDb: Database.Database;

async function createSession(email: string): Promise<Headers> {
  await signupAuth.api.signUpEmail({
    body: { name: email, email, password: "test-password-1234" },
  });
  const response = await signupAuth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "test-password-1234" }),
    }),
  );
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  const cookie = setCookie!.split(";")[0];
  return new Headers({ cookie });
}

async function readResourceForSession(
  headers: Headers,
  resourceId: string,
  _claimedUserId?: string,
): Promise<{ id: string; owner_id: string; value: string } | undefined> {
  // The client-supplied identity is intentionally ignored; only the session decides ownership.
  void _claimedUserId;
  const user = await currentUserModule.getCurrentUser(headers);
  if (!user) return undefined;
  return resourceDb
    .prepare("SELECT id, owner_id, value FROM authorization_resource WHERE id = ? AND owner_id = ?")
    .get(resourceId, user.id) as { id: string; owner_id: string; value: string } | undefined;
}

beforeAll(async () => {
  authModule = await import("./auth");
  currentUserModule = await import("./current-user");
  signupAuth = authModule.createAuth({ allowSignUp: true });
  resourceDb = new Database(databasePath);
  resourceDb.exec(`
    CREATE TABLE authorization_resource (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      value TEXT NOT NULL
    )
  `);
});

afterAll(() => {
  resourceDb?.close();
  rmSync(databaseDirectory, { recursive: true, force: true });
});

describe("authentication and authorization integration", () => {
  it("rejects unauthenticated access to a protected resource", async () => {
    expect(await currentUserModule.getCurrentUser(new Headers())).toBeNull();
    expect(await readResourceForSession(new Headers(), "resource-a")).toBeUndefined();
  });

  it("rejects an invalid email/password login", async () => {
    await expect(
      signupAuth.api.signInEmail({
        body: { email: "missing@example.test", password: "wrong-password-123" },
      }),
    ).rejects.toThrow();
  });

  it("keeps public signup disabled while the bootstrap configuration can create users", async () => {
    await expect(
      authModule.getAuth().api.signUpEmail({
        body: {
          name: "Public Signup",
          email: "public@example.test",
          password: "test-password-1234",
        },
      }),
    ).rejects.toThrow();

    const response = await signupAuth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Bootstrap User",
          email: "bootstrap@example.test",
          password: "test-password-1234",
        }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("keeps resource reads isolated to the authenticated owner despite a spoofed userId", async () => {
    const headersA = await createSession("a@example.test");
    const headersB = await createSession("b@example.test");
    const userA = await currentUserModule.getCurrentUser(headersA);
    const userB = await currentUserModule.getCurrentUser(headersB);
    expect(userA?.id).toBeTruthy();
    expect(userB?.id).toBeTruthy();

    resourceDb
      .prepare("INSERT INTO authorization_resource (id, owner_id, value) VALUES (?, ?, ?)")
      .run("resource-a", userA!.id, "A private record");

    expect((await readResourceForSession(headersA, "resource-a", userB!.id))?.value).toBe("A private record");
    expect(await readResourceForSession(headersB, "resource-a", userA!.id)).toBeUndefined();
  });
});
