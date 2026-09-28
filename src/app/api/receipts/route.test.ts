import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>(),
  put: vi.fn(async () => ({ storageKey: "storage-key" })),
  get: vi.fn(async () => null as Buffer | null),
  delete: vi.fn(async () => {}),
  insertValues: vi.fn(async () => {}),
  queryCondition: undefined as unknown,
}));

vi.mock("@/lib/current-user", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/receipt-storage", () => ({
  receiptStorage: { put: mocks.put, get: mocks.get, delete: mocks.delete },
}));
vi.mock("@/db/client", () => ({
  db: {
    insert: vi.fn(() => ({ values: mocks.insertValues })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          mocks.queryCondition = condition;
          return { limit: vi.fn(async () => []) };
        }),
      })),
    })),
  },
}));

import { POST } from "./route";

function fileBytes(type: "image/jpeg" | "image/png" | "image/webp"): Buffer {
  if (type === "image/jpeg") return Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  if (type === "image/png") return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.from("RIFF0000WEBP", "ascii");
}

async function upload(bytes: Buffer, contentType: string, extra: Record<string, string> = {}, claimedUserId?: string) {
  const form = new FormData();
  form.set("image", new File([new Uint8Array(bytes)], "private-original-name.jpg", { type: contentType }));
  if (claimedUserId) form.set("userId", claimedUserId);
  return POST(new NextRequest("http://localhost/api/receipts", {
    method: "POST",
    headers: extra,
    body: form,
  }));
}

describe("receipt upload endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: "session-user-a" });
    mocks.put.mockResolvedValue({ storageKey: "storage-key" });
    mocks.insertValues.mockResolvedValue(undefined);
  });

  it.each(["image/jpeg", "image/png", "image/webp"] as const)("accepts %s and assigns session ownership", async (contentType) => {
    const response = await upload(fileBytes(contentType), contentType);
    expect(response.status).toBe(201);
    expect(mocks.put).toHaveBeenCalledWith({ bytes: fileBytes(contentType), contentType });
    expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: "session-user-a",
      storageKey: "storage-key",
      contentType,
      fileSize: fileBytes(contentType).length,
    }));
    expect(await response.json()).not.toHaveProperty("storageKey");
  });

  it("rejects unauthenticated uploads before parsing or saving", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await upload(fileBytes("image/jpeg"), "image/jpeg");
    expect(response.status).toBe(401);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("ignores a userId supplied in the form", async () => {
    const response = await upload(fileBytes("image/jpeg"), "image/jpeg", {}, "session-user-b");
    expect(response.status).toBe(201);
    expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: "session-user-a" }));
  });

  it("rejects a MIME type that disagrees with the image signature", async () => {
    const response = await upload(fileBytes("image/png"), "image/jpeg");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("一致しません") });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("rejects unsupported image formats with a Japanese message", async () => {
    const response = await upload(Buffer.from("synthetic unsupported image"), "image/gif");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("JPEG、PNG、WebP") });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("rejects files over 10 MiB", async () => {
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1);
    bytes.set(fileBytes("image/jpeg"));
    const response = await upload(bytes, "image/jpeg");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("10 MiB") });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("cleans up stored bytes when metadata insertion fails", async () => {
    mocks.insertValues.mockRejectedValue(new Error("database failure with path /private"));
    const response = await upload(fileBytes("image/jpeg"), "image/jpeg");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("/private");
    expect(mocks.delete).toHaveBeenCalledWith("storage-key");
  });

  it("does not expose storage failures", async () => {
    mocks.put.mockRejectedValue(new Error("/private/receipt-data"));
    const response = await upload(fileBytes("image/jpeg"), "image/jpeg");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("receipt-data");
  });
});
