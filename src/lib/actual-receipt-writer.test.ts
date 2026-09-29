import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const userMappings: Record<string, { id: string; syncId: string } | undefined> = {
    "session-user": { id: "mapping-user", syncId: "mapped-sync" },
  };
  const where = vi.fn((condition: [string, string]) => ({
    limit: vi.fn(async () => userMappings[condition[1]] ? [userMappings[condition[1]]] : []),
  }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const spawn = vi.fn();
  return { userMappings, select, spawn };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/db/schema", () => ({ actualBudgetMapping: { id: "id", syncId: "syncId", userId: "userId" } }));
vi.mock("@/lib/env", () => ({ env: {
  ACTUAL_SERVER_URL: "http://actual.test",
  ACTUAL_SERVER_PASSWORD: "test-password",
  ACTUAL_CLI_DATA_DIR: "/tmp/actual-writer-test",
} }));
vi.mock("drizzle-orm", () => ({ eq: (column: string, value: string) => [column, value] }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@/lib/actual-gateway", () => ({
  actualAmountToYen: (amount: number, factor: number) => amount / factor,
  yenToActualAmount: (amountYen: number, factor: number) => amountYen * factor,
  ActualBudgetNotLinkedError: class ActualBudgetNotLinkedError extends Error {
    constructor() { super("Actual Budget is not linked to this account."); }
  },
  ActualUnavailableError: class ActualUnavailableError extends Error {
    constructor(readonly reason: string) { super("Actual Budget is unavailable."); }
  },
}));

import { createActualReceiptWriter, type ActualReceiptWriter } from "@/lib/actual-receipt-writer";

type Runner = (userId: string, args: string[], stdin?: unknown) => Promise<unknown>;

function writer(run: Runner): ActualReceiptWriter {
  return createActualReceiptWriter({ userId: "session-user", run });
}

function makeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  child.kill = vi.fn();
  return child;
}

describe("Actual receipt writer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userMappings["session-user"] = { id: "mapping-user", syncId: "mapped-sync" };
  });

  it("lists only open accounts and visible expense categories", async () => {
    const run = vi.fn<Runner>(async (_userId, args) => args[0] === "accounts"
      ? [
          { id: "cash", name: "Cash", closed: false },
          { id: "closed", name: "Closed", closed: true },
        ]
      : [
          { id: "food", name: "Food", is_income: false, hidden: false },
          { id: "income", name: "Income", is_income: true, hidden: false },
          { id: "hidden", name: "Hidden", is_income: false, hidden: true },
        ]);
    const actual = writer(run);

    await expect(actual.listOpenAccounts()).resolves.toEqual([{ id: "cash", name: "Cash" }]);
    await expect(actual.listExpenseCategories()).resolves.toEqual([{ id: "food", name: "Food" }]);
    expect(run.mock.calls.map(([, args]) => args)).toEqual([["accounts", "list"], ["categories", "list"]]);
  });

  it("rejects account and category rows with missing classification flags", async () => {
    const actualAccounts = writer(vi.fn<Runner>(async () => [{ id: "cash", name: "Cash" }]));
    const actualCategories = writer(vi.fn<Runner>(async () => [{ id: "food", name: "Food", hidden: false }]));

    await expect(actualAccounts.listOpenAccounts()).rejects.toMatchObject({ reason: "invalid_data" });
    await expect(actualCategories.listExpenseCategories()).rejects.toMatchObject({ reason: "invalid_data" });
  });

  it("searches imported_id within the session user's mapped Budget and validates the returned row", async () => {
    const row = {
      id: "transaction-1", account: "cash", date: "2026-09-28", amount: -3284,
      "payee.name": "Synthetic Market", category: "food", cleared: false,
      imported_id: "kakeimatch:receipt:receipt-1",
    };
    const run = vi.fn<Runner>(async () => [row]);
    const actual = writer(run);

    await expect(actual.findByImportedId(row.imported_id)).resolves.toEqual({
      id: "transaction-1", accountId: "cash", date: "2026-09-28", amountYen: -3284,
      payeeName: "Synthetic Market", categoryId: "food", cleared: false, importedId: row.imported_id,
    });
    expect(run.mock.calls[0]?.[0]).toBe("session-user");
    expect(run.mock.calls[0]?.[1]).toEqual(["query", "run", "--file", "-"]);
    expect(run.mock.calls[0]?.[2]).toMatchObject({
      table: "transactions",
      filter: { imported_id: { $eq: row.imported_id } },
    });
  });

  it("rejects a read-back row without an explicit cleared state", async () => {
    const actual = writer(vi.fn<Runner>(async () => [{
      id: "transaction-1", account: "cash", date: "2026-09-28", amount: -3284,
      "payee.name": "Synthetic Market", category: "food", imported_id: "receipt-key",
    }]));
    await expect(actual.findByImportedId("receipt-key")).rejects.toMatchObject({ reason: "invalid_data" });
  });

  it("imports a negative integer yen amount through stdin without putting receipt values in argv", async () => {
    const run = vi.fn<Runner>(async () => ({ added: ["transaction-1"], updated: [], errors: [] }));
    const actual = writer(run);
    const input = {
      accountId: "cash", date: "2026-09-28", amountYen: -3284,
      merchant: "Synthetic Market", categoryId: "food", importedId: "kakeimatch:receipt:receipt-1",
    };

    await actual.importReceipt(input);

    expect(run.mock.calls[0]?.[1]).toEqual(["transactions", "import", "--account", "cash", "--file", "-"]);
    expect(run.mock.calls[0]?.[2]).toEqual([{
      date: "2026-09-28", amount: -3284, payee_name: "Synthetic Market", category: "food",
      imported_id: "kakeimatch:receipt:receipt-1", cleared: false,
    }]);
    const args = run.mock.calls[0]?.[1] ?? [];
    for (const privateValue of [input.date, String(input.amountYen), input.merchant, input.importedId]) {
      expect(args.join(" ")).not.toContain(privateValue);
    }
  });

  it("updates category and cleared fields through stdin", async () => {
    const run = vi.fn<Runner>(async () => ({ success: true }));
    const actual = writer(run);

    await actual.updateReceipt("transaction-1", { categoryId: "food", cleared: false });

    expect(run.mock.calls[0]?.[1]).toEqual(["transactions", "update", "transaction-1", "--file", "-"]);
    expect(run.mock.calls[0]?.[2]).toEqual({ category: "food", cleared: false });
  });

  it("rejects invalid transaction input before invoking the CLI", async () => {
    const run = vi.fn<Runner>(async () => []);
    const actual = writer(run);

    await expect(actual.importReceipt({
      accountId: "cash", date: "2026-02-30", amountYen: 0,
      merchant: "  ", categoryId: "food", importedId: "receipt-1",
    })).rejects.toThrow("Invalid Actual receipt transaction.");
    await expect(actual.updateReceipt("transaction-1", {})).rejects.toThrow("Invalid Actual receipt update.");
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the server-side user mapping and keeps credentials and receipt values out of CLI argv", async () => {
    const child = makeChildProcess();
    mocks.spawn.mockImplementation(() => {
      child.stdin.end.mockImplementation((value: string) => {
        expect(JSON.parse(value)).toEqual([expect.objectContaining({ payee_name: "Synthetic Market", amount: -3284 })]);
        queueMicrotask(() => {
          child.stdout.emit("data", JSON.stringify({ added: ["transaction-1"], updated: [], errors: [] }));
          child.emit("close", 0, null);
        });
      });
      return child;
    });
    const actual = createActualReceiptWriter({ userId: "session-user" });

    await actual.importReceipt({
      accountId: "cash", date: "2026-09-28", amountYen: -3284,
      merchant: "Synthetic Market", categoryId: "food", importedId: "receipt-key",
    });

    const [command, args, options] = mocks.spawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(expect.arrayContaining(["--account", "cash", "--file", "-"]));
    expect(args.join(" ")).not.toContain("Synthetic Market");
    expect(args.join(" ")).not.toContain("2026-09-28");
    expect(args.join(" ")).not.toContain("3284");
    expect(args.join(" ")).not.toContain("test-password");
    expect(args.join(" ")).not.toContain("mapped-sync");
    expect(options.env.ACTUAL_PASSWORD).toBe("test-password");
    expect(options.env.ACTUAL_SYNC_ID).toBe("mapped-sync");
  });
});
