import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "kakeimatch-reconciliation-repository-"));
const databasePath = join(directory, "reconciliation.sqlite");
const testEnvironment = process.env as Record<string, string | undefined>;
testEnvironment.NODE_ENV = "test";
testEnvironment.APP_URL = "http://localhost:3000";
testEnvironment.DATABASE_PATH = databasePath;
testEnvironment.AUTH_SECRET = "test-only-auth-secret-at-least-32-characters-long";

type Repository = typeof import("./reconciliation-repository");
let repository: Repository;
let sqlite: Database.Database;

function insertUser(id: string) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,?,?)")
    .run(id, id, `${id}@example.test`, now, now);
}

function insertSource(userId: string, suffix: string) {
  const now = Date.now();
  const importId = `import-${suffix}`;
  sqlite.prepare(`INSERT INTO statement_import (id,user_id,provider,storage_key,file_hash,encoding,header_signature,status,total_rows,imported_rows,duplicate_rows,excluded_rows,rejected_rows,created_at,completed_at)
    VALUES (?,?,? ,?,?,?,?,?,1,1,0,0,0,?,?)`).run(importId, userId, "paypay", `key-${suffix}`, `hash-${suffix}`, "utf8", "synthetic", "complete", now, now);
  sqlite.prepare(`INSERT INTO statement_transaction (id,import_id,user_id,provider,external_id,kind,used_date,used_time,posted_date,merchant,amount_yen,payment_method,source_fingerprint,duplicate_ordinal,created_at)
    VALUES (?,?,?,?,?,'purchase','2026-09-01',NULL,NULL,?,1000,NULL,?,0,?)`).run(`statement-${suffix}`, importId, userId, "paypay", `external-${suffix}`, `店-${suffix}`, `fingerprint-${suffix}`, now);
  sqlite.prepare("INSERT INTO receipt (id,owner_user_id,storage_key,content_type,file_size,created_at) VALUES (?,?,?,?,?,?)")
    .run(`receipt-${suffix}`, userId, `receipt-key-${suffix}`, "image/jpeg", 20, now);
  sqlite.prepare(`INSERT INTO receipt_registration (receipt_id,merchant,purchased_date,total_amount_yen,category_id,actual_account_id,status,imported_id,actual_transaction_id,updated_at,registered_at)
    VALUES (?,?, '2026-09-01',1000,'food','account-1','registered',?,?,?,?)`)
    .run(`receipt-${suffix}`, `店-${suffix}`, `imported-${suffix}`, `actual-${suffix}`, now, now);
}

beforeAll(async () => {
  repository = await import("./reconciliation-repository");
  sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  insertUser("user-a");
  insertUser("user-b");
  insertSource("user-a", "a");
  insertSource("user-b", "b");
});

afterAll(() => {
  sqlite?.close();
  rmSync(directory, { recursive: true, force: true });
});

const resultFor = (statementTransactionId: string, receiptId: string) => ({
  ruleVersion: "test-v1",
  candidates: [{ statementTransactionId, receiptId, rank: 1, score: 0.99, amountDeltaYen: 0, dateDistanceDays: 0, merchantSimilarity: 1, reasons: ["amount_exact", "date_close", "merchant_similar"] }],
  statementResults: [{ statementTransactionId, status: "matched" as const, matchedReceiptId: receiptId, reasonCodes: ["automatic_high_confidence_match"] }],
  receiptResults: [{ receiptId, status: "matched" as const, matchedStatementTransactionId: statementTransactionId, reasonCodes: ["automatic_high_confidence_match"] }],
});

describe("reconciliation repository", () => {
  it("reads only the user's canonical statements and registered final receipt values", async () => {
    const values = await repository.getReconciliationInputs("user-a");
    expect(values.statements.map((row) => row.statementTransactionId)).toEqual(["statement-a"]);
    expect(values.statements[0]).toMatchObject({ merchant: "店-a", amountYen: 1000, provider: "paypay" });
    expect(values.receipts).toEqual([{
      receiptId: "receipt-a", actualTransactionId: "actual-a", merchant: "店-a",
      purchasedDate: "2026-09-01", amountYen: 1000, actualAccountId: "account-1",
    }]);
  });

  it("writes immutable snapshots, exposes only the owner latest run, and preserves candidate reasons and score", async () => {
    const first = await repository.saveReconciliationRun({ userId: "user-a", ...resultFor("statement-a", "receipt-a") });
    const second = await repository.saveReconciliationRun({ userId: "user-a", ...resultFor("statement-a", "receipt-a") });
    expect(second).not.toBe(first);
    const latest = await repository.getLatestReconciliationRun("user-a");
    expect(latest?.runId).toBe(second);
    expect(latest?.ruleVersion).toBe("test-v1");
    expect(latest?.candidates[0]).toMatchObject({ score: 0.99, amountDeltaYen: 0, dateDistanceDays: 0, reasons: ["amount_exact", "date_close", "merchant_similar"] });
    expect(latest?.statementResults[0]).toMatchObject({ status: "matched", matchedReceiptId: "receipt-a", score: 0.99 });
    expect(await repository.getLatestReconciliationRun("user-b")).toBeNull();
    expect(sqlite.prepare("SELECT count(*) AS count FROM reconciliation_run WHERE user_id = 'user-a'").get()).toEqual({ count: 2 });
    expect(sqlite.prepare("SELECT status FROM reconciliation_statement_result WHERE run_id = ?").get(second)).toEqual({ status: "matched" });
  });

  it("rejects cross-user source IDs and remembers aliases under only the explicit user's scope", async () => {
    await expect(repository.saveReconciliationRun({
      userId: "user-a", ...resultFor("statement-b", "receipt-b"),
    })).rejects.toThrow("reconciliation_source_not_owned");
    await repository.rememberMerchantAlias({ userId: "user-a", merchant: " ＡＢＣ ", aliasMerchant: "abc store" });
    expect((await repository.getReconciliationInputs("user-a")).aliases).toEqual([{ normalizedMerchant: "abc", normalizedAlias: "abcstore" }]);
    expect((await repository.getReconciliationInputs("user-b")).aliases).toEqual([]);
  });
});
