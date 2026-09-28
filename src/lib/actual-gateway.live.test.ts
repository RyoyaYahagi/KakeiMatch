import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const required = ["ACTUAL_TEST_SYNC_ID_A", "ACTUAL_TEST_SYNC_ID_B", "ACTUAL_SERVER_URL", "ACTUAL_SERVER_PASSWORD"] as const;
const enabled = required.every((name) => Boolean(process.env[name]));
const session = vi.hoisted(() => ({ userId: "user-a" }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/current-user", () => ({ requireUser: async () => ({ id: session.userId }) }));

const directory = enabled ? mkdtempSync(join(tmpdir(), "kakeimatch-actual-live-")) : "";
let sqlite: Database.Database;
let gateway: typeof import("./actual-gateway").actualGateway;

describe.skipIf(!enabled)("Actual Gateway with two synthetic JPY budgets", () => {
  beforeAll(async () => {
    const testEnvironment = process.env as Record<string, string | undefined>;
    testEnvironment.NODE_ENV = "test";
    process.env.APP_URL = "http://localhost:3000";
    process.env.AUTH_SECRET = "test-only-auth-secret-at-least-32-characters-long";
    process.env.DATABASE_PATH = join(directory, "mapping.sqlite");
    process.env.ACTUAL_CLI_DATA_DIR = join(directory, "cli-cache");
    gateway = (await import("./actual-gateway")).actualGateway;
    sqlite = new Database(process.env.DATABASE_PATH);
    const now = Date.now();
    const insertUser = sqlite.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)");
    insertUser.run("user-a", "Synthetic A", "actual-a@example.test", now, now);
    insertUser.run("user-b", "Synthetic B", "actual-b@example.test", now, now);
    const insertMapping = sqlite.prepare("INSERT INTO actual_budget_mapping (id, user_id, sync_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    insertMapping.run("mapping-a", "user-a", process.env.ACTUAL_TEST_SYNC_ID_A, now, now);
    insertMapping.run("mapping-b", "user-b", process.env.ACTUAL_TEST_SYNC_ID_B, now, now);
  });

  afterAll(() => {
    sqlite?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("keeps the authenticated users' transactions in their own budgets and converts JPY", async () => {
    session.userId = "user-a";
    const a = await gateway.getTransactions({ startDate: "2026-09-01", endDate: "2026-09-30" });
    session.userId = "user-b";
    const b = await gateway.getTransactions({ startDate: "2026-09-01", endDate: "2026-09-30" });
    expect(a.some((row) => row.payeeName === "Synthetic A" && row.amountYen === -3284)).toBe(true);
    expect(a.some((row) => row.payeeName === "Synthetic B")).toBe(false);
    expect(b.some((row) => row.payeeName === "Synthetic B" && row.amountYen === -710)).toBe(true);
    expect(b.some((row) => row.payeeName === "Synthetic A")).toBe(false);
    session.userId = "user-a";
    expect(await gateway.getMonthlySpending({ yearMonth: "2026-09" })).toBe(3784);
    session.userId = "unmapped";
    await expect(gateway.getRecentTransactions()).rejects.toMatchObject({ name: "ActualBudgetNotLinkedError" });
  }, 90_000);
});
