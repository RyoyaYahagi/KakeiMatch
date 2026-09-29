import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "kakeimatch-category-map-"));
const databasePath = join(directory, "mapping.sqlite");
const environment = process.env as Record<string, string | undefined>;
environment.NODE_ENV = "test";
environment.APP_URL = "http://localhost:3000";
environment.DATABASE_PATH = databasePath;
environment.AUTH_SECRET = "test-only-auth-secret-at-least-32-characters-long";

let sqlite: Database.Database;
let resolveActualCategory: typeof import("./actual-category-resolution").resolveActualCategory;

beforeAll(async () => {
  ({ resolveActualCategory } = await import("./actual-category-resolution"));
  sqlite = new Database(databasePath);
  const now = Date.now();
  for (const id of ["user-a", "user-b"]) {
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
      .run(id, id, `${id}@example.test`, now, now);
  }
});

afterAll(() => {
  sqlite?.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("Actual category mapping by user", () => {
  it("stores a single exact match and keeps another user's Budget separate", async () => {
    const aCategories = [{ id: "a-food", name: "食費" }];
    const bCategories = [{ id: "b-food", name: "食費" }];
    expect(await resolveActualCategory({ userId: "user-a", categoryId: "food", categories: aCategories })).toBe("a-food");
    expect(await resolveActualCategory({ userId: "user-b", categoryId: "food", categories: bCategories })).toBe("b-food");
    const rows = sqlite.prepare("SELECT user_id, actual_category_id FROM actual_category_mapping ORDER BY user_id").all();
    expect(rows).toEqual([{ user_id: "user-a", actual_category_id: "a-food" }, { user_id: "user-b", actual_category_id: "b-food" }]);
  });

  it("uses an existing valid mapping and rejects a category removed from the Budget", async () => {
    expect(await resolveActualCategory({ userId: "user-a", categoryId: "food", categories: [{ id: "a-food", name: "Renamed" }] })).toBe("a-food");
    await expect(resolveActualCategory({ userId: "user-a", categoryId: "food", categories: [] })).rejects.toThrow("Actual category mapping is required.");
  });

  it("does not save missing or ambiguous names", async () => {
    await expect(resolveActualCategory({ userId: "user-a", categoryId: "medical", categories: [] })).rejects.toThrow();
    await expect(resolveActualCategory({ userId: "user-a", categoryId: "medical", categories: [
      { id: "one", name: "医療" }, { id: "two", name: "医療" },
    ] })).rejects.toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM actual_category_mapping WHERE category_id = 'medical'").get()).toEqual({ count: 0 });
  });
});
