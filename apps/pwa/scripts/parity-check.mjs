import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Independently regenerate through real UI operations, without overwriting goldens.
const temporary = await mkdtemp(join(tmpdir(), 'kakeimatch-parity-'));
const fixtureRoot = fileURLToPath(new URL('../../../test/fixtures/ios-parity/', import.meta.url));
try {
  const scenarios = JSON.parse(await readFile(join(fixtureRoot, 'scenarios.json'), 'utf8'));
  for (const run of ['first', 'second']) {
    execFileSync(process.execPath, [fileURLToPath(new URL('parity-scenarios.mjs', import.meta.url))], {
      env: { ...process.env, PARITY_OUTPUT: join(temporary, run), PARITY_SCENARIO: '' }, stdio: 'inherit',
    });
  }
  let count = 0;
  for (const { id } of scenarios) {
    for (const name of (await readdir(join(fixtureRoot, id))).filter(f => f.endsWith('.json'))) {
      const golden = await readFile(join(fixtureRoot, id, name), 'utf8');
      const first = await readFile(join(temporary, 'first', id, name), 'utf8');
      const second = await readFile(join(temporary, 'second', id, name), 'utf8');
      assert.equal(first, second, `${id}/${name}: not deterministic`);
      assert.equal(first, golden, `${id}/${name}: changed PWA result; inspect before updating golden`);
      count++;
    }
  }
  console.log(`PASS: ${count} JSON files match the committed PWA results across two independent generations.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
