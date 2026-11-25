import assert from 'node:assert/strict';
import test from 'node:test';
import { skipRootChecks } from './select-ci-tests.mjs';

test('skips root and admin checks on iOS-only changes', () => {
  assert.equal(skipRootChecks(['apps/ios/project.yml', '.github/workflows/ios.yml', 'scripts/testflight.test.mjs']), true);
});

test('runs checks for mixed changes, CI changes, and missing diffs', () => {
  assert.equal(skipRootChecks(['apps/ios/project.yml', 'workers/ai-gateway/src/hosting.ts']), false);
  assert.equal(skipRootChecks(['.github/workflows/ci.yml']), false);
  assert.equal(skipRootChecks([]), false);
});
