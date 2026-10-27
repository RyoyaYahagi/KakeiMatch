import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: collect-parity-report.mjs <xcresult attachments directory> <output.json>');
let found;
for (const entry of await readdir(input, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  let report;
  try { report = JSON.parse(await readFile(join(entry.parentPath, entry.name), 'utf8')); } catch { continue; }
  if (report?.format !== 'kakeimatch-parity-report') continue;
  if (found) throw new Error('Multiple parity reports in xcresult.');
  found = report;
}
if (!found) throw new Error('No executed parity report in xcresult; refusing to invent results from the manifest.');
await writeFile(output, `${JSON.stringify(found, null, 2)}\n`);
