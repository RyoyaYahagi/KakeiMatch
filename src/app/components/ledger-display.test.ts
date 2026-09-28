import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/actual-gateway", () => ({
  ActualBudgetNotLinkedError: class ActualBudgetNotLinkedError extends Error {},
  ActualUnavailableError: class ActualUnavailableError extends Error {},
}));

import { ActualBudgetNotLinkedError, ActualUnavailableError } from "@/lib/actual-gateway";
import { getLedgerErrorMessage } from "./ledger-display";

describe("ledger error messages", () => {
  it("distinguishes an unlinked budget from an unavailable service", () => {
    expect(getLedgerErrorMessage(new ActualBudgetNotLinkedError())).toBe(
      "家計簿の準備がまだ完了していません。管理者に確認してください。",
    );
    expect(getLedgerErrorMessage(new ActualUnavailableError("process"))).toBe(
      "家計簿を読み込めませんでした。時間をおいてもう一度お試しください。",
    );
  });

  it("does not silently turn an unexpected error into a service error", () => {
    const error = new Error("unexpected");
    expect(() => getLedgerErrorMessage(error)).toThrow(error);
  });
});
