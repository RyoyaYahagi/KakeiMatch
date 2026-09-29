import "server-only";

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { actualBudgetMapping } from "@/db/schema";
import { actualAmountToYen, ActualBudgetNotLinkedError, ActualUnavailableError, yenToActualAmount } from "@/lib/actual-gateway";
import { env } from "@/lib/env";

const CLI_SCRIPT = resolve(process.cwd(), "node_modules/@actual-app/cli/dist/cli.js");
const CLI_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const dateSchema = z.iso.date();

const accountRowsSchema = z.array(z.object({
  id: idSchema,
  name: z.string().min(1),
  closed: z.boolean(),
}));
const categoryRowsSchema = z.array(z.object({
  id: idSchema,
  name: z.string().min(1),
  is_income: z.boolean(),
  hidden: z.boolean(),
}));
const transactionRowsSchema = z.array(z.object({
  id: idSchema,
  account: idSchema,
  date: dateSchema,
  amount: z.number().int().safe(),
  "payee.name": z.string().nullable().optional(),
  category: idSchema.nullable(),
  cleared: z.boolean(),
  imported_id: z.string().min(1),
}));

export type ActualReceiptRecord = {
  id: string;
  accountId: string;
  date: string;
  amountYen: number;
  payeeName: string | null;
  categoryId: string | null;
  cleared: boolean;
  importedId: string;
};

export interface ActualReceiptWriter {
  listOpenAccounts(): Promise<{ id: string; name: string }[]>;
  listExpenseCategories(): Promise<{ id: string; name: string }[]>;
  findByImportedId(importedId: string): Promise<ActualReceiptRecord | null>;
  importReceipt(input: {
    accountId: string;
    date: string;
    amountYen: number;
    merchant: string;
    categoryId: string;
    importedId: string;
  }): Promise<void>;
  updateReceipt(id: string, changes: { categoryId?: string; cleared?: boolean }): Promise<void>;
}

type CliRunner = (userId: string, args: string[], stdin?: unknown) => Promise<unknown>;

function cacheDirectory(mappingId: string, syncId: string): string {
  const key = createHash("sha256").update(mappingId).update("\0").update(syncId).digest("hex");
  return resolve(env.ACTUAL_CLI_DATA_DIR, key);
}

async function runActualCli(userId: string, args: string[], input?: unknown): Promise<unknown> {
  if (!env.ACTUAL_SERVER_PASSWORD) throw new ActualUnavailableError("configuration");
  const [mapping] = await db.select({ id: actualBudgetMapping.id, syncId: actualBudgetMapping.syncId })
    .from(actualBudgetMapping).where(eq(actualBudgetMapping.userId, userId)).limit(1);
  if (!mapping) throw new ActualBudgetNotLinkedError();

  const dataDir = cacheDirectory(mapping.id, mapping.syncId);
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
  } catch {
    throw new ActualUnavailableError("configuration");
  }

  const childEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    PATH: process.env.PATH,
    HOME: dataDir,
    ACTUAL_SERVER_URL: env.ACTUAL_SERVER_URL,
    ACTUAL_PASSWORD: env.ACTUAL_SERVER_PASSWORD,
    ACTUAL_SYNC_ID: mapping.syncId,
    ACTUAL_DATA_DIR: dataDir,
    ACTUAL_CACHE_TTL: "60",
  };

  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI_SCRIPT, "--format", "json", ...args], {
      env: childEnv,
      cwd: dataDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (reason: "process" | "timeout" | "invalid_data") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new ActualUnavailableError(reason));
    };
    const timer = setTimeout(() => fail("timeout"), CLI_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) fail("invalid_data");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.stdin.on("error", () => fail("process"));
    child.on("error", () => fail("process"));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new ActualUnavailableError(/auth|password|unauthorized|forbidden/i.test(stderr) ? "authentication" : "process"));
        return;
      }
      if (!stdout.trim()) {
        resolveResult(null);
        return;
      }
      try {
        resolveResult(JSON.parse(stdout) as unknown);
      } catch {
        reject(new ActualUnavailableError("invalid_data"));
      }
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

function makeRecord(row: z.infer<typeof transactionRowsSchema>[number]): ActualReceiptRecord {
  return {
    id: row.id,
    accountId: row.account,
    date: row.date,
    amountYen: actualAmountToYen(row.amount, 1),
    payeeName: row["payee.name"] ?? null,
    categoryId: row.category,
    cleared: row.cleared,
    importedId: row.imported_id,
  };
}

export function createActualReceiptWriter(options: { userId: string; run?: CliRunner }): ActualReceiptWriter {
  const userId = idSchema.parse(options.userId);
  const run = options.run ?? runActualCli;

  return {
    async listOpenAccounts() {
      const parsed = accountRowsSchema.safeParse(await run(userId, ["accounts", "list"]));
      if (!parsed.success) throw new ActualUnavailableError("invalid_data");
      return parsed.data.filter((account) => !account.closed).map(({ id, name }) => ({ id, name }));
    },

    async listExpenseCategories() {
      const parsed = categoryRowsSchema.safeParse(await run(userId, ["categories", "list"]));
      if (!parsed.success) throw new ActualUnavailableError("invalid_data");
      return parsed.data.filter((category) => !category.hidden && !category.is_income)
        .map(({ id, name }) => ({ id, name }));
    },

    async findByImportedId(importedId) {
      const key = z.string().min(1).max(200).safeParse(importedId);
      if (!key.success) return null;
      const query = {
        table: "transactions",
        select: ["id", "account", "date", "amount", "payee.name", "category", "cleared", "imported_id"],
        filter: { imported_id: { $eq: key.data } },
        orderBy: [{ date: "desc" }],
      };
      const parsed = transactionRowsSchema.safeParse(await run(userId, ["query", "run", "--file", "-"], query));
      if (!parsed.success) throw new ActualUnavailableError("invalid_data");
      const row = parsed.data.find((candidate) => candidate.imported_id === key.data);
      return row ? makeRecord(row) : null;
    },

    async importReceipt(input) {
      const parsed = z.object({
        accountId: idSchema,
        date: dateSchema,
        amountYen: z.number().int().negative().safe(),
        merchant: z.string().trim().min(1).max(200),
        categoryId: idSchema,
        importedId: z.string().min(1).max(200),
      }).safeParse(input);
      if (!parsed.success) throw new Error("Invalid Actual receipt transaction.");
      const transaction = {
        date: parsed.data.date,
        amount: yenToActualAmount(parsed.data.amountYen, 1),
        payee_name: parsed.data.merchant,
        category: parsed.data.categoryId,
        imported_id: parsed.data.importedId,
        cleared: false,
      };
      await run(userId, ["transactions", "import", "--account", parsed.data.accountId, "--file", "-"], [transaction]);
    },

    async updateReceipt(id, changes) {
      const transactionId = idSchema.safeParse(id);
      const update = z.object({
        categoryId: idSchema.optional(),
        cleared: z.boolean().optional(),
      }).strict().safeParse(changes);
      if (!transactionId.success || !update.success || Object.keys(update.data).length === 0) {
        throw new Error("Invalid Actual receipt update.");
      }
      const fields = {
        ...(update.data.categoryId ? { category: update.data.categoryId } : {}),
        ...(update.data.cleared === undefined ? {} : { cleared: update.data.cleared }),
      };
      await run(userId, ["transactions", "update", transactionId.data, "--file", "-"], fields);
    },
  };
}

export function createActualReceiptWriterForUser(userId: string): ActualReceiptWriter {
  return createActualReceiptWriter({ userId });
}
