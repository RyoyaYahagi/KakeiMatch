import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "src/lib/reconciliation-engine.ts");
const docPath = path.join(root, "docs/LOCAL_RECONCILIATION.md");
const startMarker = "<!-- reconciliation-rules:start -->";
const endMarker = "<!-- reconciliation-rules:end -->";

function extractRules(source) {
  const start = source.indexOf("export const RECONCILIATION_RULES = {");
  if (start < 0) throw new Error("RECONCILIATION_RULES declaration was not found");
  const bodyStart = source.indexOf("{", start) + 1;
  const bodyEnd = source.indexOf("} as const;", bodyStart);
  if (bodyEnd < 0) throw new Error("RECONCILIATION_RULES block end was not found");
  const body = source.slice(bodyStart, bodyEnd);
  const entries = [...body.matchAll(/^\s*([A-Za-z_$][\w$]*):\s*(-?(?:\d+(?:\.\d+)?|"[^"]*"|'[^']*'|true|false|null)),?\s*(?:\/\/.*)?$/gm)];
  const properties = body.split("\n").filter((line) => line.trim() && !line.trim().startsWith("//"));
  if (entries.length !== properties.length) {
    throw new Error("RECONCILIATION_RULES contains an unsupported property format");
  }
  if (entries.length === 0) throw new Error("RECONCILIATION_RULES is empty");
  return entries.map(([, key, value]) => `| \`${key}\` | \`${value}\` |`).join("\n");
}

const source = await readFile(sourcePath, "utf8");
const doc = await readFile(docPath, "utf8");
const start = doc.indexOf(startMarker);
const end = doc.indexOf(endMarker);
if (start < 0 || end < 0 || end < start) throw new Error("Generated-section markers are missing or out of order");

const generated = `\n| 定数 | 値 |\n| --- | --- |\n${extractRules(source)}\n`;
const updated = `${doc.slice(0, start + startMarker.length)}${generated}${doc.slice(end)}`;
if (process.argv.includes("--check")) {
  if (updated !== doc) {
    console.error("LOCAL_RECONCILIATION.md generated rules are out of date; run pnpm docs:reconciliation:generate");
    process.exitCode = 1;
  }
} else {
  await writeFile(docPath, updated);
}
