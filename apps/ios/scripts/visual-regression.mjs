import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePng, encodePng, resizeToWidth, composeSideBySide, buildDiff } from './visual-regression-png.mjs';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAPPING = join(SCRIPT_DIRECTORY, 'visual-regression-pairs.json');
const DEFAULT_WIDTH = 390;
const DEFAULT_THRESHOLD = 12;
const THEMES = ['light', 'dark'];
const THEME_LABELS = { light: 'ライト', dark: 'ダーク' };

export function usage() {
  return [
    'Usage: visual-regression.mjs --ios <screenshots directory> [--ios <directory> ...]',
    '                                --reference <docs/screenshots/migration>',
    '                                --output <report directory>',
    '                                [--mapping <visual-regression-pairs.json>]',
    '                                [--width 390] [--threshold 12]',
  ].join('\n');
}

export function parseArgs(argv) {
  const options = { iosDirs: [], referenceDir: null, outputDir: null, mappingPath: DEFAULT_MAPPING, width: DEFAULT_WIDTH, threshold: DEFAULT_THRESHOLD };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${argument}`);
      return argv[index];
    };
    switch (argument) {
      case '--ios': options.iosDirs.push(next()); break;
      case '--reference': options.referenceDir = next(); break;
      case '--output': options.outputDir = next(); break;
      case '--mapping': options.mappingPath = next(); break;
      case '--width': options.width = Number.parseInt(next(), 10); break;
      case '--threshold': options.threshold = Number.parseInt(next(), 10); break;
      case '--help':
      case '-h': options.help = true; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.help) return options;
  if (options.iosDirs.length === 0) throw new Error('At least one --ios directory is required');
  if (!options.referenceDir) throw new Error('--reference is required');
  if (!options.outputDir) throw new Error('--output is required');
  if (!Number.isInteger(options.width) || options.width <= 0) throw new Error('--width must be a positive integer');
  if (!Number.isInteger(options.threshold) || options.threshold < 0) throw new Error('--threshold must be a non-negative integer');
  return options;
}

/**
 * xcresulttool names an exported attachment `<attachment name>_<index>_<UUID>`
 * and preserves the original extension. Names without an extension such as
 * `settings.screen-dark` therefore become `settings_0_<UUID>.screen-dark`.
 */
export function attachmentBaseName(suggestedName) {
  if (typeof suggestedName !== 'string' || suggestedName.trim() === '') return null;
  let name = suggestedName.trim().replace(/^.*[\\/]/, '');
  const match = name.match(/^(.*?)_\d+_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.[^.]*)?$/i);
  if (match) name = `${match[1]}${match[3] ?? ''}`;
  return name;
}

/** Split `home-populated-light` into `{ key: 'home-populated', theme: 'light' }`. */
export function parseCaptureName(baseName) {
  if (typeof baseName !== 'string' || baseName === '') return null;
  const name = baseName.replace(/\.png$/i, '');
  const match = name.match(/^(.*)-(light|dark)$/i);
  if (match) return { key: match[1], theme: match[2].toLowerCase() };
  return { key: name, theme: null };
}

export async function readCaptures(iosDirs) {
  const captures = new Map();
  const duplicates = [];
  for (const directory of iosDirs) {
    const manifestPath = join(directory, 'manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot read ${manifestPath}: ${error.message}`);
    }
    if (!Array.isArray(manifest)) throw new Error(`${manifestPath} must contain a JSON array`);
    for (const entry of manifest) {
      if (!entry || typeof entry !== 'object') continue;
      const testIdentifier = typeof entry.testIdentifier === 'string' ? entry.testIdentifier : null;
      const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
      for (const attachment of attachments) {
        if (!attachment || typeof attachment !== 'object') continue;
        const exportedFileName = attachment.exportedFileName;
        if (typeof exportedFileName !== 'string' || !/\.png$/i.test(exportedFileName)) continue;
        const base = attachmentBaseName(attachment.suggestedHumanReadableName)
          ?? attachmentBaseName(attachment.name)
          ?? exportedFileName.replace(/\.png$/i, '');
        const parsed = parseCaptureName(base);
        if (!parsed) continue;
        const id = parsed.theme ? `${parsed.key}-${parsed.theme}` : parsed.key;
        if (captures.has(id)) {
          duplicates.push({ id, kept: relative(process.cwd(), captures.get(id).path), ignored: join(directory, exportedFileName) });
          continue;
        }
        captures.set(id, {
          id,
          key: parsed.key,
          theme: parsed.theme,
          path: join(directory, exportedFileName),
          testIdentifier,
        });
      }
    }
  }
  return { captures, duplicates };
}

export async function readMapping(mappingPath) {
  let mapping;
  try {
    mapping = JSON.parse(await readFile(mappingPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${mappingPath}: ${error.message}`);
  }
  const pairs = mapping?.pairs;
  if (!pairs || typeof pairs !== 'object' || Array.isArray(pairs)) throw new Error(`${mappingPath} must contain a "pairs" object`);
  for (const [iosKey, reference] of Object.entries(pairs)) {
    if (typeof reference !== 'string' || !/^[^/]+\/[^/]+$/.test(reference)) {
      throw new Error(`Invalid reference for ${iosKey}: ${reference}`);
    }
  }
  return pairs;
}

export async function readReferences(referenceDir) {
  const references = [];
  let entries;
  try {
    entries = await readdir(referenceDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read reference directory ${referenceDir}: ${error.message}`);
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'ios') continue;
    const screen = entry.name;
    for (const file of (await readdir(join(referenceDir, screen))).sort()) {
      const match = file.match(/^(.+)-(light|dark)\.png$/i);
      if (!match) continue;
      references.push({
        screen,
        state: match[1],
        theme: match[2].toLowerCase(),
        path: join(referenceDir, screen, file),
        reference: `${screen}/${match[1]}`,
      });
    }
  }
  return references;
}

export function planComparison(mapping, captures, references) {
  const mappingKeys = new Set();
  const mappedCaptureKeys = new Set();
  const compared = [];
  const iosMissing = [];
  const mappingIssues = [];

  for (const [iosKey, reference] of Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b))) {
    const [screen, state] = reference.split('/');
    let seenReference = false;
    for (const theme of THEMES) {
      const referenceKey = `${reference}-${theme}`;
      const captureKey = `${iosKey}-${theme}`;
      mappingKeys.add(referenceKey);
      mappedCaptureKeys.add(captureKey);
      const referenceEntry = references.find((entry) => entry.reference === reference && entry.theme === theme);
      const capture = captures.get(captureKey);
      if (referenceEntry) seenReference = true;
      if (referenceEntry && capture) {
        compared.push({ iosKey, screen, state, theme, capture, referenceEntry });
      } else if (referenceEntry && !capture) {
        iosMissing.push({ iosKey, screen, state, theme, reference: referenceEntry, captureKey });
      } else if (!referenceEntry && capture) {
        mappingIssues.push({ iosKey, theme, reason: `参照画像がない: ${referenceKey}`, capture });
      }
    }
    if (!seenReference) throw new Error(`Mapping ${iosKey} points to a missing reference: ${reference}`);
  }

  const iosOnly = [...captures.values()]
    .filter((capture) => !mappedCaptureKeys.has(capture.theme ? `${capture.key}-${capture.theme}` : capture.key))
    .filter((capture) => !mappingIssues.some((issue) => issue.capture.id === capture.id));
  const pwaOnly = references.filter((entry) => !mappingKeys.has(`${entry.reference}-${entry.theme}`));

  const bySort = (left, right) => `${left.screen}/${left.state}/${left.theme}`.localeCompare(`${right.screen}/${right.state}/${right.theme}`);
  compared.sort(bySort);
  iosMissing.sort(bySort);
  iosOnly.sort((left, right) => left.id.localeCompare(right.id));
  pwaOnly.sort(bySort);
  mappingIssues.sort((left, right) => left.iosKey.localeCompare(right.iosKey));
  return { compared, iosMissing, iosOnly, pwaOnly, mappingIssues };
}

function artifactName(value) {
  return value.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '') || 'state';
}

function toUrlPath(path) {
  return path.split(sep).join('/');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function themeLabel(theme) {
  return THEME_LABELS[theme] ?? 'テーマなし';
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

async function writeScaledImage(sourcePath, outputPath, width, copies) {
  const image = decodePng(await readFile(sourcePath));
  const scaled = resizeToWidth(image, width);
  await writeFile(outputPath, encodePng(scaled));
  copies.push({ outputPath, width: scaled.width, height: scaled.height });
}

export async function runVisualRegression(options) {
  const mapping = await readMapping(options.mappingPath);
  const { captures, duplicates } = await readCaptures(options.iosDirs);
  const references = await readReferences(options.referenceDir);
  const plan = planComparison(mapping, captures, references);

  await rm(options.outputDir, { recursive: true, force: true });
  await mkdir(join(options.outputDir, 'images'), { recursive: true });
  await mkdir(join(options.outputDir, 'images', 'reference'), { recursive: true });
  await mkdir(join(options.outputDir, 'images', 'ios-only'), { recursive: true });

  const pairs = [];
  for (const entry of plan.compared) {
    const stem = `${artifactName(entry.screen)}-${artifactName(entry.state)}-${entry.theme}`;
    const referenceImage = resizeToWidth(decodePng(await readFile(entry.referenceEntry.path)), options.width);
    const captureImage = resizeToWidth(decodePng(await readFile(entry.capture.path)), options.width);
    const sideBySide = composeSideBySide(referenceImage, captureImage);
    const diff = buildDiff(referenceImage, captureImage, { threshold: options.threshold });
    const sideBySidePath = join(options.outputDir, 'images', `${stem}-side-by-side.png`);
    const diffPath = join(options.outputDir, 'images', `${stem}-diff.png`);
    await writeFile(sideBySidePath, encodePng(sideBySide));
    await writeFile(diffPath, encodePng(diff.image));
    pairs.push({
      iosKey: entry.iosKey,
      screen: entry.screen,
      state: entry.state,
      theme: entry.theme,
      referenceSource: entry.referenceEntry.path,
      iosSource: entry.capture.path,
      testIdentifier: entry.capture.testIdentifier,
      sideBySide: toUrlPath(relative(options.outputDir, sideBySidePath)),
      diff: toUrlPath(relative(options.outputDir, diffPath)),
      diffRatio: diff.comparedPixels === 0 ? 0 : Number((diff.changed / diff.comparedPixels).toFixed(4)),
      width: sideBySide.width,
      height: sideBySide.height,
    });
  }

  const pwaOnly = [];
  for (const entry of plan.pwaOnly) {
    const stem = `${artifactName(entry.screen)}-${artifactName(entry.state)}-${entry.theme}`;
    const outputPath = join(options.outputDir, 'images', 'reference', `${stem}.png`);
    const copies = [];
    await writeScaledImage(entry.path, outputPath, options.width, copies);
    pwaOnly.push({ screen: entry.screen, state: entry.state, theme: entry.theme, image: toUrlPath(relative(options.outputDir, outputPath)), width: copies[0].width, height: copies[0].height });
  }

  const iosOnly = [];
  for (const capture of plan.iosOnly) {
    const stem = artifactName(capture.theme ? `${capture.key}-${capture.theme}` : capture.key);
    const outputPath = join(options.outputDir, 'images', 'ios-only', `${stem}.png`);
    const copies = [];
    await writeScaledImage(capture.path, outputPath, options.width, copies);
    iosOnly.push({
      key: capture.key,
      theme: capture.theme,
      testIdentifier: capture.testIdentifier,
      image: toUrlPath(relative(options.outputDir, outputPath)),
      width: copies[0].width,
      height: copies[0].height,
    });
  }

  const report = {
    format: 'kakeimatch-visual-regression',
    version: 1,
    generatedAt: new Date().toISOString(),
    referenceDirectory: options.referenceDir,
    iosDirectories: options.iosDirs,
    normalizedWidth: options.width,
    diffThreshold: options.threshold,
    summary: {
      compared: pairs.length,
      pwaOnly: pwaOnly.length,
      iosOnly: iosOnly.length,
      iosMissing: plan.iosMissing.length,
      mappingIssues: plan.mappingIssues.length,
      duplicates: duplicates.length,
    },
    pairs,
    pwaOnly,
    iosOnly,
    iosMissing: plan.iosMissing.map((entry) => ({ iosKey: entry.iosKey, screen: entry.screen, state: entry.state, theme: entry.theme, reference: entry.reference.reference, expectedCapture: entry.captureKey })),
    mappingIssues: plan.mappingIssues.map((entry) => ({ iosKey: entry.iosKey, theme: entry.theme, reason: entry.reason })),
    duplicates,
  };

  await writeFile(join(options.outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(options.outputDir, 'index.html'), renderHtml(report));
  await writeFile(join(options.outputDir, 'index.md'), renderMarkdown(report));
  return report;
}

function pairHeading(pair) {
  return `${pair.screen} / ${pair.state}（${themeLabel(pair.theme)}）`;
}

function renderHtml(report) {
  const cards = report.pairs.map((pair) => `
      <article class="pair">
        <h3>${escapeHtml(pairHeading(pair))}<span class="metric">差分 ${percent(pair.diffRatio)}</span></h3>
        <p class="source"><code>${escapeHtml(pair.iosKey)}</code> → <code>${escapeHtml(pair.screen)}/${escapeHtml(pair.state)}</code></p>
        <div class="images">
          <figure><figcaption>PWA（左） / iOS（右）</figcaption><a href="${escapeHtml(pair.sideBySide)}"><img loading="lazy" src="${escapeHtml(pair.sideBySide)}" alt="${escapeHtml(pairHeading(pair))} の並列画像"></a></figure>
          <figure><figcaption>差分（赤: 閾値超え、橙: 重なり外）</figcaption><a href="${escapeHtml(pair.diff)}"><img loading="lazy" src="${escapeHtml(pair.diff)}" alt="${escapeHtml(pairHeading(pair))} の差分画像"></a></figure>
        </div>
      </article>`).join('');

  const pwaOnly = report.pwaOnly.map((entry) => `
      <article class="single">
        <h3>${escapeHtml(entry.screen)} / ${escapeHtml(entry.state)}（${themeLabel(entry.theme)}）</h3>
        <figure><a href="${escapeHtml(entry.image)}"><img loading="lazy" src="${escapeHtml(entry.image)}" alt="PWA ${escapeHtml(entry.screen)}/${escapeHtml(entry.state)}"></a><figcaption>PWA の参照画像のみ</figcaption></figure>
      </article>`).join('');

  const iosOnly = report.iosOnly.map((entry) => `
      <article class="single">
        <h3>${escapeHtml(entry.key)}${entry.theme ? `（${themeLabel(entry.theme)}）` : ''}</h3>
        <figure><a href="${escapeHtml(entry.image)}"><img loading="lazy" src="${escapeHtml(entry.image)}" alt="iOS ${escapeHtml(entry.key)}"></a><figcaption>${entry.testIdentifier ? `<code>${escapeHtml(entry.testIdentifier)}</code>` : '対応する参照画像なし'}</figcaption></figure>
      </article>`).join('');

  const iosMissing = report.iosMissing.map((entry) => `<li><code>${escapeHtml(entry.iosKey)}-${escapeHtml(entry.theme)}</code> → ${escapeHtml(entry.reference)}（未取得）</li>`).join('');
  const issues = report.mappingIssues.map((entry) => `<li><code>${escapeHtml(entry.iosKey)}</code>: ${escapeHtml(entry.reason)}</li>`).join('');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KakeiMatch PWA / iOS visual regression</title>
<style>
:root { color-scheme: light dark; --bg: #f7f7f5; --surface: #fff; --text: #1c1c1e; --muted: #666; --border: #d9d9d6; }
@media (prefers-color-scheme: dark) { :root { --bg: #141416; --surface: #1d1d20; --text: #f2f2f2; --muted: #a5a5aa; --border: #35353a; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1120px; padding: 24px; background: var(--bg); color: var(--text); font: 15px/1.6 -apple-system, "Hiragino Sans", sans-serif; }
h1 { font-size: 24px; margin: 0 0 8px; }
h2 { margin-top: 40px; border-bottom: 1px solid var(--border); padding-bottom: 8px; font-size: 20px; }
h3 { font-size: 16px; margin: 0 0 4px; display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.metric { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.lead { color: var(--muted); margin: 0 0 16px; }
.summary { display: flex; gap: 12px; flex-wrap: wrap; padding: 0; list-style: none; }
.summary li { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 8px 14px; }
.source { color: var(--muted); font-size: 12px; margin: 0 0 8px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.pair, .single { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px; margin: 0 0 20px; }
.images { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
figure { margin: 0; }
figure img { display: block; width: 100%; height: auto; border: 1px solid var(--border); border-radius: 8px; background: #18181b; }
figcaption { color: var(--muted); font-size: 12px; margin-top: 6px; }
.single { max-width: 480px; }
ul.plain { padding-left: 20px; }
</style>
</head>
<body>
<h1>PWA と iOS の画面比較</h1>
<p class="lead">同じ状態の PWA 参照画像と iOS のスクリーンショットを並べたレビュー用 artifact。画素一致は判定しません。端末幅・フォント・OS の時計や safe area・Liquid Glass の差は意図的に許容し、差分率は目安として表示します。</p>
<ul class="summary">
  <li>比較 <strong>${report.summary.compared}</strong></li>
  <li>PWA のみ <strong>${report.summary.pwaOnly}</strong></li>
  <li>iOS のみ <strong>${report.summary.iosOnly}</strong></li>
  <li>iOS 未取得 <strong>${report.summary.iosMissing}</strong></li>
</ul>
<p class="lead">生成: ${escapeHtml(report.generatedAt)} / 正規化幅 ${report.normalizedWidth}px / 差分閾値 ${report.diffThreshold}</p>

<h2>比較できた状態</h2>
${cards || '<p>比較できる状態がありません。</p>'}

<h2>PWA のみ（対応する iOS スクリーンショットなし）</h2>
${pwaOnly || '<p>ありません。</p>'}

<h2>iOS のみ（対応する PWA 参照画像なし）</h2>
${iosOnly || '<p>ありません。</p>'}

<h2>iOS 未取得（対応表はあるがスクリーンショットがない）</h2>
${iosMissing ? `<ul class="plain">${iosMissing}</ul>` : '<p>ありません。</p>'}

${issues ? `<h2>対応表の不整合</h2><ul class="plain">${issues}</ul>` : ''}
</body>
</html>
`;
}

function renderMarkdown(report) {
  const lines = [
    '# PWA と iOS の画面比較',
    '',
    '同じ状態の PWA 参照画像と iOS スクリーンショットを並べたレビュー用レポート。画素一致は判定しない。端末幅・フォント・OS の時計や safe area・Liquid Glass の差は意図的に許容し、差分率は目安。',
    '',
    `- 比較: **${report.summary.compared}**`,
    `- PWA のみ: **${report.summary.pwaOnly}**`,
    `- iOS のみ: **${report.summary.iosOnly}**`,
    `- iOS 未取得: **${report.summary.iosMissing}**`,
    `- 生成: ${report.generatedAt}`,
    `- 正規化幅: ${report.normalizedWidth}px / 差分閾値: ${report.diffThreshold}`,
    '',
    '## 比較できた状態',
    '',
    '| 画面 / 状態 | テーマ | 並べて比較 | 差分 | 差分率 |',
    '|---|---|---|---|---|',
    ...report.pairs.map((pair) => `| ${pair.screen} / ${pair.state} | ${themeLabel(pair.theme)} | [PNG](${pair.sideBySide}) | [PNG](${pair.diff}) | ${percent(pair.diffRatio)} |`),
    '',
    '## PWA のみ',
    '',
    ...(report.pwaOnly.length === 0 ? ['なし'] : report.pwaOnly.map((entry) => `- ${entry.screen} / ${entry.state}（${themeLabel(entry.theme)}）: [PNG](${entry.image})`)),
    '',
    '## iOS のみ',
    '',
    ...(report.iosOnly.length === 0 ? ['なし'] : report.iosOnly.map((entry) => `- ${entry.key}${entry.theme ? `（${themeLabel(entry.theme)}）` : ''}: [PNG](${entry.image})${entry.testIdentifier ? ` (\`${entry.testIdentifier}\`)` : ''}`)),
    '',
    '## iOS 未取得',
    '',
    ...(report.iosMissing.length === 0 ? ['なし'] : report.iosMissing.map((entry) => `- ${entry.iosKey}-${entry.theme} → ${entry.reference}`)),
    '',
  ];
  if (report.mappingIssues.length > 0) {
    lines.push('## 対応表の不整合', '', ...report.mappingIssues.map((entry) => `- ${entry.iosKey}: ${entry.reason}`), '');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const report = await runVisualRegression(options);
    console.log(`visual regression: ${report.summary.compared} pairs, ${report.summary.iosOnly} iOS only, ${report.summary.pwaOnly} PWA only, ${report.summary.iosMissing} missing`);
    console.log(`report: ${join(options.outputDir, 'index.html')}`);
  } catch (error) {
    console.error(`visual regression failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
