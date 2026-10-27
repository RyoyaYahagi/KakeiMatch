// Pins the observable payee title-casing rules from Actual API 26.9.0, not a new formatter.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const entry = require.resolve('@actual-app/api');
const map = JSON.parse(readFileSync(resolve(dirname(entry), 'index.js.map'), 'utf8'));
const source = suffix => map.sourcesContent[map.sources.findIndex(name => name.endsWith(suffix))];
const title = source('/accounts/title/index.ts');
const character = runInNewContext(title.match(/const character =\s*('[^']*');/u)[1]);
const words = text => [...text.matchAll(/'([^']+)'/gu)].map(match => match[1]);
const data = { actualVersion: '26.9.0', character, lowerCaseWords: words(source('/accounts/title/lower-case.ts')), specials: words(source('/accounts/title/specials.ts')) };
writeFileSync(new URL('../KakeiMatch/Data/Ledger/payee-normalization.json', import.meta.url), `${JSON.stringify(data, null, 2)}\n`);
