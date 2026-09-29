import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "kakeimatch-registration-state-"));
const databasePath = join(directory, "registration.sqlite");
const receiptA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const receiptB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const testEnvironment = process.env as Record<string, string | undefined>;
testEnvironment.NODE_ENV = "test";
testEnvironment.APP_URL = "http://localhost:3000";
testEnvironment.DATABASE_PATH = databasePath;
testEnvironment.AUTH_SECRET = "test-only-auth-secret-at-least-32-characters-long";

type StateModule = typeof import("./receipt-registration-state");
let stateModule: StateModule;
let sqlite: Database.Database;

function insertUser(id: string, email: string) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
    .run(id, id, email, now, now);
}

function insertReceipt(id: string, ownerId: string) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO receipt (id, owner_user_id, storage_key, content_type, file_size, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, ownerId, `key-${id}`, "image/jpeg", 100, now);
}

const values = (userId = "user-a", receiptId = receiptA) => ({
  userId, receiptId, merchant: " 人工店舗 ", purchasedDate: "2026-09-28",
  totalAmountYen: 3284, categoryId: "food" as const, actualAccountId: "account-a",
});

beforeAll(async () => {
  stateModule = await import("./receipt-registration-state");
  sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  insertUser("user-a", "a@example.test");
  insertUser("user-b", "b@example.test");
  insertReceipt(receiptA, "user-a");
  insertReceipt(receiptB, "user-b");
});

afterAll(() => {
  sqlite?.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("receipt registration persistence", () => {
  it("keeps one stable imported ID, preserves corrections after failure, and prevents a second active claim", async () => {
    const saved = await stateModule.saveReceiptRegistrationDraft(values());
    expect(saved.merchant).toBe("人工店舗");
    expect(saved.importedId).toBe(`kakeimatch:receipt:${receiptA}`);

    const claim = await stateModule.claimReceiptRegistration("user-a", receiptA);
    expect(claim).toMatchObject({ status: "claimed", importedId: saved.importedId, totalAmountYen: 3284 });
    expect(await stateModule.claimReceiptRegistration("user-a", receiptA)).toEqual({ status: "busy" });
    await expect(stateModule.saveReceiptRegistrationDraft({ ...values(), merchant: "上書き不可" })).rejects.toThrow("registration_not_editable");
    if (claim.status !== "claimed") throw new Error("expected claim");

    expect(await stateModule.markReceiptRegistrationFailed({ receiptId: receiptA, token: claim.token }, "actual_unavailable")).toBe(true);
    const edited = await stateModule.saveReceiptRegistrationDraft({ ...values(), merchant: "修正店舗", totalAmountYen: 3400 });
    expect(edited).toMatchObject({ merchant: "修正店舗", totalAmountYen: 3400, status: "draft", importedId: saved.importedId });
    expect(await stateModule.getReceiptRegistrationDraft("user-a", receiptA)).toMatchObject({ lastErrorCode: "actual_unavailable" });

    const retryClaim = await stateModule.claimReceiptRegistration("user-a", receiptA);
    if (retryClaim.status !== "claimed") throw new Error("expected retry claim");
    sqlite.prepare("UPDATE receipt_registration SET claim_expires_at = ? WHERE receipt_id = ?")
      .run(Date.now() - 1, receiptA);
    await expect(stateModule.saveReceiptRegistrationDraft({ ...values(), merchant: "期限切れでも編集不可" })).rejects.toThrow("registration_not_editable");
    const recovered = await stateModule.claimReceiptRegistration("user-a", receiptA);
    expect(recovered).toMatchObject({ status: "claimed", merchant: "修正店舗", totalAmountYen: 3400, importedId: saved.importedId });
    if (recovered.status === "claimed") {
      await stateModule.markReceiptRegistrationFailed({ receiptId: receiptA, token: recovered.token }, "test_cleanup");
    }
  });

  it("requires owner scope, validates yen/date, and locks a successful registration", async () => {
    await expect(stateModule.saveReceiptRegistrationDraft(values("user-b", receiptA))).rejects.toThrow("receipt_not_found");
    await expect(stateModule.saveReceiptRegistrationDraft({ ...values("user-a", receiptB), totalAmountYen: 0 })).rejects.toThrow("invalid_amount");
    await expect(stateModule.saveReceiptRegistrationDraft({ ...values(), purchasedDate: "2026-02-30" })).rejects.toThrow("invalid_purchased_date");

    const claim = await stateModule.claimReceiptRegistration("user-a", receiptA);
    if (claim.status !== "claimed") throw new Error("expected claim");
    expect(await stateModule.markReceiptRegistrationSucceeded({ receiptId: receiptA, token: "stale-token" }, "tx-a")).toBe(false);
    expect(await stateModule.markReceiptRegistrationSucceeded({ receiptId: receiptA, token: claim.token }, "tx-a")).toBe(true);
    expect(await stateModule.claimReceiptRegistration("user-a", receiptA)).toEqual({ status: "registered" });
    await expect(stateModule.saveReceiptRegistrationDraft(values())).rejects.toThrow("registration_not_editable");
  });

  it("keeps the last account preference isolated by user", async () => {
    await stateModule.rememberLastUsedActualAccount("user-a", "account-a");
    expect(await stateModule.getLastUsedActualAccountId("user-a")).toBe("account-a");
    expect(await stateModule.getLastUsedActualAccountId("user-b")).toBeNull();
  });

  it("locks final values after an uncertain Actual write so recovery checks the same snapshot", async () => {
    await stateModule.saveReceiptRegistrationDraft(values("user-b", receiptB));
    const claim = await stateModule.claimReceiptRegistration("user-b", receiptB);
    if (claim.status !== "claimed") throw new Error("expected claim");
    await stateModule.markReceiptRegistrationFailed({ receiptId: receiptB, token: claim.token }, "actual_write_uncertain");
    await expect(stateModule.saveReceiptRegistrationDraft({ ...values("user-b", receiptB), merchant: "Changed" }))
      .rejects.toThrow("registration_not_editable");
    expect(await stateModule.getReceiptRegistrationDraft("user-b", receiptB)).toMatchObject({
      merchant: "人工店舗", importedId: `kakeimatch:receipt:${receiptB}`, lastErrorCode: "actual_write_uncertain",
    });
  });
});
