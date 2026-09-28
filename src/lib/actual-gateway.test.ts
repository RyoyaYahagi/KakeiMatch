import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mappingByUser: Record<string, string | undefined> = {
    "session-a": "sync-a",
    "session-b": "sync-b",
  };
  const requireUser = vi.fn(async () => ({ id: "session-a" }));
  const where = vi.fn((condition: [string, string]) => ({
    limit: vi.fn(async () => {
      const syncId = mappingByUser[condition[1]];
      return syncId ? [{ id: `mapping-${condition[1]}`, syncId }] : [];
    }),
  }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const spawn = vi.fn();
  return { mappingByUser, requireUser, select, spawn };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/current-user", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/db/schema", () => ({ actualBudgetMapping: { userId: "userId", syncId: "syncId" } }));
vi.mock("@/lib/env", () => ({
  env: {
    ACTUAL_SERVER_URL: "http://actual.test",
    ACTUAL_SERVER_PASSWORD: "secret-test-password",
    ACTUAL_CLI_DATA_DIR: "/tmp/actual-cli-test",
  },
}));
vi.mock("drizzle-orm", () => ({ eq: (column: string, value: string) => [column, value] }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import {
  actualAmountToYen,
  createActualGateway,
  runActualQuery,
  type ActualGateway,
} from "@/lib/actual-gateway";

const normalExpense = {
  id: "ordinary", date: "2026-04-02", amount: -1200, account: "cash",
  "payee.name": "Market", "category.name": "Food", cleared: true,
  transfer_id: null, is_parent: false, is_child: false,
};

const transfer = { ...normalExpense, id: "transfer", transfer_id: "paired-transfer" };
const income = { ...normalExpense, id: "income", amount: 5000 };

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

function configureSpawn(child: ReturnType<typeof makeChildProcess>) {
  let resolveSpawn!: () => void;
  const spawned = new Promise<void>((resolve) => {
    resolveSpawn = resolve;
  });
  mocks.spawn.mockImplementation(() => {
    resolveSpawn();
    return child;
  });
  return spawned;
}

function setupSuccessfulCli(rows: unknown[] = [normalExpense]) {
  const child = makeChildProcess();
  const spawned = new Promise<void>((resolveSpawn) => {
    mocks.spawn.mockImplementation(() => {
      resolveSpawn();
      child.stdin.end.mockImplementation((input: string) => {
        expect(JSON.parse(input)).toMatchObject({ table: "transactions" });
        queueMicrotask(() => {
          child.stdout.emit("data", JSON.stringify(rows));
          child.emit("close", 0, null);
        });
      });
      return child;
    });
  });
  return { child, spawned };
}

type QueryRunner = typeof runActualQuery;

function gateway(run?: QueryRunner): ActualGateway {
  return createActualGateway({ unitsPerYen: 100, run });
}

describe("Actual read-only gateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockImplementation(async () => ({ id: "session-a" }));
    mocks.mappingByUser["session-a"] = "sync-a";
    mocks.mappingByUser["session-b"] = "sync-b";
  });

  it("converts Actual integer amounts only with an explicit whole-yen factor", () => {
    expect(actualAmountToYen(-1200, 100)).toBe(-12);
    expect(() => actualAmountToYen(-1201, 100)).toThrow(expect.objectContaining({ reason: "invalid_data" }));
    expect(() => actualAmountToYen(1, 0)).toThrow(expect.objectContaining({ reason: "invalid_data" }));
  });

  it("isolates Actual Sync IDs by session and ignores a client-supplied Sync ID", async () => {
    const run = vi.fn<QueryRunner>(async () => [normalExpense]);
    const actual = gateway(run);

    await actual.getTransactions({ startDate: "2026-04-01", endDate: "2026-04-30", syncId: "attacker-sync" } as never);
    expect(run.mock.calls[0]?.[0]).toBe("sync-a");

    mocks.requireUser.mockImplementation(async () => ({ id: "session-b" }));
    await actual.getTransactions({ startDate: "2026-04-01", endDate: "2026-04-30" });
    expect(run.mock.calls[1]?.[0]).toBe("sync-b");

    mocks.requireUser.mockImplementation(async () => ({ id: "unmapped-user" }));
    await expect(actual.getTransactions({ startDate: "2026-04-01", endDate: "2026-04-30" })).rejects.toThrow("not linked");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed transaction rows", async () => {
    const actual = gateway(vi.fn<QueryRunner>(async () => [{ id: "bad" }]));
    await expect(actual.getTransactions({ startDate: "2026-04-01", endDate: "2026-04-02" })).rejects.toMatchObject({ reason: "invalid_data" });
  });

  it("classifies expense, income, and transfer rows and preserves missing names as null", async () => {
    const run = vi.fn<QueryRunner>(async () => [
      normalExpense,
      income,
      transfer,
      { ...normalExpense, id: "unnamed", "payee.name": null, "category.name": null },
    ]);
    const actual = gateway(run);

    const rows = await actual.getTransactions({ startDate: "2026-04-01", endDate: "2026-04-30" });
    expect(rows.map(({ id, kind }) => [id, kind])).toEqual([
      ["ordinary", "expense"],
      ["income", "income"],
      ["transfer", "transfer"],
      ["unnamed", "expense"],
    ]);
    expect(rows[3]).toMatchObject({ payeeName: null, categoryName: null });
    expect(rows[2]).not.toHaveProperty("transfer_id");
  });

  it("looks up one transaction inside the authenticated budget and returns null for invalid or missing IDs", async () => {
    const run = vi.fn<QueryRunner>(async (syncId) => syncId === "sync-a" ? [normalExpense] : [income]);
    const actual = gateway(run);

    await expect(actual.getTransactionById("ordinary")).resolves.toMatchObject({ id: "ordinary", kind: "expense" });
    expect(run.mock.calls[0]?.[0]).toBe("sync-a");
    expect(run.mock.calls[0]?.[2]).toMatchObject({
      filter: { id: { $eq: "ordinary" } },
      limit: 1,
    });

    mocks.requireUser.mockImplementation(async () => ({ id: "session-b" }));
    await expect(actual.getTransactionById("ordinary")).resolves.toBeNull();
    expect(run.mock.calls[1]?.[0]).toBe("sync-b");

    const callsBeforeInvalid = run.mock.calls.length;
    await expect(actual.getTransactionById("\u0000bad")).resolves.toBeNull();
    await expect(actual.getTransactionById("%00bad")).resolves.toBeNull();
    expect(run).toHaveBeenCalledTimes(callsBeforeInvalid);
    await expect(actual.getTransactionById("missing")).resolves.toBeNull();
    expect(run.mock.calls[2]?.[2]).toMatchObject({ filter: { id: { $eq: "missing" } }, limit: 1 });

    const parentRun = vi.fn<QueryRunner>(async () => [{ ...normalExpense, id: "split-parent", is_parent: true }]);
    await expect(gateway(parentRun).getTransactionById("split-parent")).resolves.toBeNull();
  });

  it("passes one bounded query and aggregates split children as positive spending, excluding income, parents, and transfers", async () => {
    const run = vi.fn<QueryRunner>(async () => [
      normalExpense,
      { ...normalExpense, id: "split-parent", amount: -500, is_parent: true },
      { ...normalExpense, id: "split-food", amount: -200, "category.name": "Food", is_child: true },
      { ...normalExpense, id: "split-home", amount: -300, "category.name": "Home", is_child: true },
      { ...normalExpense, id: "income", amount: 5000, "category.name": "Income" },
      { ...transfer, amount: -700 },
    ]);
    const actual = gateway(run);

    await expect(actual.getMonthlySpending({ yearMonth: "2026-04" })).resolves.toBe(17);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toBe("sync-a");
    expect(run.mock.calls[0]?.[2]).toMatchObject({
      table: "transactions",
      filter: { date: { $gte: "2026-04-01", $lte: "2026-04-30" } },
    });
  });

  it("reports nonzero CLI exit without exposing stderr", async () => {
    const child = makeChildProcess();
    const spawned = configureSpawn(child);
    const result = runActualQuery("sync-a", "mapping-a", { table: "transactions", select: [], orderBy: [] }, 100);
    const assertion = expect(result).rejects.toMatchObject({ reason: "process" });
    await spawned;
    child.emit("close", 1, null);
    await assertion;
  });

  it("rejects malformed JSON written by the CLI", async () => {
    const child = makeChildProcess();
    const spawned = configureSpawn(child);
    const result = runActualQuery("sync-a", "mapping-a", { table: "transactions", select: [], orderBy: [] }, 100);
    const assertion = expect(result).rejects.toMatchObject({ reason: "invalid_data" });
    await spawned;
    child.stdout.emit("data", "not-json");
    child.emit("close", 0, null);
    await assertion;
  });

  it("kills and rejects a timed out CLI process", async () => {
    vi.useFakeTimers();
    const child = makeChildProcess();
    const spawned = configureSpawn(child);
    try {
      const result = runActualQuery("sync-a", "mapping-a", { table: "transactions", select: [], orderBy: [] }, 25);
      const assertion = expect(result).rejects.toMatchObject({ reason: "timeout" });
      await spawned;
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps CLI credentials out of argv and supplies the mapped budget through the child environment", async () => {
    const { child } = setupSuccessfulCli();
    await runActualQuery("mapped-sync-id", "mapping-id", { table: "transactions", select: [], orderBy: [] }, 100);
    const [command, args, options] = mocks.spawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(expect.arrayContaining(["--format", "json"]));
    expect(args.join(" ")).not.toContain("secret-test-password");
    expect(args.join(" ")).not.toContain("mapped-sync-id");
    expect(options.env.ACTUAL_PASSWORD).toBe("secret-test-password");
    expect(options.env.ACTUAL_SYNC_ID).toBe("mapped-sync-id");
    expect(child.stdin.end).toHaveBeenCalledOnce();
  });
});
