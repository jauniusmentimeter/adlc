// opencode-live-harness.test.mjs — the packed-plugin install in the required
// live proofs must not run lifecycle scripts from the candidate checkout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKED_INSTALL_ARGS } from '../opencode-live-harness.mjs';

test('packed plugin install runs with --ignore-scripts', () => {
  assert.equal(PACKED_INSTALL_ARGS[0], 'install');
  assert.ok(PACKED_INSTALL_ARGS.includes('--ignore-scripts'));
});
