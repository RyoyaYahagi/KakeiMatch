import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

export interface StatementStorage {
  put(bytes: Buffer): Promise<{ storageKey: string }>;
  delete(storageKey: string): Promise<void>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class LocalStatementStorage implements StatementStorage {
  private readonly root: string;

  constructor(root: string) {
    if (!root.trim()) throw new Error("明細保存先の設定がありません。");
    this.root = path.resolve(root);
    const publicRoot = path.resolve(process.cwd(), "public");
    if (this.root === publicRoot || this.root.startsWith(`${publicRoot}${path.sep}`)) {
      throw new Error("明細保存先には公開ディレクトリ外を指定してください。");
    }
  }

  async put(bytes: Buffer): Promise<{ storageKey: string }> {
    await this.prepareRoot();
    const storageKey = randomUUID();
    await writeFile(this.filePath(storageKey), bytes, { flag: "wx", mode: 0o600 });
    return { storageKey };
  }

  async delete(storageKey: string): Promise<void> {
    await this.prepareRoot();
    await rm(this.filePath(storageKey), { force: true });
  }

  private filePath(storageKey: string): string {
    if (!uuidPattern.test(storageKey)) throw new Error("明細の保存キーが不正です。");
    return path.join(this.root, `${storageKey}.csv`);
  }

  private async prepareRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const actualRoot = await realpath(this.root);
    const publicRoot = path.resolve(process.cwd(), "public");
    let actualPublic = publicRoot;
    try { actualPublic = await realpath(publicRoot); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (actualRoot === actualPublic || actualRoot.startsWith(`${actualPublic}${path.sep}`)) {
      throw new Error("明細保存先には公開ディレクトリ外を指定してください。");
    }
  }
}

export const statementStorage: StatementStorage = new LocalStatementStorage(env.STATEMENT_STORAGE_DIR);
