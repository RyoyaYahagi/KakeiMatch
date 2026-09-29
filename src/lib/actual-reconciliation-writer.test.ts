import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWriter: vi.fn(),
  receiptWriter: {
    listOpenAccounts: vi.fn(),
    listExpenseCategories: vi.fn(),
    findByImportedId: vi.fn(),
    importReceipt: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/actual-receipt-writer", () => ({ createActualReceiptWriter: mocks.createWriter }));

import { createActualReconciliationWriter, type ActualReconciliationUpdate } from "@/lib/actual-reconciliation-writer";

describe("Actual reconciliation writer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createWriter.mockReturnValue(mocks.receiptWriter);
  });

  it("batches cleared updates and omits amount unless supplied by an explicit user decision", async () => {
    const runBatch = vi.fn<(...args: [string, ActualReconciliationUpdate[]]) => Promise<void>>(async () => undefined);
    const actual = createActualReconciliationWriter({ userId: "user-a", runBatch });

    await actual.applyTransactionUpdates([
      { transactionId: "automatic-1", cleared: true },
      { transactionId: "confirmed-2", cleared: true, amountYen: -3280 },
    ]);

    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(runBatch).toHaveBeenCalledWith("user-a", [
      { transactionId: "automatic-1", cleared: true },
      { transactionId: "confirmed-2", cleared: true, amountYen: -3280 },
    ]);
    expect(runBatch.mock.calls[0]?.[1][0]).not.toHaveProperty("amountYen");
  });

  it("rejects duplicate transaction IDs and positive statement amounts before applying", async () => {
    const runBatch = vi.fn<(...args: [string, ActualReconciliationUpdate[]]) => Promise<void>>(async () => undefined);
    const actual = createActualReconciliationWriter({ userId: "user-a", runBatch });

    await expect(actual.applyTransactionUpdates([
      { transactionId: "same", cleared: true },
      { transactionId: "same", cleared: true },
    ])).rejects.toThrow("Invalid Actual reconciliation batch.");
    await expect(actual.applyTransactionUpdates([
      { transactionId: "transaction-1", cleared: true, amountYen: 3280 },
    ])).rejects.toThrow("Invalid Actual reconciliation batch.");
    expect(runBatch).not.toHaveBeenCalled();
  });

  it("imports no-receipt transaction with stable ID, marks cleared, and verifies read-back", async () => {
    const record = {
      id: "actual-1", accountId: "cash", date: "2026-09-28", amountYen: -3280,
      payeeName: "Synthetic Shop", categoryId: "food", cleared: false,
      importedId: "kakeimatch:statement:statement-1",
    };
    mocks.receiptWriter.findByImportedId.mockResolvedValueOnce(null).mockResolvedValueOnce(record)
      .mockResolvedValueOnce({ ...record, cleared: true });
    const runBatch = vi.fn<(...args: [string, ActualReconciliationUpdate[]]) => Promise<void>>(async () => undefined);
    const actual = createActualReconciliationWriter({ userId: "user-a", runBatch });

    await expect(actual.importNoReceipt({
      accountId: "cash", date: "2026-09-28", amountYen: -3280, merchant: "Synthetic Shop",
      categoryId: "food", importedId: "kakeimatch:statement:statement-1",
    })).resolves.toMatchObject({ id: "actual-1", cleared: true });

    expect(mocks.receiptWriter.importReceipt).toHaveBeenCalledWith({
      accountId: "cash", date: "2026-09-28", amountYen: -3280, merchant: "Synthetic Shop",
      categoryId: "food", importedId: "kakeimatch:statement:statement-1",
    });
    expect(runBatch).toHaveBeenCalledWith("user-a", [{ transactionId: "actual-1", cleared: true }]);
    expect(mocks.receiptWriter.findByImportedId).toHaveBeenCalledTimes(3);
  });

  it("reuses an imported row on retry instead of importing it again", async () => {
    const record = {
      id: "actual-1", accountId: "cash", date: "2026-09-28", amountYen: -3280,
      payeeName: "Synthetic Shop", categoryId: "food", cleared: true,
      importedId: "kakeimatch:statement:statement-1",
    };
    mocks.receiptWriter.findByImportedId.mockResolvedValueOnce(record).mockResolvedValueOnce(record)
      .mockResolvedValueOnce(record);
    const actual = createActualReconciliationWriter({ userId: "user-a", runBatch: vi.fn() });

    await actual.importNoReceipt({
      accountId: "cash", date: "2026-09-28", amountYen: -3280, merchant: "Synthetic Shop",
      categoryId: "food", importedId: "kakeimatch:statement:statement-1",
    });

    expect(mocks.receiptWriter.importReceipt).not.toHaveBeenCalled();
  });
});
