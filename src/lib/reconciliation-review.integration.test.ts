import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/actual-reconciliation-writer", () => ({
  createActualReconciliationWriter: () => ({ listOpenAccounts: async () => [{ id: "account-a", name: "テスト口座" }] }),
}));

const directory = mkdtempSync(join(tmpdir(), "kakeimatch-review-"));
const databasePath = join(directory, "review.sqlite");
const testEnvironment = process.env as Record<string, string | undefined>;
testEnvironment.NODE_ENV = "test";
testEnvironment.APP_URL = "http://localhost:3000";
testEnvironment.DATABASE_PATH = databasePath;
testEnvironment.AUTH_SECRET = "test-only-auth-secret-at-least-32-characters-long";

let sqlite: Database.Database;
let repository: typeof import("./reconciliation-repository");
let review: typeof import("./reconciliation-review");

function insertStatement(id: string, kind = "purchase") {
  const now = Date.now();
  sqlite.prepare(`INSERT INTO statement_import (id,user_id,provider,storage_key,file_hash,encoding,header_signature,status,total_rows,imported_rows,duplicate_rows,excluded_rows,rejected_rows,created_at,completed_at)
    VALUES (?,?,? ,?,?,?,?,?,1,1,0,0,0,?,?)`).run(`import-${id}`, "user-a", "paypay", `key-${id}`, `hash-${id}`, "utf8", "synthetic", "complete", now, now);
  sqlite.prepare(`INSERT INTO statement_transaction (id,import_id,user_id,provider,external_id,kind,used_date,used_time,posted_date,merchant,amount_yen,payment_method,source_fingerprint,duplicate_ordinal,created_at)
    VALUES (?,?,?,?,?,?,'2026-09-01',NULL,NULL,?,1000,NULL,?,0,?)`).run(id, `import-${id}`, "user-a", "paypay", id, kind, `人工店 ${id}`, id, now);
}

function insertReceipt(id: string) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO receipt (id,owner_user_id,storage_key,content_type,file_size,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, "user-a", `key-${id}`, "image/jpeg", 20, now);
  sqlite.prepare(`INSERT INTO receipt_registration (receipt_id,merchant,purchased_date,total_amount_yen,category_id,actual_account_id,status,imported_id,actual_transaction_id,updated_at,registered_at)
    VALUES (?,?, '2026-09-01',1000,'food','account-a','registered',?,?,?,?)`)
    .run(id, `人工店 ${id}`, `imported-${id}`, `actual-${id}`, now, now);
}

beforeAll(async () => {
  repository = await import("./reconciliation-repository");
  review = await import("./reconciliation-review");
  sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  const now = Date.now();
  sqlite.prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,?,?)")
    .run("user-a", "Synthetic A", "a@example.test", now, now);
  for (const id of ["auto", "review", "none", "refund"]) insertStatement(id, id === "refund" ? "refund" : "purchase");
  for (const id of ["auto-receipt", "review-receipt", "waiting-receipt"]) insertReceipt(id);
});

afterAll(() => { sqlite?.close(); rmSync(directory, { recursive: true, force: true }); });

describe("reconciliation review summary", () => {
  it("shows only unresolved statements, keeps auto matches in the summary, and excludes waiting receipts from the queue", async () => {
    const runId = await repository.saveReconciliationRun({
      userId: "user-a", ruleVersion: "test-v1",
      candidates: [
        { statementTransactionId: "auto", receiptId: "auto-receipt", rank: 1, score: 1, amountDeltaYen: 0, dateDistanceDays: 0, merchantSimilarity: 1, reasons: ["amount_exact"] },
        { statementTransactionId: "review", receiptId: "review-receipt", rank: 1, score: 0.8, amountDeltaYen: 0, dateDistanceDays: 0, merchantSimilarity: 0.8, reasons: ["amount_exact"] },
      ],
      statementResults: [
        { statementTransactionId: "auto", status: "matched", matchedReceiptId: "auto-receipt", reasonCodes: ["automatic_high_confidence_match"] },
        { statementTransactionId: "review", status: "needs_review", reasonCodes: ["candidate_requires_review"] },
        { statementTransactionId: "none", status: "unmatched_statement", reasonCodes: ["no_candidate"] },
        { statementTransactionId: "refund", status: "unmatched_statement", reasonCodes: ["refund_not_supported"] },
      ],
      receiptResults: [
        { receiptId: "auto-receipt", status: "matched", matchedStatementTransactionId: "auto", reasonCodes: ["automatic_high_confidence_match"] },
        { receiptId: "review-receipt", status: "needs_review", reasonCodes: ["candidate_requires_review"] },
        { receiptId: "waiting-receipt", status: "unmatched_receipt", reasonCodes: ["no_candidate"] },
      ],
    });
    const result = await review.getReconciliationReview("user-a");
    expect(result?.runId).toBe(runId);
    expect(result?.summary).toEqual({ automatic: 1, needsReview: 1, unmatchedStatement: 2, unmatchedReceipt: 1, failed: 0 });
    expect(result?.items.map((item) => item.statementTransactionId)).toEqual(["review", "none", "refund"]);
    expect(result?.items.find((item) => item.statementTransactionId === "refund")?.statement.kind).toBe("refund");
    expect(await review.getPendingReconciliationCount("user-a")).toBe(1);

    await repository.recordPairRejection({ userId: "user-a", runId, statementTransactionId: "review", receiptId: "review-receipt" });
    const rejected = await review.getReconciliationReview("user-a");
    expect(rejected?.summary.needsReview).toBe(0);
    expect(rejected?.summary.unmatchedStatement).toBe(3);
    expect(await review.getPendingReconciliationCount("user-a")).toBe(0);
  });
});
