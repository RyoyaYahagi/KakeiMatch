import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Legacy regression tests must never open the default or an operator's database.
// Tests with their own fixture may override these paths before importing adapters.
const directory = mkdtempSync(join(tmpdir(), "kakeimatch-test-fixtures-"));
process.env.DATABASE_PATH = join(directory, "synthetic.sqlite");
process.env.RECEIPT_STORAGE_DIR = join(directory, "receipts");
process.env.STATEMENT_STORAGE_DIR = join(directory, "statements");
process.env.ACTUAL_CLI_DATA_DIR = join(directory, "actual-cli");

afterAll(() => rmSync(directory, { recursive: true, force: true }));
