import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('collect-parity-report.mjs', import.meta.url));
test('collects only an executed report, including failure details', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'parity-collector-'));
  try {
    const input = join(dir, 'attachments'), output = join(dir, 'report.json');
    await mkdir(join(input, 'nested'), { recursive: true });
    const run = () => execFileSync(process.execPath, [script, input, output], { stdio: 'pipe' });
    await writeFile(join(input, 'manifest.json'), JSON.stringify([{ id: 'baseline', status: 'baseline-test-configured' }]));
    assert.throws(run, /No executed parity report/);
    const report = { format: 'kakeimatch-parity-report', version: 1, scenarios: [{ id: 'baseline', import: { match: false, differences: ['$.monthly.expenseYen: differs'] } }] };
    await writeFile(join(input, 'nested', 'opaque-attachment.json'), JSON.stringify(report));
    run();
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), report);
    await writeFile(join(input, 'duplicate.json'), JSON.stringify(report));
    assert.throws(run, /Multiple parity reports/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
