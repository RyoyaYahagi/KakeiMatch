import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(), select: vi.fn(), getDraft: vi.fn(), getCategory: vi.fn(),
  saveDraft: vi.fn(), claim: vi.fn(), markFailed: vi.fn(), markSucceeded: vi.fn(),
  rememberAccount: vi.fn(), resolveCategory: vi.fn(),
  listAccounts: vi.fn(), listCategories: vi.fn(), find: vi.fn(), importReceipt: vi.fn(), updateReceipt: vi.fn(),
}));

vi.mock("@/lib/current-user", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/receipt-category-state", () => ({ getConfirmedReceiptCategory: mocks.getCategory }));
vi.mock("@/lib/receipt-registration-state", () => ({
  getReceiptRegistrationDraft: mocks.getDraft, saveReceiptRegistrationDraft: mocks.saveDraft,
  claimReceiptRegistration: mocks.claim, markReceiptRegistrationFailed: mocks.markFailed,
  markReceiptRegistrationSucceeded: mocks.markSucceeded, rememberLastUsedActualAccount: mocks.rememberAccount,
}));
vi.mock("@/lib/actual-category-resolution", () => ({
  ActualCategorySetupRequiredError: class ActualCategorySetupRequiredError extends Error {},
  resolveActualCategory: mocks.resolveCategory,
}));
vi.mock("@/lib/actual-receipt-writer", () => ({ createActualReceiptWriterForUser: () => ({
  listOpenAccounts: mocks.listAccounts, listExpenseCategories: mocks.listCategories,
  findByImportedId: mocks.find, importReceipt: mocks.importReceipt, updateReceipt: mocks.updateReceipt,
}) }));

import { POST } from "./route";

const receiptId = "123e4567-e89b-12d3-a456-426614174000";
const importedId = `kakeimatch:receipt:${receiptId}`;
const input = { merchant: "Synthetic Market", purchasedDate: "2026-09-28", totalAmountYen: 3284, actualAccountId: "account-a" };
const claim = { status: "claimed", token: "claim-a", importedId, ...input, categoryId: "food" };
const record = { id: "transaction-a", accountId: "account-a", date: input.purchasedDate, amountYen: -3284,
  payeeName: input.merchant, categoryId: "category-a", cleared: false, importedId };
const context = { params: Promise.resolve({ id: receiptId }) };

function request(body: unknown = input) {
  return new NextRequest(`http://localhost/api/receipts/${receiptId}/register`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("receipt registration API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-a" });
    mocks.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => [{ id: receiptId }] }) }) }));
    mocks.getDraft.mockResolvedValue(null);
    mocks.getCategory.mockResolvedValue({ categoryId: "food" });
    mocks.saveDraft.mockResolvedValue({});
    mocks.claim.mockResolvedValue(claim);
    mocks.markSucceeded.mockResolvedValue(true);
    mocks.markFailed.mockResolvedValue(true);
    mocks.listAccounts.mockResolvedValue([{ id: "account-a", name: "Cash" }]);
    mocks.listCategories.mockResolvedValue([{ id: "category-a", name: "食費" }]);
    mocks.resolveCategory.mockResolvedValue("category-a");
    mocks.find.mockResolvedValueOnce(null).mockResolvedValue(record);
  });

  it("requires authentication and the owner's receipt", async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    expect((await POST(request(), context)).status).toBe(401);
    mocks.select.mockImplementationOnce(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }));
    expect((await POST(request(), context)).status).toBe(404);
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });

  it("rejects account IDs absent from the session user's open accounts", async () => {
    const result = await POST(request({ ...input, actualAccountId: "other-user-account" }), context);
    expect(result.status).toBe(409);
    expect(mocks.saveDraft).toHaveBeenCalled();
    expect(mocks.importReceipt).not.toHaveBeenCalled();
  });

  it("rejects missing confirmation and invalid final values", async () => {
    mocks.getCategory.mockResolvedValueOnce(null);
    expect((await POST(request(), context)).status).toBe(409);
    expect((await POST(request({ ...input, totalAmountYen: 0 }), context)).status).toBe(400);
    expect(mocks.importReceipt).not.toHaveBeenCalled();
  });

  it("imports one negative expense and stores the resulting transaction ID", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.importReceipt).toHaveBeenCalledWith({
      accountId: "account-a", date: input.purchasedDate, amountYen: -3284,
      merchant: input.merchant, categoryId: "category-a", importedId,
    });
    expect(mocks.markSucceeded).toHaveBeenCalledWith({ receiptId, token: "claim-a" }, "transaction-a");
  });

  it("recovers by imported ID without adding a second transaction", async () => {
    mocks.find.mockReset().mockResolvedValue(record);
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.importReceipt).not.toHaveBeenCalled();
    expect(mocks.markSucceeded).toHaveBeenCalled();
  });

  it("recovers an expired registering claim without editing its saved snapshot", async () => {
    mocks.getDraft.mockResolvedValueOnce({ status: "registering", actualAccountId: "account-a", categoryId: "food" });
    mocks.find.mockReset().mockResolvedValue(record);
    const response = await POST(request({}), context);
    expect(response.status).toBe(200);
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(mocks.importReceipt).not.toHaveBeenCalled();
  });

  it("recovers a failed uncertain write without changing its saved snapshot", async () => {
    mocks.getDraft.mockResolvedValueOnce({ status: "failed", lastErrorCode: "actual_write_uncertain", actualAccountId: "account-a", categoryId: "food" });
    mocks.find.mockReset().mockResolvedValue(record);
    const response = await POST(request({}), context);
    expect(response.status).toBe(200);
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(mocks.importReceipt).not.toHaveBeenCalled();
  });

  it("corrects category rules and cleared state before marking registered", async () => {
    mocks.find.mockReset().mockResolvedValueOnce({ ...record, categoryId: "rule-category", cleared: true }).mockResolvedValue(record);
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.updateReceipt).toHaveBeenCalledWith("transaction-a", { categoryId: "category-a", cleared: false });
  });

  it("keeps the draft after an Actual outage or DB finalization failure", async () => {
    mocks.importReceipt.mockRejectedValueOnce(new Error("private server details"));
    const failed = await POST(request(), context);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private server details");
    expect(mocks.markFailed).toHaveBeenCalled();

    mocks.importReceipt.mockClear();
    mocks.find.mockReset().mockResolvedValue(record);
    mocks.markSucceeded.mockRejectedValueOnce(new Error("database unavailable"));
    expect((await POST(request(), context)).status).toBe(503);
    expect(mocks.importReceipt).not.toHaveBeenCalled();
  });

  it("returns success for a registered receipt without another write", async () => {
    mocks.getDraft.mockResolvedValueOnce({ status: "registered" });
    expect((await POST(request(), context)).status).toBe(200);
    expect(mocks.importReceipt).not.toHaveBeenCalled();
  });
});
