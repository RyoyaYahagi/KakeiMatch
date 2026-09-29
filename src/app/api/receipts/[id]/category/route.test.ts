import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  selectRows: [] as unknown[][],
  inserted: [] as Array<Record<string, unknown>>,
  select: vi.fn(),
  insertValues: vi.fn(),
  upsert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/current-user", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/db/client", () => ({ db: {
  select: mocks.select,
  insert: vi.fn(() => ({ values: mocks.insertValues })),
  transaction: mocks.transaction,
} }));

import { GET, PUT } from "./route";

function request(path: string, method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

function context(id = "receipt-a") { return { params: Promise.resolve({ id }) }; }

function setupSelect(...rows: unknown[][]) {
  mocks.selectRows = [...rows];
  mocks.select.mockImplementation(() => ({ from: () => ({
    where: () => ({ limit: async () => mocks.selectRows.shift() ?? [] }),
  }) }));
}

describe("receipt category API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inserted.length = 0;
    mocks.getCurrentUser.mockResolvedValue({ id: "user-a" });
    mocks.insertValues.mockImplementation((row: Record<string, unknown>) => {
      mocks.inserted.push(row);
      return { onConflictDoUpdate: mocks.upsert };
    });
    mocks.upsert.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (operation: (tx: unknown) => Promise<void>) => operation({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      insert: () => ({ values: mocks.insertValues }),
    }));
  });

  it("returns the same 404 for another user's and unknown receipts", async () => {
    setupSelect([], []);
    const other = await GET(request("/api/receipts/receipt-b/category"), context("receipt-b"));
    const missing = await GET(request("/api/receipts/missing/category"), context("missing"));
    expect(other.status).toBe(404);
    expect(await other.text()).toBe(await missing.text());
  });

  it("rejects categories outside the ID allowlist", async () => {
    const response = await PUT(request("/api/receipts/receipt-a/category", "PUT", { categoryId: "not-a-category" }), context());
    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("does not let user B confirm user A's receipt", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-b" });
    setupSelect([]);
    const response = await PUT(request("/api/receipts/receipt-a/category", "PUT", { categoryId: "food" }), context());
    expect(response.status).toBe(404);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("requires a valid saved receipt extraction before confirmation", async () => {
    setupSelect([{ id: "receipt-a" }], []);
    const response = await PUT(request("/api/receipts/receipt-a/category", "PUT", { categoryId: "food" }), context());
    expect(response.status).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("does not change a confirmed category while its Actual registration is active", async () => {
    const extraction = {
      documentKind: "receipt", merchant: "Synthetic Shop", purchasedDate: "2026-09-28",
      purchasedTime: null, totalAmountYen: 100, taxAmountYen: null, items: [], warnings: [],
    };
    setupSelect([{ id: "receipt-a" }], [{ status: "succeeded", resultJson: JSON.stringify(extraction) }], [{ status: "registering" }]);
    const response = await PUT(request("/api/receipts/receipt-a/category", "PUT", { categoryId: "food" }), context());
    expect(response.status).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
