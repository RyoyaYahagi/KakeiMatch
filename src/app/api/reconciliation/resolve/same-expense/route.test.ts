import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), confirm: vi.fn() }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/reconciliation-review-actions", () => ({
  ReconciliationActionError: class ReconciliationActionError extends Error {
    constructor(public code: string, public status: number, message: string) { super(message); }
  },
  confirmSameExpense: mocks.confirm,
}));
import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/reconciliation/resolve/same-expense", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("same-expense action authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.user.mockResolvedValue({ id: "session-user-a" });
    mocks.confirm.mockResolvedValue({ status: "applied", resolutionId: "resolution-a" });
  });

  it("rejects unauthenticated requests", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await POST(request({ runId: "run-a", statementTransactionId: "statement-a", receiptId: "receipt-a" }))).status).toBe(401);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("uses the session owner and ignores a forged user ID and Actual transaction ID", async () => {
    const response = await POST(request({
      runId: "run-a", statementTransactionId: "statement-a", receiptId: "receipt-a",
      userId: "user-b", actualTransactionId: "actual-b", syncId: "budget-b",
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith({
      userId: "session-user-a", runId: "run-a", statementTransactionId: "statement-a", receiptId: "receipt-a",
    });
  });

  it("returns a stale-run conflict without applying a decision", async () => {
    const { ReconciliationActionError } = await import("@/lib/reconciliation-review-actions");
    mocks.confirm.mockRejectedValue(new ReconciliationActionError("stale_run", 409, "照合結果が更新されています。画面を更新してください。"));
    const response = await POST(request({ runId: "old-run", statementTransactionId: "statement-a", receiptId: "receipt-a" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_run" });
  });
});
