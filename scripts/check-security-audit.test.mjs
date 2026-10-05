import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAudits, parseAuditReport } from './check-security-audit.mjs';

const names = ['pnpm-prod', 'pnpm-all', 'worker-prod', 'worker-all'];
const emptyPnpm = { advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } };
const emptyNpm = { vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } };
const reports = () => Object.fromEntries(names.map(name => [name, name.startsWith('worker-') ? emptyNpm : emptyPnpm]));
const statuses = () => Object.fromEntries(names.map(name => [name, 0]));
const lock = { packages: { 'node_modules/vitest': { version: '3.2.4' }, 'node_modules/undici-v5': { version: '5.29.0' }, 'node_modules/undici-v7': { version: '7.29.0' } } };
const known = { audit: 'worker-prod', package: 'vitest', version: '3.2.4', advisoryId: 'GHSA-5xrq-8626-4rwp', severity: 'high',
  path: 'node_modules/vitest', expiresAt: '2026-11-02', reason: 'Reviewed optional peer in the test toolchain.' };
const baseline = findings => ({ reviewedAt: '2026-10-04', owner: 'repository maintainer', findings });
function npmVitest(severity) {
  return { vulnerabilities: { vitest: { severity, via: [{ name: 'vitest', severity, range: '<3.2.6', url: 'https://github.com/advisories/GHSA-5xrq-8626-4rwp' }], nodes: ['node_modules/vitest'] } },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: severity === 'high' ? 1 : 0, critical: severity === 'critical' ? 1 : 0, total: 1 } } };
}

test('fresh high finding not matching the exact reviewed package/version/advisory/path fails', () => {
  const input = reports();
  input['worker-prod'] = npmVitest('high');
  const result = evaluateAudits({ reports: input, statuses: { ...statuses(), 'worker-prod': 1 }, baseline: baseline([]), packageLock: lock, today: '2026-10-04' });
  assert.equal(result.passed, false);
  assert.equal(result.newHighCritical.length, 1);
  assert.match(result.newHighCritical[0].advisoryId, /GHSA-5xrq/);
});

test('an exact reviewed finding is summarized without blocking before its expiry', () => {
  const input = reports();
  input['worker-prod'] = npmVitest('high');
  const result = evaluateAudits({ reports: input, statuses: { ...statuses(), 'worker-prod': 1 }, baseline: baseline([known]), packageLock: lock, today: '2026-10-04' });
  assert.equal(result.passed, true);
  assert.equal(result.reviewed.length, 1);
});

test('incomplete severity counts cannot be interpreted as a clean audit', () => {
  const input = reports();
  input['worker-prod'] = { vulnerabilities: {}, metadata: { vulnerabilities: {} } };
  const result = evaluateAudits({ reports: input, statuses: statuses(), baseline: baseline([]), packageLock: lock, today: '2026-10-04' });
  assert.equal(result.passed, false);
  assert.equal(result.operationalErrors.length, 1);
});

test('known high advisories with zero reported severity counts remain an audit error', () => {
  const input = reports();
  input['worker-prod'] = { ...npmVitest('high'), metadata: emptyNpm.metadata };
  const result = evaluateAudits({ reports: input, statuses: statuses(), baseline: baseline([known]), packageLock: lock, today: '2026-10-04' });
  assert.equal(result.passed, false);
  assert.equal(result.operationalErrors.length, 1);
});

test('a still-present reviewed finding blocks on and after its expiry date', () => {
  const input = reports();
  input['worker-prod'] = npmVitest('high');
  const result = evaluateAudits({ reports: input, statuses: { ...statuses(), 'worker-prod': 1 }, baseline: baseline([known]), packageLock: lock, today: '2026-11-02' });
  assert.equal(result.passed, false);
  assert.equal(result.expired.length, 1);
});

test('malformed/network-error JSON with exit 1 is an operational failure, not a finding', () => {
  const input = reports();
  input['worker-prod'] = { error: { code: 'ENOTFOUND', summary: 'registry unavailable' } };
  const result = evaluateAudits({ reports: input, statuses: { ...statuses(), 'worker-prod': 1 }, baseline: baseline([]), packageLock: lock, today: '2026-10-04' });
  assert.equal(result.passed, false);
  assert.match(result.operationalErrors.join('\n'), /service returned an error/);
  assert.equal(result.newHighCritical.length, 0);
});

test('severity increase from a reviewed high to critical is treated as a changed finding', () => {
  const input = reports();
  input['worker-prod'] = npmVitest('critical');
  const result = evaluateAudits({ reports: input, statuses: { ...statuses(), 'worker-prod': 1 }, baseline: baseline([known]), packageLock: lock, today: '2026-10-04' });
  assert.equal(result.passed, false);
  assert.equal(result.newHighCritical[0]?.severity, 'critical');
});

test('npm grouped package paths are filtered by each advisory vulnerable range', () => {
  const result = evaluateAudits({ reports: { ...reports(), 'worker-all': {
    vulnerabilities: { undici: { severity: 'high',
      via: [{ name: 'undici', severity: 'high', range: '<6.24.0', url: 'https://github.com/advisories/GHSA-example' }],
      nodes: ['node_modules/undici-v5', 'node_modules/undici-v7'] } },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
  } }, statuses: { ...statuses(), 'worker-all': 1 }, baseline: baseline([]), packageLock: lock, today: '2026-10-04' });
  assert.equal(result.newHighCritical.length, 1);
  assert.equal(result.newHighCritical[0]?.version, '5.29.0');
  assert.equal(result.newHighCritical[0]?.path, 'node_modules/undici-v5');
});

test('audit command exit 1 is accepted only when the JSON report contains advisories', () => {
  const result = evaluateAudits({ reports: reports(), statuses: { ...statuses(), 'pnpm-all': 1 }, baseline: baseline([]), packageLock: lock, today: '2026-10-04' });
  assert.equal(result.passed, false);
  assert.match(result.operationalErrors.join('\n'), /does not match/);
});

test('invalid calendar dates in reviewed exceptions fail closed', () => {
  const input = reports();
  input['worker-prod'] = npmVitest('high');
  const result = evaluateAudits({ reports: input, statuses: { ...statuses(), 'worker-prod': 1 }, baseline: baseline([{ ...known, expiresAt: '2026-02-30' }]), packageLock: lock, today: '2026-02-01' });
  assert.equal(result.passed, false);
  assert.match(result.operationalErrors.join('\n'), /malformed exception/);
});

function npmRangeReport(range) {
  return { vulnerabilities: { undici: { severity: 'high', via: [{ name: 'undici', severity: 'high', range, url: 'https://github.com/advisories/GHSA-example' }], nodes: ['node_modules/undici-v7'] } },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } } };
}

test('unsupported npm range syntax fails even when a supported term or OR branch matches', () => {
  for (const range of ['<1.0.0 unsupported', '>=1.0.0 || unsupported', '^1.0.0', '~1.0.0', '*']) {
    assert.throws(() => parseAuditReport('worker-all', npmRangeReport(range), lock), /unsupported (npm advisory range|semantic version)/, range);
  }
});

test('npm range comparison follows prerelease ordering and excludes prereleases from stable-only ranges', () => {
  const prereleaseLock = { packages: {
    'node_modules/undici-v7': { version: '7.0.0-beta.2' },
    'node_modules/undici-v5': { version: '7.0.0-beta.1' },
  } };
  const stableRange = npmRangeReport('<7.0.0');
  stableRange.metadata.vulnerabilities.high = 0;
  const belowStable = parseAuditReport('worker-all', stableRange, prereleaseLock);
  assert.equal(belowStable.findings.length, 0);
  const boundedReport = npmRangeReport('<7.0.0-beta.3');
  boundedReport.vulnerabilities.undici.nodes = ['node_modules/undici-v7', 'node_modules/undici-v5'];
  const prereleaseBound = parseAuditReport('worker-all', boundedReport, prereleaseLock);
  assert.deepEqual(prereleaseBound.findings.map(finding => finding.version), ['7.0.0-beta.2', '7.0.0-beta.1']);
});
