import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { discoverTests } from './shard-ui-tests.mjs';

const run = promisify(execFile);
const shardScript = new URL('./shard-ui-tests.mjs', import.meta.url);
const defaultSeconds = 30;

// Methods with no measurement yet. Replace each with a measured value once a run has it.
export const estimates = {
  // Split from one test into light (pull requests) and dark (main only). The split is estimated from the code: the dark pass repeats the same navigation.
  'EntryFlowTests/testManualExpenseScreensAndSaveInLight': 54,
  'EntryFlowTests/testManualExpenseScreensInDark': 50,
  'ReconciliationFlowTests/testReferenceStatesAndEmptyImporterInLight': 34,
  'ReconciliationFlowTests/testReferenceStatesAndEmptyImporterInDark': 35,
  // Trimmed by removing a repeated part: the calendar dark pass, the search-result confirm and undo, and the XL manual-entry leg.
  'RecordsFlowTests/testSearchPeriodOpensCalendar': 30,
  'RecordsFlowTests/testRecordsSearchDetailEditDeleteUndoAndReturn': 49,
  'DynamicTypeLayoutTests/testAccessibilityXLHomeRecordsEntryAndSettingsStayInsideScreen': 95,
};

// Xcode prints one line per passed method: Test Case '-[KakeiMatchUITests.Class method]' passed (12.3 seconds)
const passedLine = /Test Case '-\[KakeiMatchUITests\.(\w+) (\w+)\]' passed \(([\d.]+) seconds\)/g;

export function parseDurations(log) {
  return [...log.matchAll(passedLine)].map(([, className, method, seconds]) => [`${className}/${method}`, Number(seconds)]);
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = (sorted.length - 1) / 2;
  return (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2;
}

function addSamples(samples, log) {
  for (const [name, seconds] of parseDurations(log)) {
    samples.set(name, [...(samples.get(name) ?? []), seconds]);
  }
  return samples;
}

// Pull request runs come first; main runs cover the screenshot-only methods that pull requests skip.
export function buildWeights(tests, { pullRequestSamples, mainSamples, estimated = estimates }) {
  return Object.fromEntries(tests.map(name => {
    if (name in estimated) return [name, { seconds: estimated[name], source: 'estimate' }];
    if (pullRequestSamples.has(name)) return [name, { seconds: Math.round(median(pullRequestSamples.get(name))), source: 'pull-request' }];
    if (mainSamples.has(name)) return [name, { seconds: Math.round(median(mainSamples.get(name))), source: 'main' }];
    return [name, { seconds: defaultSeconds, source: 'default' }];
  }));
}

export function formatWeightTable(weights) {
  const lines = Object.keys(weights).sort((a, b) => a.localeCompare(b, 'en')).map(name => {
    const { seconds, source } = weights[name];
    const note = source === 'default' ? ' // no measurement yet: default' : '';
    return `  '${name}': ${seconds},${note}`;
  });
  return `export const durations = {\n${lines.join('\n')}\n};`;
}

export function replaceWeightTable(source, table) {
  const pattern = /\/\/ BEGIN generated weights\n[\s\S]*?\/\/ END generated weights/;
  if (!pattern.test(source)) throw new Error('shard-ui-tests.mjs has no generated weights markers');
  return source.replace(pattern, `// BEGIN generated weights\n${table}\n// END generated weights`);
}

async function gh(args) {
  return (await run('gh', args, { maxBuffer: 256 * 1024 * 1024 })).stdout;
}

// Reads the ui-tests job logs of each run with the GitHub CLI.
async function collectSamples(runIds) {
  const samples = new Map();
  for (const runId of runIds) {
    const jobs = JSON.parse(await gh(['run', 'view', runId, '--json', 'jobs'])).jobs
      .filter(job => job.name.startsWith('ui-tests'));
    for (const job of jobs) {
      addSamples(samples, await gh(['run', 'view', runId, '--log', '--job', String(job.databaseId)]));
    }
  }
  return samples;
}

function parseArgs(args) {
  const value = flag => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const list = text => (text ?? '').split(',').filter(Boolean);
  return { pullRequestRuns: list(value('--pr-runs')), mainRuns: list(value('--main-runs')), write: args.includes('--write') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { pullRequestRuns, mainRuns, write } = parseArgs(process.argv.slice(2));
  if (pullRequestRuns.length === 0 && mainRuns.length === 0) {
    throw new Error('Usage: generate-ui-test-weights.mjs --pr-runs <id,id,...> [--main-runs <id,...>] [--write]');
  }
  const tests = await discoverTests(new URL('../KakeiMatchUITests/', import.meta.url));
  const weights = buildWeights(tests, {
    pullRequestSamples: await collectSamples(pullRequestRuns),
    mainSamples: await collectSamples(mainRuns),
  });
  const sources = Object.values(weights).reduce((count, { source }) => ({ ...count, [source]: (count[source] ?? 0) + 1 }), {});
  console.error(`weights for ${tests.length} UI tests:`, JSON.stringify(sources));
  // The run IDs stay in the generated block so the table can be rebuilt after CI logs expire (90 days).
  const provenance = `// Measured from macos-26 runs. Pull requests: ${pullRequestRuns.join(', ') || 'none'}. Main: ${mainRuns.join(', ') || 'none'}.`;
  const table = `${provenance}\n${formatWeightTable(weights)}`;
  if (write) {
    await writeFile(shardScript, replaceWeightTable(await readFile(shardScript, 'utf8'), table));
  } else {
    console.log(table);
  }
}
