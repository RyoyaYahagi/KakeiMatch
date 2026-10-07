import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserBundleSecrets } from '../tooling/browser-bundle-secrets.ts';

function check(code, env, environment = 'client') {
  const names = ['AI_EMERGENCY_STOP', 'BETTER_AUTH_SECRET', 'ACCOUNT_BOOTSTRAP_SECRET',
    'AI_GATEWAY_AUTH_SECRET', 'GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'GITHUB_ISSUES_TOKEN', 'TURNSTILE_SECRET_KEY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    // Isolate the check from developer and CI credentials.
    for (const name of names) delete process.env[name];
    Object.assign(process.env, env);
    browserBundleSecrets.generateBundle.call({
      environment: { name: environment },
      error(message) { throw new Error(message); },
    }, {}, { 'app.js': { type: 'chunk', code } });
  } finally {
    for (const name of names) delete process.env[name];
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}

test('ordinary emergency-stop values do not block browser builds', () => {
  for (const value of ['false', 'true', '0', '1']) {
    assert.doesNotThrow(() => check(`const setting = ${value};`, { AI_EMERGENCY_STOP: value }));
  }
});

test('provider and signing secrets still block browser builds, including short values', () => {
  for (const name of ['BETTER_AUTH_SECRET', 'ACCOUNT_BOOTSTRAP_SECRET', 'AI_GATEWAY_AUTH_SECRET',
    'GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'GITHUB_ISSUES_TOKEN', 'TURNSTILE_SECRET_KEY']) {
    for (const value of ['synthetic-private-value-for-test', 'short-key']) {
      assert.throws(() => check(`const leaked = "${value}";`, { [name]: value }),
        new RegExp(`Build secret ${name} reached browser chunk app.js`));
      assert.doesNotThrow(() => check('const ordinary = false;', { [name]: value }));
      assert.doesNotThrow(() => check(`const binding = "${value}";`, { [name]: value }, 'worker'));
    }
  }
});

test('Google API key-shaped values are detected without environment bindings', () => {
  assert.throws(() => check(`const leaked = "AIza${'X'.repeat(35)}";`, {}), /Google API key-shaped value/);
});
