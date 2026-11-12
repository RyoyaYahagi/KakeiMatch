import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const generatorPath = path.join(repositoryRoot, "scripts/generate-reconciliation-rules.mjs");

describe("reconciliation rules documentation", () => {
  it("matches every current RECONCILIATION_RULES constant", () => {
    expect(() => execFileSync(process.execPath, [generatorPath, "--check"], { cwd: repositoryRoot })).not.toThrow();
  });
});
