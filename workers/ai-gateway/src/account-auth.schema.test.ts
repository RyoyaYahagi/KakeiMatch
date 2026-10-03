import { readFileSync } from "node:fs";
import { getAuthTables } from "better-auth/db";
import { passkey } from "@better-auth/passkey";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../migrations/0001_auth.sql", import.meta.url), "utf8");
const deletionMigration = readFileSync(new URL("../migrations/0007_account_deletion.sql", import.meta.url), "utf8");
const authTables = getAuthTables({ plugins: [passkey()] });

describe("Better Auth D1 migration schema", () => {
  it("contains every model and exact persisted field from Better Auth 1.7.6 and Passkey 1.7.6", () => {
    for (const [modelName, model] of Object.entries(authTables)) {
      const table = migration.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${modelName} \\(([\\s\\S]*?)\\n\\);`))?.[1];
      expect(table, `missing Better Auth table ${modelName}`).toBeDefined();
      const columns = new Set((table ?? "").split("\n")
        .map((line) => line.trim().match(/^([A-Za-z][A-Za-z0-9_]*)\s/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => match[1]));
      expect(columns.has("id"), `${modelName}.id`).toBe(true);
      for (const [fieldName, field] of Object.entries(model.fields)) {
        const persistedName = (field as { fieldName?: string }).fieldName ?? fieldName;
        expect(columns.has(persistedName), `${modelName}.${persistedName}`).toBe(true);
      }
    }
  });

  it("keeps account metadata separate from household records", () => {
    expect(migration).not.toMatch(/CREATE TABLE IF NOT EXISTS\s+(receipt|transaction|statement|reconciliation|actual)/i);
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS account_invite");
  });

  it("retains only opaque deleted IDs and blocks stale account recreation", () => {
    expect(deletionMigration).toContain("CREATE TABLE account_deletion_tombstones");
    expect(deletionMigration).toContain("CREATE TRIGGER prevent_deleted_account_recreation");
    expect(deletionMigration).toContain("RAISE(ABORT, 'deleted_account_id')");
    const table = deletionMigration.match(/CREATE TABLE account_deletion_tombstones \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(table.trim()).toBe("user_id TEXT PRIMARY KEY NOT NULL");
  });
});
