import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const directory = await mkdtemp(join(tmpdir(), 'kakeimatch-crypto-'));
let browser;
const server = createServer(async (request, response) => {
  if (request.url === '/format.js') {
    response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(join(directory, 'format.js')));
  } else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Synthetic encryption test</title>'); }
});
try {
  const entry = join(directory, 'entry.ts');
  const modules = ['encrypted-household-format', 'encrypted-sync-version', 'local-backup-format'];
  await writeFile(entry, modules.map(name => `export * from ${JSON.stringify(fileURLToPath(new URL(`../../../src/lib/${name}.ts`, import.meta.url)))};`).join('\n'));
  await build({ configFile: false, logLevel: 'error', build: { outDir: directory, emptyOutDir: false,
    lib: { entry, formats: ['es'], fileName: () => 'format.js' },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
  const first = await browser.newContext(); const firstPage = await first.newPage(); await firstPage.goto(url);
  const backup = await firstPage.evaluate(async () => {
    const api = await import('/format.js');
    const context = { householdId: crypto.randomUUID(), generation: 1, versionId: crypto.randomUUID(), parentVersionId: null };
    const { key, recoveryCode, protectedKey } = await api.createHouseholdEncryptionKey(context.householdId, 1);
    const data = new Blob([new Uint8Array(api.ENCRYPTED_CHUNK_BYTES).fill(91), 'synthetic-only']);
    const ciphertext = await api.encryptHouseholdBlob(data, key, context);
    const portable = await api.createPortableBackup({ actualBackup: new Uint8Array([42, 43, 44]), localData: {
      format: 'kakeimatch-local-data', schemaVersion: 2, exportedAt: '2026-10-04T00:00:00.000Z', records: [], blobs: [],
    } });
    const version = await api.prepareEncryptedSyncVersion(portable, key, context);
    const chunks = [];
    for (const chunk of version.metadata.chunks) chunks.push(Array.from(new Uint8Array(await version.chunk(chunk.index).arrayBuffer())));
    // Structured cloning must preserve the non-extractable key, as future IndexedDB storage will require.
    const clone = structuredClone(key);
    if (clone.extractable || await (await api.decryptHouseholdBlob(ciphertext, clone, context)).slice(-14).text() !== 'synthetic-only') throw new Error('Key clone failed');
    return { context, recoveryCode, protectedKey, encrypted: Array.from(new Uint8Array(await ciphertext.arrayBuffer())), version: { metadata: version.metadata, chunks } };
  });
  await first.close(); // The second browser context has no source-device storage or key.
  const second = await browser.newContext(); const page = await second.newPage(); await page.goto(url);
  const result = await page.evaluate(async backup => {
    const api = await import('/format.js'); localStorage.setItem('synthetic-household', 'keep-original');
    const key = await api.recoverHouseholdEncryptionKey(backup.protectedKey, backup.recoveryCode, backup.context);
    const cipher = new Blob([new Uint8Array(backup.encrypted)]);
    const plain = await api.decryptHouseholdBlob(cipher, key, backup.context);
    const restored = await api.decryptPortableSyncVersion(backup.version.metadata, backup.context, key, async index => new Blob([new Uint8Array(backup.version.chunks[index])]));
    const actual = Array.from((await api.readPortableBackup(restored)).actualBackup);
    const changed = new Uint8Array(backup.encrypted); changed[changed.length - 1] ^= 1;
    let rejected = false;
    try { await api.decryptHouseholdBlob(new Blob([changed]), key, backup.context); } catch { rejected = true; }
    return { extractable: key.extractable, size: plain.size, tail: await plain.slice(-14).text(), rejected, original: localStorage.getItem('synthetic-household'), actual };
  }, backup);
  assert.deepEqual(result, { extractable: false, size: 4 * 1024 * 1024 + 14, tail: 'synthetic-only', rejected: true, original: 'keep-original', actual: [42, 43, 44] });
  console.log('PASS browser encryption: fresh-device recovery, key clone, chunk boundary, tampering and original preservation');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
}
