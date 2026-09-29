import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  classify: vi.fn(),
  selectRows: [] as unknown[][],
  inserted: [] as Array<Record<string, unknown>>,
  select: vi.fn(),
  insertValues: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/current-user", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/jev-category-classifier", () => ({ classify: mocks.classify }));
vi.mock("@/db/client", () => ({ db: {
  select: mocks.select,
  insert: vi.fn(() => ({ values: mocks.insertValues })),
} }));

import { POST } from "./route";

const validExtraction = {
  documentKind: "receipt", merchant: "人工スーパー", purchasedDate: "2026-09-28", purchasedTime: null,
  totalAmountYen: 1800, taxAmountYen: null, items: [{ name: "人工商品", amountYen: 1800 }], warnings: [],
};

function request(id = "receipt-a") { return new NextRequest(`http://localhost/api/receipts/${id}/classify-category`, { method: "POST" }); }
function context(id = "receipt-a") { return { params: Promise.resolve({ id }) }; }

function setupSelect(...rows: unknown[][]) {
  mocks.selectRows = [...rows];
  mocks.select.mockImplementation(() => ({ from: () => ({
    where: () => ({ limit: async () => mocks.selectRows.shift() ?? [] }),
  }) }));
}

describe("receipt category classification API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inserted.length = 0;
    mocks.getCurrentUser.mockResolvedValue({ id: "user-a" });
    mocks.classify.mockResolvedValue({
      category: "food", selectedProbability: 0.9, confidence: 0.8,
      probabilities: { food: 0.9, household: 0.01, transport: 0.01, medical: 0.01, clothing: 0.01, entertainment: 0.01, utilities: 0.01, communications: 0.01, other: 0.03 },
      needsReview: false, source: "jev", model: "jev-latest", questionVersion: "receipt-category-v1",
    });
    mocks.insertValues.mockImplementation((row: Record<string, unknown>) => {
      mocks.inserted.push(row);
      return { onConflictDoUpdate: mocks.upsert };
    });
    mocks.upsert.mockResolvedValue(undefined);
  });

  it("uses a user's confirmed merchant rule before Jev", async () => {
    setupSelect([{ id: "receipt-a" }], [], [{ status: "succeeded", resultJson: JSON.stringify(validExtraction) }], [{ categoryId: "household" }], [], [{
      suggestedCategory: "household", source: "merchant_rule", needsReview: false,
      confirmedCategory: null, updatedAt: new Date(), attemptedAt: new Date(),
    }]);
    const response = await POST(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ suggestedCategory: "household", source: "merchant_rule", needsReview: false });
    expect(mocks.classify).not.toHaveBeenCalled();
  });

  it("does not classify when extraction is missing or is not a receipt", async () => {
    setupSelect([{ id: "receipt-a" }], [], []);
    const missing = await POST(request(), context());
    expect(missing.status).toBe(200);
    expect(mocks.classify).not.toHaveBeenCalled();

    setupSelect([{ id: "receipt-a" }], [], [{ status: "succeeded", resultJson: JSON.stringify({ ...validExtraction, documentKind: "not_receipt" }) }], [{ suggestedCategory: null, source: "unclassified", needsReview: true, confirmedCategory: null, attemptedAt: new Date(), updatedAt: new Date() }]);
    const notReceipt = await POST(request(), context());
    expect(notReceipt.status).toBe(200);
    expect(mocks.classify).not.toHaveBeenCalled();
  });

  it("keeps confirmed user categories out of later reclassification", async () => {
    setupSelect([{ id: "receipt-a" }], [{ suggestedCategory: "food", source: "user", needsReview: false, confirmedCategory: "household", attemptedAt: new Date(), updatedAt: new Date() }]);
    const response = await POST(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ suggestedCategory: "food", confirmedCategory: "household", source: "user" });
    expect(mocks.classify).not.toHaveBeenCalled();
  });

  it("rejects another user's receipt and ignores client-supplied extraction data", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-b" });
    setupSelect([]);
    const denied = await POST(request(), context());
    expect(denied.status).toBe(404);
    expect(mocks.classify).not.toHaveBeenCalled();

    mocks.getCurrentUser.mockResolvedValue({ id: "user-a" });
    setupSelect([{ id: "receipt-a" }], [], [{ status: "succeeded", resultJson: JSON.stringify(validExtraction) }], [], []);
    const withBody = new NextRequest("http://localhost/api/receipts/receipt-a/classify-category", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-b", merchant: "attacker input", items: [] }),
    });
    await POST(withBody, context());
    expect(mocks.classify).toHaveBeenCalledWith({ merchant: "人工スーパー", totalAmountYen: 1800, items: validExtraction.items });
  });
});
