import { describe, expect, it } from "vitest";
import { aiImageSize, MAX_AI_IMAGE_EDGE, prepareAiImage } from "../../apps/pwa/src/receipt-ai-image";

describe("AI receipt image size", () => {
  it("keeps images that already fit", () => {
    expect(aiImageSize(MAX_AI_IMAGE_EDGE, 1000)).toBeNull();
    expect(aiImageSize(1, 1)).toBeNull();
  });
  it("reduces the longest edge and keeps the aspect ratio for portrait, landscape and long receipts", () => {
    expect(aiImageSize(3024, 4032)).toEqual({ width: 1536, height: 2048 });
    expect(aiImageSize(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(aiImageSize(1000, 8000)).toEqual({ width: 256, height: 2048 });
    expect(aiImageSize(10, 100_000)).toEqual({ width: 1, height: 2048 });
  });
  it("sends the original bytes where the browser cannot reduce images", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    expect(await prepareAiImage(new Blob([bytes], { type: "image/png" }), "image/png")).toEqual({ bytes, contentType: "image/png" });
  });
});
