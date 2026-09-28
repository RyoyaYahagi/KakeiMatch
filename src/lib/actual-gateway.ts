import "server-only";

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { actualBudgetMapping } from "@/db/schema";
import { requireUser } from "@/lib/current-user";
import { env } from "@/lib/env";

const CLI_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CLI_SCRIPT = resolve(process.cwd(), "node_modules/@actual-app/cli/dist/cli.js");

export class ActualBudgetNotLinkedError extends Error {
  constructor() {
    super("Actual Budget is not linked to this account.");
    this.name = "ActualBudgetNotLinkedError";
  }
}

export class ActualUnavailableError extends Error {
  constructor(readonly reason: "configuration" | "process" | "timeout" | "authentication" | "invalid_data") {
    super("Actual Budget is unavailable.");
    this.name = "ActualUnavailableError";
  }
}

const transactionRowSchema = z.object({
  id: z.string().min(1),
  date: z.iso.date(),
  amount: z.number().int().safe(),
  account: z.string().min(1),
  "payee.name": z.string().nullable().optional(),
  "category.name": z.string().nullable().optional(),
  cleared: z.boolean().nullable().optional(),
  transfer_id: z.string().nullable().optional(),
  is_parent: z.boolean().optional(),
  is_child: z.boolean().optional(),
});
const rowsSchema = z.array(transactionRowSchema);
type TransactionRow = z.infer<typeof transactionRowSchema>;

/** Signed integer yen: an outflow is negative, an inflow is positive. */
export type ActualTransaction = {
  id: string;
  date: string;
  amountYen: number;
  kind: "expense" | "income" | "transfer";
  payeeName: string | null;
  categoryName: string | null;
  accountId: string;
  cleared: boolean;
};

export interface ActualGateway {
  getRecentTransactions(params?: { limit?: number }): Promise<ActualTransaction[]>;
  getTransactions(params: { startDate: string; endDate: string }): Promise<ActualTransaction[]>;
  getTransactionById(id: string): Promise<ActualTransaction | null>;
  /** Positive integer yen spent during the specified calendar month. */
  getMonthlySpending(params: { yearMonth: string }): Promise<number>;
}

export function actualAmountToYen(amount: number, unitsPerYen: number): number {
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(unitsPerYen) || unitsPerYen < 1 || amount % unitsPerYen !== 0) {
    throw new ActualUnavailableError("invalid_data");
  }
  return amount / unitsPerYen;
}

function validatedDate(value: string): string {
  if (!z.iso.date().safeParse(value).success) throw new Error("Invalid transaction date.");
  return value;
}

function cacheDirectory(mappingId: string, syncId: string): string {
  const key = createHash("sha256").update(mappingId).update("\0").update(syncId).digest("hex");
  return resolve(env.ACTUAL_CLI_DATA_DIR, key);
}

type Query = {
  table: "transactions";
  select: string[];
  filter?: Record<string, unknown>;
  orderBy: Array<{ date: "desc" }>;
  limit?: number;
};

function transactionsQuery(filter?: Record<string, unknown>, limit?: number): Query {
  return {
    table: "transactions",
    select: ["id", "date", "amount", "account", "payee.name", "category.name", "cleared", "transfer_id", "is_parent", "is_child"],
    ...(filter ? { filter } : {}),
    orderBy: [{ date: "desc" }],
    ...(limit === undefined ? {} : { limit }),
  };
}

/** The only subprocess boundary. The command receives no secret in argv. */
export async function runActualQuery(syncId: string, mappingId: string, query: Query, timeoutMs = CLI_TIMEOUT_MS): Promise<unknown> {
  if (!env.ACTUAL_SERVER_PASSWORD) throw new ActualUnavailableError("configuration");
  const dataDir = cacheDirectory(mappingId, syncId);
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
    ACTUAL_SYNC_ID: syncId,
    ACTUAL_DATA_DIR: dataDir,
    ACTUAL_CACHE_TTL: "60",
  };

  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI_SCRIPT, "--format", "json", "query", "run", "--file", "-"], {
      env: childEnv,
      cwd: dataDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (reason: ActualUnavailableError["reason"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new ActualUnavailableError(reason));
    };
    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) fail("invalid_data");
    });
    child.stderr.on("data", (chunk: string) => {
      // Diagnostic text remains internal and is never logged or returned.
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
      try {
        resolveResult(JSON.parse(stdout) as unknown);
      } catch {
        reject(new ActualUnavailableError("invalid_data"));
      }
    });
    child.stdin.end(JSON.stringify(query));
  });
}

type QueryRunner = typeof runActualQuery;

function toTransaction(row: TransactionRow, unitsPerYen: number): ActualTransaction {
  const amountYen = actualAmountToYen(row.amount, unitsPerYen);
  return {
    id: row.id,
    date: row.date,
    amountYen,
    kind: row.transfer_id ? "transfer" : amountYen < 0 ? "expense" : "income",
    accountId: row.account,
    payeeName: row["payee.name"] ?? null,
    categoryName: row["category.name"] ?? null,
    cleared: row.cleared ?? false,
  };
}

export function createActualGateway(options: { unitsPerYen: number; run?: QueryRunner }): ActualGateway {
  const run = options.run ?? runActualQuery;

  async function read(query: Query): Promise<TransactionRow[]> {
    const currentUser = await requireUser();
    const [mapping] = await db
      .select({ id: actualBudgetMapping.id, syncId: actualBudgetMapping.syncId })
      .from(actualBudgetMapping)
      .where(eq(actualBudgetMapping.userId, currentUser.id))
      .limit(1);
    if (!mapping) throw new ActualBudgetNotLinkedError();
    const parsed = rowsSchema.safeParse(await run(mapping.syncId, mapping.id, query));
    if (!parsed.success) throw new ActualUnavailableError("invalid_data");
    return parsed.data;
  }

  return {
    async getRecentTransactions({ limit = 20 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid transaction limit.");
      const rows = await read(transactionsQuery(undefined, limit));
      return rows.filter((row) => !row.is_parent).map((row) => toTransaction(row, options.unitsPerYen));
    },

    async getTransactions({ startDate, endDate }) {
      const start = validatedDate(startDate);
      const end = validatedDate(endDate);
      if (start > end) throw new Error("Start date must not follow end date.");
      const rows = await read(transactionsQuery({ date: { $gte: start, $lte: end } }));
      return rows.filter((row) => !row.is_parent).map((row) => toTransaction(row, options.unitsPerYen));
    },

    async getTransactionById(id) {
      const parsedId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).safeParse(id);
      if (!parsedId.success) return null;
      const rows = await read(transactionsQuery({ id: { $eq: parsedId.data } }, 1));
      const row = rows.find((candidate) => candidate.id === parsedId.data && !candidate.is_parent);
      return row ? toTransaction(row, options.unitsPerYen) : null;
    },

    async getMonthlySpending({ yearMonth }) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) throw new Error("Invalid yearMonth.");
      const next = new Date(`${yearMonth}-01T00:00:00.000Z`);
      next.setUTCMonth(next.getUTCMonth() + 1);
      const end = new Date(next.getTime() - 86_400_000).toISOString().slice(0, 10);
      const rows = await read(transactionsQuery({ date: { $gte: `${yearMonth}-01`, $lte: end } }));
      let spending = 0;
      for (const row of rows) {
        if (row.is_parent || row.transfer_id || row.amount >= 0) continue;
        spending += -actualAmountToYen(row.amount, options.unitsPerYen);
        if (!Number.isSafeInteger(spending)) throw new ActualUnavailableError("invalid_data");
      }
      return spending;
    },
  };
}

// The JPY factor is finalized after the synthetic JPY-budget CLI round trip.
export const actualGateway = createActualGateway({ unitsPerYen: 1 });
