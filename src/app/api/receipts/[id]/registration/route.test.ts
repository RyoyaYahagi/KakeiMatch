import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(), select: vi.fn(), getDraft: vi.fn(), getPreference: vi.fn(), listAccounts: vi.fn(),
}));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/receipt-registration-state", () => ({
  getReceiptRegistrationDraft: mocks.getDraft, getLastUsedActualAccountId: mocks.getPreference,
}));
vi.mock("@/lib/actual-receipt-writer", () => ({
  createActualReceiptWriterForUser: () => ({ listOpenAccounts: mocks.listAccounts }),
}));

import { GET } from "./route";

const context = { params: Promise.resolve({ id: "receipt-a" }) };
const request = () => new NextRequest("http://localhost/api/receipts/receipt-a/registration");

describe("receipt registration status API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-a" });
    mocks.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "receipt-a" }] }) }) }));
    mocks.getDraft.mockResolvedValue({ merchant: "Correction", purchasedDate: "2026-09-28", totalAmountYen: 100,
      actualAccountId: "account-a", status: "failed", registeredAt: null, importedId: "private-key", actualTransactionId: null });
    mocks.getPreference.mockResolvedValue("account-a");
    mocks.listAccounts.mockResolvedValue([{ id: "account-a", name: "Cash" }]);
  });

  it("returns only owned draft values and current open accounts", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.preferredAccountId).toBe("account-a");
    expect(body.draft).toMatchObject({ merchant: "Correction", status: "failed" });
    expect(JSON.stringify(body)).not.toContain("private-key");
  });

  it("returns 404 before loading another user's draft or Budget", async () => {
    mocks.select.mockImplementationOnce(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }));
    expect((await GET(request(), context)).status).toBe(404);
    expect(mocks.getDraft).not.toHaveBeenCalled();
    expect(mocks.listAccounts).not.toHaveBeenCalled();
  });

  it("keeps the draft visible when Actual is unavailable", async () => {
    mocks.listAccounts.mockRejectedValueOnce(new Error("private actual diagnostic"));
    const response = await GET(request(), context);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.draft.merchant).toBe("Correction");
    expect(body.accounts).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("private actual diagnostic");
  });
});
