import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>(),
  get: vi.fn(async (): Promise<Buffer | null> => Buffer.from("synthetic-image")),
  storageKey: "owner-key",
  selectedReceiptId: "receipt-a",
  selectedOwner: "user-a",
  selectedContentType: "image/png",
  scopedCondition: undefined as unknown,
}));

vi.mock("@/lib/current-user", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/receipt-storage", () => ({ receiptStorage: { get: mocks.get } }));
vi.mock("@/db/schema", () => ({ receipt: { id: "receipt.id", ownerUserId: "receipt.ownerUserId", storageKey: "receipt.storageKey", contentType: "receipt.contentType" } }));
vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: string) => [column, value],
  and: (...conditions: unknown[]) => conditions,
}));
vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          mocks.scopedCondition = condition;
          const pairs = condition as Array<[string, string]>;
          const requestedId = pairs.find(([column]) => column === "receipt.id")?.[1];
          const requestedOwner = pairs.find(([column]) => column === "receipt.ownerUserId")?.[1];
          const matches = requestedId === mocks.selectedReceiptId && requestedOwner === mocks.selectedOwner;
          return { limit: vi.fn(async () => matches ? [{ storageKey: mocks.storageKey, contentType: mocks.selectedContentType }] : []) };
        }),
      })),
    })),
  },
}));

import { GET } from "./route";

async function imageRequest(id: string) {
  return GET(new NextRequest(`http://localhost/api/receipts/${id}/image`), { params: Promise.resolve({ id }) });
}

describe("receipt image authorization endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-a" });
    mocks.storageKey = "owner-key";
    mocks.selectedReceiptId = "receipt-a";
    mocks.selectedOwner = "user-a";
    mocks.get.mockResolvedValue(Buffer.from("synthetic-image"));
  });

  it("scopes metadata lookup by receipt ID and session owner before loading storage", async () => {
    const response = await imageRequest("receipt-a");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("synthetic-image");
    expect(mocks.scopedCondition).toEqual([["receipt.id", "receipt-a"], ["receipt.ownerUserId", "user-a"]]);
    expect(mocks.get).toHaveBeenCalledWith("owner-key");
  });

  it("returns identical 404 responses for unknown and other-user receipt IDs", async () => {
    const unknown = await imageRequest("does-not-exist");
    expect(unknown.status).toBe(404);
    mocks.getCurrentUser.mockResolvedValue({ id: "user-b" });
    const otherUser = await imageRequest("receipt-a");
    expect(otherUser.status).toBe(404);
    expect(await unknown.text()).toBe(await otherUser.text());
    expect(unknown.headers.get("cache-control")).toBe(otherUser.headers.get("cache-control"));
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated image reads", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await imageRequest("receipt-a");
    expect(response.status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("returns 404 when metadata exists but its stored image is missing", async () => {
    mocks.get.mockResolvedValue(null);
    const response = await imageRequest("receipt-a");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
