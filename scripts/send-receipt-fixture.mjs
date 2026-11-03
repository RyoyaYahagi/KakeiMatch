#!/usr/bin/env node
// Sends a synthetic receipt-export payload (schemaVersion 1) to a receiver for development.
// Node standard library only. Never use real household data as the fixture.
//
// Usage:
//   RECEIPT_EXPORT_URL=https://example-host:8443 RECEIPT_EXPORT_TOKEN=... \
//     node scripts/send-receipt-fixture.mjs [fixture.json]
//
// RECEIPT_EXPORT_URL is an origin only; the path /api/v1/receipts/import is fixed.
// https is required, except http on localhost/127.0.0.1/[::1] for a local mock receiver.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const IMPORT_PATH = '/api/v1/receipts/import';
export const DEFAULT_FIXTURE = fileURLToPath(new URL('../test/fixtures/receipt-export/sample-v1.json', import.meta.url));
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function importUrl(baseUrl) {
  let url;
  try { url = new URL(String(baseUrl ?? '').trim()); } catch { throw new Error('RECEIPT_EXPORT_URL must be an absolute URL'); }
  const secure = url.protocol === 'https:';
  const localMock = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (!secure && !localMock) throw new Error('RECEIPT_EXPORT_URL must use https (http is allowed only for localhost)');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('RECEIPT_EXPORT_URL must be an origin without path, query, fragment or credentials');
  }
  return new URL(IMPORT_PATH, url.origin);
}

export async function sendFixture({ baseUrl, token, fixturePath = DEFAULT_FIXTURE, fetchImpl = fetch }) {
  if (!token) throw new Error('RECEIPT_EXPORT_TOKEN is required');
  const body = await readFile(fixturePath, 'utf8');
  const payload = JSON.parse(body);
  if (payload?.schemaVersion !== 1 || !Array.isArray(payload.receipts)) {
    throw new Error('fixture must be a schemaVersion 1 payload with a receipts array');
  }
  const response = await fetchImpl(importUrl(baseUrl), {
    method: 'POST',
    redirect: 'manual',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body,
  });
  return { status: response.status, body: await response.text() };
}

async function main() {
  const fixturePath = process.argv[2] ?? DEFAULT_FIXTURE;
  const result = await sendFixture({
    baseUrl: process.env.RECEIPT_EXPORT_URL,
    token: process.env.RECEIPT_EXPORT_TOKEN,
    fixturePath,
  });
  // The token and request body are never printed.
  console.log(`HTTP ${result.status}`);
  if (result.body) console.log(result.body);
  if (result.status < 200 || result.status >= 300) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
