import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const header = "利用日/キャンセル日,利用店名・商品名,利用者,決済方法,支払区分,利用金額,手数料,支払総額,当月支払金額,翌月以降繰越金額,調整額,当月お支払日";
const row = (id: string, merchant = id, amount = "1200") =>
  `2026/09/28,${merchant},本人,PayPayクレジット,1回,${amount},0,${amount},${amount},0,0,2026/10/27`;
const csv = (...rows: string[]) => Buffer.from([header, ...rows].join("\r\n") + "\r\n", "utf8");

describe("statement import persistence", () => {
  let root: string;
  let importStatement: typeof import("./statement-import").importStatement;
  let getCanonicalStatementTransactions: typeof import("./statement-import").getCanonicalStatementTransactions;
  let StatementImportError: typeof import("./statement-import").StatementImportError;
  let db: typeof import("@/db/client").db;
  let schema: typeof import("@/db/schema");
  let databasePath: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "statement-import-test-"));
    databasePath = path.join(root, "test.db");
    process.env.DATABASE_PATH = databasePath;
    process.env.STATEMENT_STORAGE_DIR = path.join(root, "raw");
    vi.resetModules();
    ({ db } = await import("@/db/client"));
    schema = await import("@/db/schema");
    ({ importStatement, StatementImportError, getCanonicalStatementTransactions } = await import("./statement-import"));
    for (const id of ["user-a", "user-b"]) {
      await db.insert(schema.user).values({ id, name: id, email: `${id}@example.invalid`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() });
    }
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.STATEMENT_STORAGE_DIR;
  });

  it("keeps separate same-looking purchases, skips overlapping imports, and isolates users", async () => {
    const first = await importStatement({ userId: "user-a", provider: "paypay_card", bytes: csv(row("test-a1"), row("test-a2")) });
    expect(first).toMatchObject({ importedRows: 2, duplicateRows: 0 });

    const repeat = await importStatement({ userId: "user-a", provider: "paypay_card", bytes: csv(row("test-a1"), row("test-a2")) });
    expect(repeat).toMatchObject({ importedRows: 0, duplicateRows: 2 });

    const overlap = await importStatement({ userId: "user-a", provider: "paypay_card", bytes: csv(row("test-a2"), row("test-a3")) });
    expect(overlap).toMatchObject({ importedRows: 1, duplicateRows: 1 });

    const otherUser = await importStatement({ userId: "user-b", provider: "paypay_card", bytes: csv(row("test-a1")) });
    expect(otherUser).toMatchObject({ importedRows: 1, duplicateRows: 0 });

    const rows = await db.select().from(schema.statementTransaction);
    expect(rows.filter((value) => value.userId === "user-a")).toHaveLength(3);
    expect(rows.filter((value) => value.userId === "user-b")).toHaveLength(1);
    expect(await getCanonicalStatementTransactions("user-a")).toHaveLength(3);
    expect(await getCanonicalStatementTransactions("user-b")).toHaveLength(1);
    expect(await getCanonicalStatementTransactions("user-b")).not.toEqual(await getCanonicalStatementTransactions("user-a"));
    expect(await readdir(path.join(root, "raw"))).toHaveLength(3);
  });

  it("does not save invalid files and removes raw bytes if the DB rejects an import", async () => {
    const before = (await readdir(path.join(root, "raw"))).length;
    const unknownLayout = Buffer.from(`${header.replace("利用日/キャンセル日", "unknown")}\r\n${row("unknown-layout")}\r\n`, "utf8");
    await expect(importStatement({ userId: "user-a", provider: "paypay_card", bytes: unknownLayout }))
      .rejects.toBeInstanceOf(StatementImportError);
    expect(await readdir(path.join(root, "raw"))).toHaveLength(before);

    const sqlite = new Database(databasePath);
    sqlite.exec("CREATE TRIGGER fail_statement_import BEFORE INSERT ON statement_import BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
    try {
      await expect(importStatement({ userId: "user-a", provider: "paypay_card", bytes: csv(row("db-failure")) })).rejects.toThrow();
      expect(await readdir(path.join(root, "raw"))).toHaveLength(before);
    } finally {
      sqlite.exec("DROP TRIGGER fail_statement_import");
      sqlite.close();
    }
  });
});
