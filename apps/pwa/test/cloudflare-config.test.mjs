import assert from 'node:assert/strict';
import { test } from 'node:test';
import config from '../cloudflare.config.ts';

test('preview builds omit unsupported triggers even with the production mode', () => {
  for (const mode of [undefined, 'production', 'production-deploy']) {
    const { worker } = config({ mode, isPreview: true });
    assert.equal(worker.name, 'kakeimatch-issue-39-preview');
    assert.equal(Object.hasOwn(worker, 'triggers'), false);
  }
  assert.equal(Object.hasOwn(config({ mode: 'production', isPreview: false }).worker, 'triggers'), false);
});

test('explicit production builds retain the scheduled cleanup trigger', () => {
  const names = ['ACCOUNT_D1_ID', 'ACCOUNT_D1_NAME', 'TURNSTILE_SITE_KEY'];
  const saved = names.map(name => process.env[name]);
  try {
    for (const name of names) process.env[name] = `synthetic-${name}`;
    const { worker } = config({ mode: 'production-deploy', isPreview: false });
    assert.equal(worker.name, 'kakeimatch');
    assert.deepEqual(worker.triggers, [{ type: 'scheduled', schedule: '0 18 * * *' }]);
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  }
});
