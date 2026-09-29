import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "kakeimatch-category-state-"));
const databasePath = join(directory, "category.sqlite");
const testEnvironment = process.env as Record<string, string | undefined>;
testEnvironment.NODE_ENV = "test";
testEnvironment.APP_URL = "http://localhost:3000";
testEnvironment.DATABASE_PATH = databasePath;
testEnvironment.AUTH_SECRET = "test-only-auth-secret-at-least-32-characters-long";

type StateModule = typeof import("./receipt-category-state");
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

beforeAll(async () => {
  stateModule = await import("./receipt-category-state");
  sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  insertUser("user-a", "a@example.test");
  insertUser("user-b", "b@example.test");
  insertReceipt("receipt-a", "user-a");
  insertReceipt("receipt-b", "user-b");
  const now = Date.now();
  sqlite.prepare("INSERT INTO receipt_extraction (receipt_id, status, result_json, updated_at) VALUES (?, ?, ?, ?)")
    .run("receipt-b", "succeeded", JSON.stringify({
      documentKind: "receipt", merchant: null, purchasedDate: null, purchasedTime: null,
      totalAmountYen: 100, taxAmountYen: null, items: [{ name: "人工商品", amountYen: 100 }], warnings: [],
    }), now);
});

afterAll(() => {
  sqlite?.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("receipt category persistence", () => {
  it("keeps confirmed merchant rules isolated by user and lets corrections replace only that user's rule", async () => {
    await stateModule.confirmReceiptCategory({ receiptId: "receipt-a", userId: "user-a", categoryId: "medical", merchant: " ＡＢＣ 薬局 " });
    expect(await stateModule.findMerchantCategoryMapping("user-a", "ABC 薬局")).toBe("medical");
    expect(await stateModule.findMerchantCategoryMapping("user-b", "ABC 薬局")).toBeNull();

    await stateModule.confirmReceiptCategory({ receiptId: "receipt-a", userId: "user-a", categoryId: "household", merchant: "ABC 薬局" });
    expect(await stateModule.findMerchantCategoryMapping("user-a", "ABC 薬局")).toBe("household");
    expect(await stateModule.findMerchantCategoryMapping("user-b", "ABC 薬局")).toBeNull();
  });

  it("preserves a user confirmation when a later suggestion is saved and exposes the Issue #10 handoff", async () => {
    await stateModule.confirmReceiptCategory({ receiptId: "receipt-b", userId: "user-b", categoryId: "food", merchant: null });
    await stateModule.saveCategorySuggestion({
      receiptId: "receipt-b", suggestedCategory: "other", selectedProbability: 0.83, confidence: 0.7,
      probabilities: { food: 0.02, household: 0.02, transport: 0.02, medical: 0.02, clothing: 0.02, entertainment: 0.02, utilities: 0.02, communications: 0.03, other: 0.83 },
      source: "jev", needsReview: false, model: "jev-latest", questionVersion: "receipt-category-v1", attemptedAt: new Date(),
    });

    const state = sqlite.prepare("SELECT suggested_category, confirmed_category, source, needs_review FROM receipt_category WHERE receipt_id = ?").get("receipt-b");
    expect(state).toEqual({ suggested_category: "other", confirmed_category: "food", source: "user", needs_review: 0 });
    expect(await stateModule.getConfirmedReceiptCategory("user-b", "receipt-b")).toEqual({ receiptId: "receipt-b", categoryId: "food" });
    expect(await stateModule.getConfirmedReceiptCategory("user-a", "receipt-b")).toBeNull();
    sqlite.prepare("UPDATE receipt_extraction SET result_json = ? WHERE receipt_id = ?")
      .run(JSON.stringify({
        documentKind: "not_receipt", merchant: null, purchasedDate: null, purchasedTime: null,
        totalAmountYen: null, taxAmountYen: null, items: [], warnings: [],
      }), "receipt-b");
    expect(await stateModule.getConfirmedReceiptCategory("user-b", "receipt-b")).toBeNull();
  });
});
