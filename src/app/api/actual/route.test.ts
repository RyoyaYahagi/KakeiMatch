import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>(),
  getRecentTransactions: vi.fn(async () => [{ id: "owned-transaction", amountYen: -3284 }]),
  getTransactions: vi.fn(async () => []),
  getMonthlySpending: vi.fn(async () => 3284),
}));

vi.mock("@/lib/current-user", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/actual-gateway", () => ({
  ActualBudgetNotLinkedError: class extends Error {},
  ActualUnavailableError: class extends Error {},
  actualGateway: mocks,
}));

import { GET } from "./route";

describe("read-only Actual endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires a session before reading a budget", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/actual?view=recent"));
    expect(response.status).toBe(401);
    expect(mocks.getRecentTransactions).not.toHaveBeenCalled();
  });

  it("ignores client-supplied user and Sync IDs", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-a" });
    const response = await GET(new NextRequest("http://localhost/api/actual?view=recent&userId=user-b&syncId=budget-b"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "owned-transaction", amountYen: -3284 }]);
    expect(mocks.getRecentTransactions).toHaveBeenCalledWith({ limit: undefined });
  });
});
