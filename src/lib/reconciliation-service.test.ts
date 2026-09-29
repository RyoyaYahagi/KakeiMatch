import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inputs: vi.fn(), save: vi.fn(), latest: vi.fn(), engine: vi.fn(), aliasKey: vi.fn() }));
vi.mock("@/lib/reconciliation-repository", () => ({
  getReconciliationInputs: mocks.inputs,
  saveReconciliationRun: mocks.save,
  getLatestReconciliationRun: mocks.latest,
}));
vi.mock("@/lib/reconciliation-engine", () => ({
  merchantAliasKey: mocks.aliasKey,
  runReconciliationEngine: mocks.engine,
}));
import { getLatestReconciliation, runReconciliation } from "./reconciliation-service";

describe("reconciliation service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.inputs.mockResolvedValue({
      statements: [{ statementTransactionId: "s-a", provider: "synthetic", externalId: null, kind: "purchase", usedDate: "2026-09-29", postedDate: null, merchant: "人工商店", amountYen: 1000, paymentMethod: null }],
      receipts: [{ receiptId: "r-a", actualTransactionId: "actual-a", merchant: "人工商店", purchasedDate: "2026-09-29", amountYen: 1000, actualAccountId: "account-a" }],
      aliases: [{ normalizedMerchant: "人工商店", normalizedAlias: "人工店舗" }],
    });
    mocks.aliasKey.mockReturnValue("alias-key");
    mocks.engine.mockReturnValue({ ruleVersion: "1.0.0", candidates: [], statementResults: [{ status: "matched" }], receiptResults: [{ status: "matched" }] });
    mocks.save.mockResolvedValue("run-a");
  });

  it("passes only the owner-scoped inputs to the pure engine and saves a new run", async () => {
    const summary = await runReconciliation("user-a");
    expect(mocks.inputs).toHaveBeenCalledExactlyOnceWith("user-a");
    expect(mocks.engine).toHaveBeenCalledWith(expect.objectContaining({ aliases: new Set(["alias-key"]) }));
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: "user-a", ruleVersion: "1.0.0" }));
    expect(summary.statementCounts.matched).toBe(1);
  });

  it("rejects an unexpected statement kind before persistence", async () => {
    mocks.inputs.mockResolvedValueOnce({ statements: [{ kind: "unknown" }], receipts: [], aliases: [] });
    await expect(runReconciliation("user-a")).rejects.toThrow("invalid_statement_kind");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("passes owner scope to the latest completed snapshot reader", async () => {
    mocks.latest.mockResolvedValue({ runId: "run-a" });
    expect(await getLatestReconciliation("user-a")).toEqual({ runId: "run-a" });
    expect(mocks.latest).toHaveBeenCalledExactlyOnceWith("user-a");
  });
});
