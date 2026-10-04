import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const AUDITS = ['pnpm-prod', 'pnpm-all', 'worker-prod', 'worker-all'];
const HIGH = new Set(['high', 'critical']);

function fail(message) { throw new Error(message); }
function countVulnerabilities(counts) {
  if (!counts || typeof counts !== 'object') fail('audit JSON is missing vulnerability counts');
  const result = {};
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    const value = counts[severity] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) fail(`invalid ${severity} count`);
    result[severity] = value;
  }
  return result;
}
function advisoryId(value) {
  return value?.github_advisory_id ?? value?.url?.match(/GHSA-[A-Za-z0-9-]+/)?.[0] ?? null;
}
function versionForPackageNode(lock, node) {
  const value = lock.packages?.[node]?.version;
  if (typeof value !== 'string' || !value) fail(`package-lock has no version for ${node}`);
  return value;
}
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) fail(`unsupported semantic version: ${value}`);
  const core = match.slice(1, 4).map(Number);
  if (core.some((part, index) => !Number.isSafeInteger(part) || (match[index + 1].length > 1 && match[index + 1][0] === '0'))) {
    fail(`unsupported semantic version: ${value}`);
  }
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(part => !part || (/^\d+$/.test(part) && part.length > 1 && part[0] === '0'))) fail(`unsupported semantic version: ${value}`);
  return { core, pre };
}
function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    if (a.pre[index] === undefined || b.pre[index] === undefined) return a.pre[index] === undefined ? -1 : 1;
    const leftPart = a.pre[index], rightPart = b.pre[index];
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart), rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
function satisfiesRange(version, input) {
  if (typeof input !== 'string' || !input.trim()) fail('npm advisory has no supported vulnerable range');
  // Parse and validate every branch before evaluating any of them. A supported
  // branch must not hide a new/unsupported range syntax by short-circuiting.
  const alternatives = input.split(/\s*\|\|\s*/).map(alternative => {
    const hyphen = /^([^ ]+)\s+-\s+([^ ]+)$/.exec(alternative.trim());
    if (hyphen) {
      parseVersion(hyphen[1]); parseVersion(hyphen[2]);
      return { lower: hyphen[1], upper: hyphen[2], terms: null };
    }
    const tokens = alternative.trim().split(/\s+/);
    if (!tokens.length || tokens.some(token => !token)) fail(`unsupported npm advisory range: ${input}`);
    const terms = tokens.map(token => {
      const match = /^(<=|>=|<|>|=)?(.+)$/.exec(token);
      if (!match) fail(`unsupported npm advisory range: ${input}`);
      parseVersion(match[2]);
      return { operator: match[1] ?? '=', target: match[2] };
    });
    return { lower: null, upper: null, terms };
  });
  const versionParts = parseVersion(version);
  return alternatives.map(alternative => {
    const terms = alternative.terms ?? [
      { operator: '>=', target: alternative.lower }, { operator: '<=', target: alternative.upper },
    ];
    if (versionParts.pre.length && !terms.some(term => {
      const target = parseVersion(term.target);
      return target.pre.length > 0 && target.core.every((part, index) => part === versionParts.core[index]);
    })) return false;
    return terms.map(term => {
      const order = compareVersions(version, term.target);
      return term.operator === '<' ? order < 0 : term.operator === '<=' ? order <= 0 : term.operator === '>' ? order > 0 : term.operator === '>=' ? order >= 0 : order === 0;
    }).every(Boolean);
  }).some(Boolean);
}

export function parseAuditReport(name, report, packageLock) {
  if (!report || typeof report !== 'object' || report.error) fail(`${name}: audit service returned an error`);
  const findings = [];
  let counts;
  if (report.advisories && typeof report.advisories === 'object') {
    counts = countVulnerabilities(report.metadata?.vulnerabilities);
    for (const advisory of Object.values(report.advisories)) {
      if (!HIGH.has(advisory.severity)) continue;
      const id = advisoryId(advisory);
      if (!id || typeof advisory.module_name !== 'string' || !Array.isArray(advisory.findings)) fail(`${name}: malformed high-severity pnpm advisory`);
      for (const item of advisory.findings) {
        if (typeof item.version !== 'string' || !Array.isArray(item.paths) || item.paths.length === 0) fail(`${name}: malformed finding ${id}`);
        for (const path of item.paths) {
          if (typeof path !== 'string' || !path) fail(`${name}: malformed dependency path for ${id}`);
          findings.push({ audit: name, package: advisory.module_name, version: item.version, advisoryId: id, severity: advisory.severity, path });
        }
      }
    }
  } else if (report.vulnerabilities && typeof report.vulnerabilities === 'object') {
    counts = countVulnerabilities(report.metadata?.vulnerabilities);
    if (!packageLock || typeof packageLock !== 'object') fail(`${name}: package-lock is required to identify reported versions`);
    for (const [packageName, vulnerability] of Object.entries(report.vulnerabilities)) {
      if (!Array.isArray(vulnerability.via) || !Array.isArray(vulnerability.nodes)) fail(`${name}: malformed npm vulnerability for ${packageName}`);
      const highAdvisories = vulnerability.via.filter(item => item && typeof item === 'object' && HIGH.has(item.severity));
      if (HIGH.has(vulnerability.severity) && highAdvisories.length === 0) fail(`${name}: ${packageName} is high/critical but has no identified high-severity advisory`);
      for (const item of highAdvisories) {
        const id = advisoryId(item);
        if (!id) fail(`${name}: high-severity ${packageName} advisory has no identifier`);
        if (typeof item.range !== 'string') fail(`${name}: ${id} has no vulnerable version range`);
        if (vulnerability.nodes.length === 0) fail(`${name}: high-severity ${packageName} advisory has no dependency path`);
        for (const path of vulnerability.nodes) {
          const version = versionForPackageNode(packageLock, path);
          if (satisfiesRange(version, item.range)) findings.push({ audit: name, package: packageName, version, advisoryId: id, severity: item.severity, path });
        }
      }
    }
  } else {
    fail(`${name}: unsupported audit JSON shape`);
  }
  const reported = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (reported > 0 && findings.length === 0 && (counts.high > 0 || counts.critical > 0)) fail(`${name}: report contains high/critical counts but no identified advisories`);
  return { counts, findings };
}

function tuple(finding) {
  return [finding.audit, finding.package, finding.version, finding.advisoryId, finding.path, finding.severity].join('\0');
}
function validDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function evaluateAudits({ reports, statuses, baseline, packageLock, inputErrors = {}, today = new Date().toISOString().slice(0, 10) }) {
  const operationalErrors = [];
  const runs = {};
  const currentFindings = [];
  for (const name of AUDITS) {
    try {
      if (inputErrors[name]) fail(`${name}: ${inputErrors[name]}`);
      const status = statuses[name];
      if (!Number.isInteger(status) || (status !== 0 && status !== 1)) fail(`${name}: audit command failed operationally (exit ${status ?? 'missing'})`);
      const parsed = parseAuditReport(name, reports[name], name.startsWith('worker-') ? packageLock : undefined);
      const count = Object.values(parsed.counts).reduce((sum, value) => sum + value, 0);
      if ((status === 0 && count > 0) || (status === 1 && count === 0)) fail(`${name}: exit status ${status} does not match the audit result; likely network or registry failure`);
      runs[name] = { status, counts: parsed.counts, highCritical: parsed.findings.length };
      currentFindings.push(...parsed.findings);
    } catch (error) {
      operationalErrors.push(error instanceof Error ? error.message : `${name}: unknown error`);
    }
  }

  if (!baseline || typeof baseline !== 'object' || typeof baseline.owner !== 'string' || !baseline.owner ||
    typeof baseline.reviewedAt !== 'string' || !validDate(baseline.reviewedAt)) {
    operationalErrors.push('baseline: reviewedAt must be a real date and owner must be set');
  }
  const entries = baseline?.findings;
  if (!Array.isArray(entries)) operationalErrors.push('baseline: findings must be an array');
  const byTuple = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.audit !== 'string' || typeof entry.package !== 'string' || typeof entry.version !== 'string' ||
      typeof entry.advisoryId !== 'string' || typeof entry.path !== 'string' || typeof entry.expiresAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresAt) || !validDate(entry.expiresAt) || !HIGH.has(entry.severity) ||
      typeof entry.reason !== 'string' || !entry.reason) {
      operationalErrors.push('baseline: malformed exception entry');
      continue;
    }
    const key = tuple(entry);
    if (byTuple.has(key)) operationalErrors.push(`baseline: duplicate exception ${entry.advisoryId} at ${entry.path}`);
    byTuple.set(key, entry);
  }

  const reviewed = [];
  const newHighCritical = [];
  const expired = [];
  const matchedKeys = new Set();
  for (const finding of currentFindings) {
    const entry = byTuple.get(tuple(finding));
    if (!entry) { newHighCritical.push(finding); continue; }
    matchedKeys.add(tuple(finding));
    if (entry.expiresAt <= today) expired.push({ ...finding, expiresAt: entry.expiresAt, reason: entry.reason });
    else reviewed.push({ ...finding, expiresAt: entry.expiresAt, reason: entry.reason });
  }
  const noLongerReported = [...byTuple.entries()].filter(([key]) => !matchedKeys.has(key)).map(([, entry]) => entry);
  return { today, runs, operationalErrors, reviewed, newHighCritical, expired, noLongerReported,
    passed: operationalErrors.length === 0 && newHighCritical.length === 0 && expired.length === 0 };
}

export function renderSummary(result) {
  const lines = ['## Dependency audit', '', `Audit date: ${result.today} UTC`, ''];
  for (const [name, run] of Object.entries(result.runs)) {
    const counts = Object.entries(run.counts).filter(([, count]) => count > 0).map(([severity, count]) => `${severity} ${count}`).join(', ') || 'no advisories';
    lines.push(`- **${name}**: ${counts}; command exit ${run.status}${run.status === 1 ? ' (advisories found)' : ''}`);
  }
  lines.push('', `Reviewed high/critical findings: ${result.reviewed.length}; new/changed: ${result.newHighCritical.length}; expired: ${result.expired.length}.`);
  if (result.operationalErrors.length) lines.push('', '### Audit errors', ...result.operationalErrors.map(item => `- ${item}`));
  if (result.newHighCritical.length) lines.push('', '### New or changed high/critical findings', ...result.newHighCritical.map(item => `- ${item.audit}: ${item.package}@${item.version} ${item.advisoryId} (${item.severity}) — \`${item.path}\``));
  if (result.expired.length) lines.push('', '### Expired reviewed findings', ...result.expired.map(item => `- ${item.audit}: ${item.package}@${item.version} ${item.advisoryId} — review expired ${item.expiresAt}; ${item.reason}`));
  if (result.noLongerReported.length) lines.push('', `Baseline entries no longer reported: ${result.noLongerReported.length}. Remove them after review.`);
  lines.push('', 'Audit exit code 1 is accepted only when valid JSON reports vulnerabilities. Registry/network failures, malformed JSON, new high/critical findings, and expired exceptions fail this workflow. No dependency updates are applied.');
  return lines.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const value = flag => { const index = args.indexOf(flag); if (index < 0 || !args[index + 1]) fail(`missing ${flag}`); return args[index + 1]; };
  const resultsDir = resolve(value('--results-dir'));
  const baseline = JSON.parse(await readFile(resolve(value('--baseline')), 'utf8'));
  const packageLock = JSON.parse(await readFile(resolve(value('--package-lock')), 'utf8'));
  const reports = {};
  const statuses = {};
  const inputErrors = {};
  for (const name of AUDITS) {
    try { reports[name] = JSON.parse(await readFile(resolve(resultsDir, `${name}.json`), 'utf8')); }
    catch (error) { reports[name] = {}; inputErrors[name] = `invalid or missing JSON: ${error instanceof Error ? error.message : error}`; }
    try {
      const statusText = (await readFile(resolve(resultsDir, `${name}.exit`), 'utf8')).trim();
      if (!/^\d+$/.test(statusText)) fail('malformed exit status');
      statuses[name] = Number(statusText);
    } catch (error) { inputErrors[name] = `${inputErrors[name] ? `${inputErrors[name]}; ` : ''}${error instanceof Error ? error.message : error}`; }
  }
  const result = evaluateAudits({ reports, statuses, baseline, packageLock, inputErrors });
  const summary = renderSummary(result);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) await writeFile(summaryFile, summary, { flag: 'a' });
  await writeFile(resolve(resultsDir, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(summary);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
