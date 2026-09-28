import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "kakeimatch-actual-mapping-"));
const databasePath = join(directory, "mapping.sqlite");
const testEnvironment = process.env as Record<string, string | undefined>;
testEnvironment.NODE_ENV = "test";
testEnvironment.APP_URL = "http://localhost:3000";
testEnvironment.DATABASE_PATH = databasePath;
testEnvironment.AUTH_SECRET = "test-only-auth-secret-at-least-32-characters-long";

type MappingModule = typeof import("./actual-budget-mapping");
let mappingModule: MappingModule;
let sqlite: Database.Database;
let userAId: string;
let userBId: string;

function createUser(id: string, email: string): void {
  const now = Date.now();
  sqlite
    .prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
    .run(id, id, email, now, now);
}

beforeAll(async () => {
  mappingModule = await import("./actual-budget-mapping");
  sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  const insert = sqlite.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
  );
  const now = Date.now();
  insert.run("user-a", "User A", "a@example.test", now, now);
  insert.run("user-b", "User B", "b@example.test", now, now);
  userAId = "user-a";
  userBId = "user-b";
});

afterAll(() => {
  sqlite?.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("Actual Budget mapping", () => {
  it("stores distinct budgets for separate users and never returns a sync ID to a caller", async () => {
    expect(await mappingModule.linkActualBudget("a@example.test", "sync-a")).toBeUndefined();
    await mappingModule.linkActualBudget("b@example.test", "sync-b");

    const rows = sqlite.prepare("SELECT user_id, sync_id FROM actual_budget_mapping ORDER BY user_id").all();
    expect(rows).toEqual([
      { user_id: userAId, sync_id: "sync-a" },
      { user_id: userBId, sync_id: "sync-b" },
    ]);
  });

  it("rejects an existing user mapping instead of overwriting it", async () => {
    await expect(mappingModule.linkActualBudget("a@example.test", "replacement-sync")).rejects.toThrow(
      "A mapping already exists for this user.",
    );
    expect(sqlite.prepare("SELECT sync_id FROM actual_budget_mapping WHERE user_id = ?").get(userAId)).toEqual({
      sync_id: "sync-a",
    });
  });

  it("rejects assigning the same sync ID to another user", async () => {
    createUser("user-c", "c@example.test");
    await expect(mappingModule.linkActualBudget("c@example.test", "sync-a")).rejects.toThrow(
      "This Sync ID is already assigned to another user.",
    );
  });

  it("rejects an unknown email without creating a mapping", async () => {
    await expect(mappingModule.linkActualBudget("missing@example.test", "unused-sync")).rejects.toThrow(
      "No KakeiMatch user exists with that email address.",
    );
    expect(sqlite.prepare("SELECT count(*) AS count FROM actual_budget_mapping").get()).toEqual({ count: 2 });
  });

  it("enforces the one-user and one-Sync-ID constraints in SQLite", () => {
    const insert = sqlite.prepare(
      "INSERT INTO actual_budget_mapping (id, user_id, sync_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    const now = Date.now();
    expect(() => insert.run("mapping-duplicate-user", userAId, "another-sync", now, now)).toThrow();
    expect(() => insert.run("mapping-duplicate-sync", "user-c", "sync-a", now, now)).toThrow();
    expect(() => insert.run("mapping-unknown-user", "missing-user", "unknown-sync", now, now)).toThrow();
  });

  it("deletes only the mapping when its KakeiMatch user is deleted", async () => {
    createUser("user-d", "d@example.test");
    await mappingModule.linkActualBudget("d@example.test", "sync-d");
    sqlite.prepare("DELETE FROM user WHERE id = ?").run("user-d");
    expect(sqlite.prepare("SELECT sync_id FROM actual_budget_mapping WHERE sync_id = ?").get("sync-d")).toBeUndefined();
  });
});
