import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";
import type { ReceiptContentType } from "./receipt-validation";

export interface ReceiptStorage {
  put(input: { contentType: ReceiptContentType; bytes: Buffer }): Promise<{ storageKey: string }>;
  get(storageKey: string): Promise<Buffer | null>;
  delete(storageKey: string): Promise<void>;
}

const EXTENSIONS: Record<ReceiptContentType, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class LocalReceiptStorage implements ReceiptStorage {
  private readonly root: string;

  constructor(root = process.env.RECEIPT_STORAGE_DIR) {
    if (!root?.trim()) {
      throw new Error("レシート保存先の設定がありません。");
    }

    this.root = path.resolve(root);
    const publicDirectory = path.resolve(process.cwd(), "public");
    if (this.root === publicDirectory || this.root.startsWith(`${publicDirectory}${path.sep}`)) {
      throw new Error("レシート保存先には公開ディレクトリ外の場所を指定してください。");
    }
  }

  async put(input: { contentType: ReceiptContentType; bytes: Buffer }): Promise<{ storageKey: string }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 }).catch(() => {
      throw new Error("レシート保存先を利用できません。");
    });
    await this.assertOutsidePublicDirectory();

    const storageKey = randomUUID();
    await writeFile(this.filePath(storageKey, input.contentType), input.bytes, { flag: "wx", mode: 0o600 });
    return { storageKey };
  }

  async get(storageKey: string): Promise<Buffer | null> {
    const filePath = await this.findFile(storageKey);
    if (!filePath) return null;

    try {
      return await readFile(filePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw new Error("レシート画像を読み込めませんでした。");
    }
  }

  async delete(storageKey: string): Promise<void> {
    const filePath = await this.findFile(storageKey);
    if (!filePath) return;

    try {
      await rm(filePath, { force: true });
    } catch {
      throw new Error("レシート画像を削除できませんでした。");
    }
  }

  private filePath(storageKey: string, contentType: ReceiptContentType): string {
    if (!isUuid(storageKey)) throw new Error("レシートの保存キーが不正です。");
    return path.join(this.root, `${storageKey}${EXTENSIONS[contentType]}`);
  }

  private async findFile(storageKey: string): Promise<string | null> {
    if (!isUuid(storageKey)) throw new Error("レシートの保存キーが不正です。");
    await mkdir(this.root, { recursive: true, mode: 0o700 }).catch(() => {
      throw new Error("レシート保存先を利用できません。");
    });
    await this.assertOutsidePublicDirectory();
    for (const extension of Object.values(EXTENSIONS)) {
      const candidate = path.join(this.root, `${storageKey}${extension}`);
      try {
        await readFile(candidate);
        return candidate;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw new Error("レシート画像を読み込めませんでした。");
      }
    }
    return null;
  }

  private async assertOutsidePublicDirectory(): Promise<void> {
    const publicDirectory = path.resolve(process.cwd(), "public");
    let actualRoot: string;
    try {
      actualRoot = await realpath(this.root);
    } catch {
      throw new Error("レシート保存先を利用できません。");
    }
    let actualPublic: string;
    try {
      actualPublic = await realpath(publicDirectory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") actualPublic = publicDirectory;
      else throw new Error("レシート保存先を利用できません。");
    }
    if (actualRoot === actualPublic || actualRoot.startsWith(`${actualPublic}${path.sep}`)) {
      throw new Error("レシート保存先には公開ディレクトリ外の場所を指定してください。");
    }
  }
}

export const receiptStorage: ReceiptStorage = new LocalReceiptStorage(env.RECEIPT_STORAGE_DIR);

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
