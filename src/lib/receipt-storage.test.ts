import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalReceiptStorage } from "./receipt-storage";
import {
  MAX_RECEIPT_SIZE_BYTES,
  ReceiptValidationError,
  validateReceiptImage,
} from "./receipt-validation";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kakeimatch-receipt-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const syntheticImages = {
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]),
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  "image/webp": Buffer.from("RIFF0000WEBPsynthetic"),
} as const;

describe("receipt image validation", () => {
  it.each(Object.entries(syntheticImages))("accepts synthetic %s image bytes", (contentType, bytes) => {
    expect(validateReceiptImage({ bytes, declaredContentType: contentType })).toEqual({
      contentType,
      sizeBytes: bytes.length,
    });
  });

  it("rejects a MIME type that does not match the image signature", () => {
    expect(() =>
      validateReceiptImage({ bytes: syntheticImages["image/png"], declaredContentType: "image/jpeg" }),
    ).toThrow(ReceiptValidationError);
  });

  it("rejects unsupported formats with a Japanese validation error", () => {
    expect(() =>
      validateReceiptImage({ bytes: Buffer.from("GIF89a"), declaredContentType: "image/gif" }),
    ).toThrow("JPEG、PNG、WebP形式");
  });

  it("rejects files larger than 10 MiB", () => {
    expect(() =>
      validateReceiptImage({
        bytes: Buffer.alloc(MAX_RECEIPT_SIZE_BYTES + 1, 0),
        declaredContentType: "image/png",
      }),
    ).toThrow("10 MiB以下");
  });

  it("rejects empty or unrecognized bytes even when MIME claims an allowed type", () => {
    expect(() => validateReceiptImage({ bytes: Buffer.alloc(0), declaredContentType: "image/jpeg" })).toThrow(
      "画像ファイルを選択してください",
    );
    expect(() =>
      validateReceiptImage({ bytes: Buffer.from("not an image"), declaredContentType: "image/jpeg" }),
    ).toThrow("画像形式を確認できませんでした");
  });
});

describe("LocalReceiptStorage", () => {
  it("stores and reads image bytes using a generated key, then deletes them", async () => {
    const root = path.join(await makeTemporaryDirectory(), "private-receipts");
    const storage = new LocalReceiptStorage(root);
    const bytes = syntheticImages["image/png"];
    const { storageKey } = await storage.put({ contentType: "image/png", bytes });

    expect(storageKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await storage.get(storageKey)).toEqual(bytes);
    expect((await readFile(path.join(root, `${storageKey}.png`))).equals(bytes)).toBe(true);
    await storage.delete(storageKey);
    expect(await storage.get(storageKey)).toBeNull();
  });

  it("rejects storage roots inside the public directory", async () => {
    const cwd = process.cwd();
    const publicDirectory = path.join(cwd, "public");
    await mkdir(publicDirectory, { recursive: true });
    const root = path.join(publicDirectory, "receipt-test-storage");
    try {
      expect(() => new LocalReceiptStorage(root)).toThrow("公開ディレクトリ外");
    } finally {
      await rm(path.join(publicDirectory, "receipt-test-storage"), { recursive: true, force: true });
    }
  });

  it("rejects path traversal keys", async () => {
    const storage = new LocalReceiptStorage(await makeTemporaryDirectory());
    await expect(storage.get("../secret")).rejects.toThrow("保存キーが不正です");
    await expect(storage.delete("../secret")).rejects.toThrow("保存キーが不正です");
  });

  it("reports storage write failures without exposing filesystem paths", async () => {
    const base = await makeTemporaryDirectory();
    const rootIsFile = path.join(base, "not-a-directory");
    await writeFile(rootIsFile, "synthetic");
    const storage = new LocalReceiptStorage(rootIsFile);

    await expect(storage.put({ contentType: "image/jpeg", bytes: syntheticImages["image/jpeg"] })).rejects.toThrow(
      "レシート保存先を利用できません",
    );
  });
});
