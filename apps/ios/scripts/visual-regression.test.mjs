import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  attachmentBaseName,
  parseArgs,
  parseCaptureName,
  planComparison,
  readCaptures,
  runVisualRegression,
} from './visual-regression.mjs';
import { buildDiff, composeSideBySide, decodePng, encodePng, resizeToWidth } from './visual-regression-png.mjs';

function solid(width, height, color) {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = color[0];
    data[index * 4 + 1] = color[1];
    data[index * 4 + 2] = color[2];
    data[index * 4 + 3] = 255;
  }
  return { width, height, data };
}

async function writePng(path, image) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encodePng(image));
}

const UUID = '833E559D-70DE-4747-837C-FF7BFD421054';
const UUID2 = '0D60A74B-9256-45F7-A1AF-B8B4D9EB2E4D';

test('normalizes xcresult attachment names including extension-less names', () => {
  assert.equal(attachmentBaseName(`home-populated-light_0_${UUID}.png`), 'home-populated-light.png');
  assert.equal(attachmentBaseName(`settings_0_${UUID}.screen-dark`), 'settings.screen-dark');
  assert.equal(attachmentBaseName('plain-name'), 'plain-name');
  assert.equal(attachmentBaseName(''), null);
  assert.equal(attachmentBaseName(undefined), null);
});

test('splits attachment names into state key and theme', () => {
  assert.deepEqual(parseCaptureName('home-populated-light.png'), { key: 'home-populated', theme: 'light' });
  assert.deepEqual(parseCaptureName('settings.screen-dark'), { key: 'settings.screen', theme: 'dark' });
  assert.deepEqual(parseCaptureName('settings-shell-screen-lock-launch'), { key: 'settings-shell-screen-lock-launch', theme: null });
  assert.equal(parseCaptureName(''), null);
});

test('parses repeated --ios arguments and rejects unknown arguments', () => {
  const options = parseArgs(['--ios', 'a', '--ios', 'b', '--reference', 'ref', '--output', 'out']);
  assert.deepEqual(options.iosDirs, ['a', 'b']);
  assert.equal(options.width, 390);
  assert.throws(() => parseArgs(['--ios', 'a', '--reference', 'ref', '--output', 'out', '--wat']), /Unknown argument/);
  assert.throws(() => parseArgs(['--reference', 'ref', '--output', 'out']), /At least one --ios/);
});

test('reads captures from shard manifests and reports duplicates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ios-visual-captures-'));
  try {
    await writePng(join(directory, 'a.png'), solid(2, 2, [255, 0, 0]));
    await writePng(join(directory, 'b.png'), solid(2, 2, [0, 255, 0]));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify([
      {
        testIdentifier: 'HomeFlowTests/testHomeReferenceStatesInLightAndDark()',
        attachments: [
          { exportedFileName: 'a.png', suggestedHumanReadableName: `home-empty-light_0_${UUID}.png` },
          { exportedFileName: 'a.png', suggestedHumanReadableName: `home-empty-light_1_${UUID2}.png` },
          { exportedFileName: 'b.png', suggestedHumanReadableName: `settings_0_${UUID2}.screen-dark` },
          { exportedFileName: 'notes.txt', suggestedHumanReadableName: `ignored_0_${UUID}.txt` },
        ],
      },
    ]));
    const { captures, duplicates } = await readCaptures([directory]);
    assert.deepEqual([...captures.keys()], ['home-empty-light', 'settings.screen-dark']);
    assert.equal(captures.get('home-empty-light').testIdentifier, 'HomeFlowTests/testHomeReferenceStatesInLightAndDark()');
    assert.equal(duplicates.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('classifies compared, PWA-only, iOS-only, and missing captures', async () => {
  const captures = new Map([
    ['home-empty-light', { id: 'home-empty-light', key: 'home-empty', theme: 'light', path: 'ios.png' }],
    ['receipt-warnings-dark', { id: 'receipt-warnings-dark', key: 'receipt-warnings', theme: 'dark', path: 'ios2.png' }],
  ]);
  const references = [
    { screen: 'home', state: 'empty', theme: 'light', reference: 'home/empty', path: 'ref1.png' },
    { screen: 'home', state: 'empty', theme: 'dark', reference: 'home/empty', path: 'ref2.png' },
    { screen: 'device-link', state: 'initial', theme: 'light', reference: 'device-link/initial', path: 'ref3.png' },
  ];
  const plan = planComparison({ 'home-empty': 'home/empty' }, captures, references);
  assert.equal(plan.compared.length, 1);
  assert.equal(plan.compared[0].theme, 'light');
  assert.deepEqual(plan.iosMissing.map((entry) => `${entry.theme}`), ['dark']);
  assert.deepEqual(plan.pwaOnly.map((entry) => `${entry.reference}-${entry.theme}`), ['device-link/initial-light']);
  assert.deepEqual(plan.iosOnly.map((entry) => entry.id), ['receipt-warnings-dark']);
});

test('rejects a mapping entry that points to a missing reference', () => {
  assert.throws(
    () => planComparison({ typo: 'home/empty' }, new Map(), []),
    /points to a missing reference/,
  );
});

test('round-trips RGBA PNG data and scales with a box filter', () => {
  const image = solid(3, 2, [10, 20, 30]);
  image.data[0] = 200;
  const decoded = decodePng(encodePng(image));
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 2);
  assert.equal(decoded.data[0], 200);
  assert.equal(decoded.data[4], 10);
  assert.equal(decoded.data[3], 255);

  const scaled = resizeToWidth(decoded, 2);
  assert.equal(scaled.width, 2);
  assert.equal(scaled.height, 1);
  assert.equal(scaled.data.length, 2 * 1 * 4);
});

test('composes side by side and marks changed pixels in the diff', () => {
  const left = solid(2, 2, [0, 0, 0]);
  const right = solid(2, 2, [255, 255, 255]);
  const combined = composeSideBySide(left, right, { gap: 1 });
  assert.equal(combined.width, 5);
  assert.equal(combined.height, 2);
  const same = buildDiff(left, left);
  assert.equal(same.changed, 0);
  const different = buildDiff(left, right);
  assert.equal(different.changed, 4);
  assert.equal(different.comparedPixels, 4);
  assert.deepEqual([...different.image.data.subarray(0, 3)], [214, 47, 58]);
});

test('writes side-by-side images, diffs, index.html, index.md, and report.json', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ios-visual-e2e-'));
  try {
    const reference = join(directory, 'reference');
    const ios = join(directory, 'ios');
    const output = join(directory, 'out');
    await writePng(join(reference, 'home', 'empty-light.png'), solid(9, 18, [250, 250, 250]));
    await writePng(join(reference, 'home', 'empty-dark.png'), solid(9, 18, [20, 20, 20]));
    await writePng(join(reference, 'device-link', 'initial-light.png'), solid(9, 18, [200, 200, 200]));
    await writePng(join(ios, 'a.png'), solid(12, 24, [248, 248, 248]));
    await writePng(join(ios, 'b.png'), solid(12, 24, [30, 30, 30]));
    await writePng(join(ios, 'c.png'), solid(12, 24, [10, 10, 10]));
    await writeFile(join(ios, 'manifest.json'), JSON.stringify([
      {
        testIdentifier: 'HomeFlowTests/testHomeReferenceStatesInLightAndDark()',
        attachments: [
          { exportedFileName: 'a.png', suggestedHumanReadableName: `home-empty-light_0_${UUID}.png` },
          { exportedFileName: 'b.png', suggestedHumanReadableName: `home-empty-dark_0_${UUID2}.png` },
          { exportedFileName: 'c.png', suggestedHumanReadableName: `receipt-warnings-dark_0_${UUID}.png` },
        ],
      },
    ]));
    const mapping = join(directory, 'pairs.json');
    await writeFile(mapping, JSON.stringify({ pairs: { 'home-empty': 'home/empty' } }));

    const report = await runVisualRegression({ iosDirs: [ios], referenceDir: reference, outputDir: output, mappingPath: mapping, width: 9, threshold: 12 });
    assert.deepEqual(report.summary, { compared: 2, pwaOnly: 1, iosOnly: 1, iosMissing: 0, mappingIssues: 0, duplicates: 0 });
    assert.equal(report.pairs.length, 2);
    const light = report.pairs.find((pair) => pair.theme === 'light');
    assert.match(light.sideBySide, /images\/home-empty-light-side-by-side\.png/);
    assert.match(light.diff, /images\/home-empty-light-diff\.png/);
    assert.ok((await readFile(join(output, 'index.html'), 'utf8')).includes('PWA と iOS の画面比較'));
    assert.ok((await readFile(join(output, 'index.md'), 'utf8')).includes('| home / empty |'));
    const saved = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.equal(saved.format, 'kakeimatch-visual-regression');
    assert.equal(saved.pwaOnly[0].screen, 'device-link');
    assert.equal(saved.iosOnly[0].key, 'receipt-warnings');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
