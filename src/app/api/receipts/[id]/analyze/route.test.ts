import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  storageGet: vi.fn(),
  storageDelete: vi.fn(),
  extract: vi.fn(),
  selectRows: [] as unknown[][],
  inserts: [] as Array<Record<string, unknown>>,
  select: vi.fn(),
  insertValues: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/current-user", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/receipt-storage", () => ({ receiptStorage: { get: mocks.storageGet, delete: mocks.storageDelete } }));
vi.mock("@/lib/gemini-receipt-extractor", () => ({
  DEFAULT_GEMINI_MODEL: "gemini-3.5-flash-lite",
  geminiReceiptExtractor: { extract: mocks.extract },
}));
vi.mock("@/db/client", () => ({ db: { select: mocks.select, insert: vi.fn(() => ({ values: mocks.insertValues })) } }));

import { GET } from "../analysis/route";
import { POST } from "./route";

const ownerReceipt = { storageKey: "opaque-key", contentType: "image/jpeg" };
const validResult = {
  documentKind: "receipt",
  merchant: "人工ストア",
  purchasedDate: "2026-09-28",
  purchasedTime: "18:20",
  totalAmountYen: 3284,
  taxAmountYen: null,
  items: [{ name: "人工商品", amountYen: 3284 }],
  warnings: [],
};

function request(path: string, method = "POST") {
  return new NextRequest(`http://localhost${path}`, { method });
}

function requestWithBody(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function context(id = "receipt-a") {
  return { params: Promise.resolve({ id }) };
}

function setupSelect(...rows: unknown[][]) {
  mocks.selectRows = [...rows];
  mocks.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({ limit: async () => mocks.selectRows.shift() ?? [] }),
    }),
  }));
}

describe("receipt analysis API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inserts.length = 0;
    setupSelect([ownerReceipt]);
    mocks.getCurrentUser.mockResolvedValue({ id: "user-a" });
    mocks.storageGet.mockResolvedValue(Buffer.from("synthetic image"));
    mocks.extract.mockResolvedValue(validResult);
    mocks.insertValues.mockImplementation((row: Record<string, unknown>) => {
      mocks.inserts.push(row);
      return { onConflictDoUpdate: mocks.upsert };
    });
    mocks.upsert.mockImplementation(async (query: Record<string, unknown>) => {
      mocks.inserts.push(query.set as Record<string, unknown>);
    });
    mocks.select.mockClear();
  });

  it("requires a session before reading receipt metadata", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await POST(request("/api/receipts/receipt-a/analyze"), context());
    expect(response.status).toBe(401);
    expect(mocks.storageGet).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("returns the same 404 for unknown and another user's receipt", async () => {
    setupSelect([], []);
    const unknown = await POST(request("/api/receipts/no-such-id/analyze"), context("no-such-id"));
    const otherUser = await POST(request("/api/receipts/receipt-b/analyze"), context("receipt-b"));
    expect(unknown.status).toBe(404);
    expect(otherUser.status).toBe(404);
    expect(await unknown.text()).toBe(await otherUser.text());
    expect(mocks.storageGet).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("rejects user B analyzing user A's receipt using the session owner", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-b" });
    setupSelect([]);
    const response = await POST(request("/api/receipts/receipt-a/analyze"), context());
    expect(response.status).toBe(404);
    expect(mocks.storageGet).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("fetches image using owner-scoped metadata before calling the extractor", async () => {
    const response = await POST(request("/api/receipts/receipt-a/analyze"), context());
    expect(response.status).toBe(200);
    expect(mocks.storageGet).toHaveBeenCalledWith("opaque-key");
    expect(mocks.extract).toHaveBeenCalledWith({ imageBytes: Buffer.from("synthetic image"), contentType: "image/jpeg" });
  });

  it("ignores client supplied userId and storageKey values", async () => {
    const response = await POST(requestWithBody("/api/receipts/receipt-a/analyze", { userId: "user-b", storageKey: "attacker-key" }), context());
    expect(response.status).toBe(200);
    expect(mocks.storageGet).toHaveBeenCalledWith("opaque-key");
    expect(mocks.storageGet).not.toHaveBeenCalledWith("attacker-key");
  });

  it("persists only validated successful structured results", async () => {
    await POST(request("/api/receipts/receipt-a/analyze"), context());
    const success = mocks.inserts.find((row) => row.status === "succeeded");
    expect(success).toMatchObject({ status: "succeeded", model: "gemini-3.5-flash-lite", promptVersion: "receipt-v1", resultJson: JSON.stringify(validResult) });
    expect(success).toHaveProperty("needsReview", false);
    expect(success).toHaveProperty("succeededAt");
  });

  it("rejects schema-invalid output instead of persisting it as success", async () => {
    mocks.extract.mockResolvedValue({ ...validResult, totalAmountYen: -4 });
    setupSelect([ownerReceipt], []);
    const response = await POST(request("/api/receipts/receipt-a/analyze"), context());
    expect(response.status).toBe(502);
    expect(mocks.inserts.some((row) => row.status === "succeeded")).toBe(false);
    expect(mocks.inserts.some((row) => row.lastErrorCode === "invalid_response")).toBe(true);
    expect(mocks.storageGet).toHaveBeenCalled();
  });

  it("retains receipt and previous successful extraction after provider failure, then permits retry", async () => {
    mocks.extract.mockRejectedValueOnce(new Error("private provider diagnostic"));
    setupSelect([ownerReceipt], [{
      status: "failed", model: "gemini-3.5-flash-lite", promptVersion: "receipt-v1",
      resultJson: JSON.stringify(validResult), needsReview: false,
      lastErrorCode: "provider_unavailable", attemptedAt: new Date(), succeededAt: new Date(),
    }]);
    const failed = await POST(request("/api/receipts/receipt-a/analyze"), context());
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("private provider diagnostic");
    expect(mocks.storageGet).toHaveBeenCalledTimes(1);
    expect(mocks.storageDelete).not.toHaveBeenCalled();
    expect(mocks.inserts.at(-1)).toMatchObject({ status: "failed" });
    expect(mocks.inserts.at(-1)).not.toHaveProperty("resultJson");
    expect(mocks.upsert).toHaveBeenCalled();

    mocks.extract.mockResolvedValueOnce(validResult);
    setupSelect([ownerReceipt]);
    const retried = await POST(request("/api/receipts/receipt-a/analyze"), context());
    expect(retried.status).toBe(200);
    expect((await retried.json()).status).toBe("succeeded");
    expect(mocks.storageGet).toHaveBeenCalledTimes(2);
  });

  it("returns private analysis state only to the owner", async () => {
    setupSelect([{ id: "receipt-a" }], [{ status: "succeeded", model: "gemini-3.5-flash-lite", promptVersion: "receipt-v1", resultJson: JSON.stringify(validResult), needsReview: false, lastErrorCode: null, attemptedAt: new Date(), succeededAt: new Date() }]);
    const response = await GET(request("/api/receipts/receipt-a/analysis", "GET"), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ status: "succeeded", result: validResult, needsReview: false });
  });
});
