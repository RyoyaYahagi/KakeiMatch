import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../migrations/0001_auth.sql", import.meta.url), "utf8");
const deletionMigration = readFileSync(new URL("../migrations/0007_account_deletion.sql", import.meta.url), "utf8");

describe("account D1 migration schema", () => {
  it("keeps account metadata separate from household records", () => {
    expect(migration).not.toMatch(/CREATE TABLE IF NOT EXISTS\s+(receipt|transaction|statement|reconciliation|actual)/i);
  });

  it("retains only opaque deleted IDs and blocks stale account recreation", () => {
    expect(deletionMigration).toContain("CREATE TABLE account_deletion_tombstones");
    expect(deletionMigration).toContain("CREATE TRIGGER prevent_deleted_account_recreation");
    expect(deletionMigration).toContain("RAISE(ABORT, 'deleted_account_id')");
    const table = deletionMigration.match(/CREATE TABLE account_deletion_tombstones \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(table.trim()).toBe("user_id TEXT PRIMARY KEY NOT NULL");
  });
});
