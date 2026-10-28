import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Class totals in seconds from run 40690081345. These are hints, not a test list:
// deleted classes disappear; new classes receive the default estimate.
const durations = {
  AppShellSettingsTests: 36, EntryFlowTests: 133, FixtureLaunchTests: 36,
  HomeBottomInsetTests: 19, HomeFlowTests: 99, NavigationSmokeTests: 48,
  ReceiptFlowTests: 152, ReconciliationBadgeTests: 16,
  ReconciliationFlowTests: 136, RecordsFlowTests: 57, SettingsFlowTests: 29,
};

export async function discoverClasses(directory) {
  const classes = [];
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.swift')).sort()) {
    const source = await readFile(new URL(file, directory), 'utf8');
    // Ignore commented declarations and quoted text, preserving line boundaries.
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g, '');
    classes.push(...[...code.matchAll(/\bclass\s+(\w+)\s*:\s*XCTestCase\b/g)].map(match => match[1]));
  }
  if (classes.length === 0 || new Set(classes).size !== classes.length) {
    throw new Error('Expected non-empty, uniquely named XCTestCase subclasses');
  }
  return classes.sort();
}

export function validateCoverage(classes, shards) {
  const assigned = shards.flatMap(shard => shard.classes);
  if (shards.some(shard => shard.classes.length === 0)
      || assigned.length !== classes.length
      || new Set(assigned).size !== assigned.length
      || classes.some(name => !assigned.includes(name))) {
    throw new Error('Every discovered class must appear in exactly one non-empty shard');
  }
}

export function assignShards(classes, count, weights = durations) {
  if (!Number.isInteger(count) || count < 1 || count > classes.length) {
    throw new Error('Shard count must be an integer between 1 and the class count');
  }
  const weight = name => weights[name] ?? 60;
  const ordered = [...classes].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, 'en'));
  const shards = Array.from({ length: count }, () => ({ classes: [], estimatedSeconds: 0 }));
  for (const name of ordered) {
    const shard = shards.reduce((best, candidate) => candidate.estimatedSeconds < best.estimatedSeconds ? candidate : best);
    shard.classes.push(name);
    shard.estimatedSeconds += weight(name);
  }
  validateCoverage(classes, shards);
  return shards;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const classes = await discoverClasses(new URL('../KakeiMatchUITests/', import.meta.url));
  const shards = assignShards(classes, Number(process.argv[2]));
  const index = process.argv[3];
  if (index === undefined) {
    console.log(JSON.stringify(shards, null, 2));
  } else {
    if (!/^\d+$/.test(index) || !shards[Number(index)]) throw new Error('Invalid shard index');
    console.log(shards[Number(index)].classes.join('\n'));
  }
}
