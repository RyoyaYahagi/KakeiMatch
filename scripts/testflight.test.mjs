import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const script = readFileSync(new URL('../apps/ios/scripts/testflight.sh', import.meta.url), 'utf8');
// Run initialization, option parsing and validation, but never signing/build/upload.
const boundary = '\nrequire_env KM_DEVELOPMENT_TEAM';
assert.ok(script.includes(boundary), 'credential-check boundary must exist');
const setup = script.slice(0, script.indexOf(boundary));

function buildNumber({ instant = '2026-11-04T09:17:00Z', timezone = 'UTC', args = [] } = {}) {
  const epoch = Date.parse(instant) / 1000;
  // Freeze the instant using the real platform date command so TZ conversion is tested.
  const fixedDate = process.platform === 'darwin' ? `-r ${epoch}` : `-d @${epoch}`;
  return execFileSync('bash', ['-c', `
    date() { command date ${fixedDate} "$@"; }
    ${setup}
    printf '%s' "$build_number"
  `, 'testflight.sh', ...args], {
    encoding: 'utf8',
    env: { ...process.env, TZ: timezone },
  });
}

for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
  test(`default build number uses Japan time when host TZ=${timezone}`, () => {
    assert.equal(buildNumber({ timezone }), '202611041817');
  });
}

test('Japan time rolls over to the next year before UTC', () => {
  assert.equal(buildNumber({ instant: '2026-12-31T15:05:00Z' }), '202701010005');
});

test('explicit build number still overrides the generated default', () => {
  assert.equal(buildNumber({ args: ['--build-number', '123.4.5'] }), '123.4.5');
});

test('help describes the Japan time default', () => {
  const help = buildNumber({ args: ['--help'] });
  assert.match(help, /Default: Japan time \(Asia\/Tokyo\) as YYYYMMDDHHMM\./);
  assert.doesNotMatch(help, /UTC time/);
});
