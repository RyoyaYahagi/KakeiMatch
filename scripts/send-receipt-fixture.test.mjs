import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DEFAULT_FIXTURE, importUrl, sendFixture } from './send-receipt-fixture.mjs';

test('posts the synthetic fixture to a local mock receiver and reports 200', async () => {
  const received = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accepted: JSON.parse(body).receipts.length }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const result = await sendFixture({ baseUrl: `http://127.0.0.1:${port}`, token: 'synthetic-token' });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { accepted: 2 });
    assert.equal(received.length, 1);
    const [request] = received;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/v1/receipts/import');
    assert.equal(request.headers.authorization, 'Bearer synthetic-token');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.body, await readFile(DEFAULT_FIXTURE, 'utf8'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('fixture follows the wire contract and contains no private fields', async () => {
  const payload = JSON.parse(await readFile(DEFAULT_FIXTURE, 'utf8'));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.source, 'kakeimatch-ios');
  assert.match(payload.sentAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const allowed = new Set(payload.filter.categoryIds);
  for (const receipt of payload.receipts) {
    for (const key of ['accountId', 'memo', 'image', 'aiSuggestion', 'excludedFromSpending']) assert.equal(key in receipt, false);
    for (const item of receipt.items) assert.equal(allowed.has(item.categoryId), true);
    const itemIds = new Set(receipt.items.map((item) => item.id));
    for (const adjustment of receipt.adjustments) {
      if ('targetItemId' in adjustment) assert.equal(itemIds.has(adjustment.targetItemId), true);
    }
    assert.equal(JSON.stringify(receipt).includes('null'), false);
  }
});

test('accepts https origins with a port and rejects unsafe endpoints', () => {
  assert.equal(importUrl('https://example-host:8443').href, 'https://example-host:8443/api/v1/receipts/import');
  assert.equal(importUrl('http://localhost:8080/').href, 'http://localhost:8080/api/v1/receipts/import');
  for (const invalid of ['http://example-host', 'https://example-host/api', 'https://example-host?x=1',
    'https://user:pass@example-host', 'example-host', '']) {
    assert.throws(() => importUrl(invalid));
  }
});

test('requires a token before reading or sending anything', async () => {
  let called = false;
  await assert.rejects(sendFixture({ baseUrl: 'https://example-host', token: '', fetchImpl: () => { called = true; } }), /TOKEN/);
  assert.equal(called, false);
});
