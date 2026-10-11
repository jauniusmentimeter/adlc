// opencode-live-harness.test.mjs — the packed-plugin pack + install in the
// required live proofs must not run lifecycle scripts from the candidate checkout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKED_INSTALL_ARGS, packArgs } from '../opencode-live-harness.mjs';

test('packed plugin install runs with --ignore-scripts', () => {
  assert.equal(PACKED_INSTALL_ARGS[0], 'install');
  assert.ok(PACKED_INSTALL_ARGS.includes('--ignore-scripts'));
});

test('npm pack runs with --ignore-scripts (prepack/prepare/postpack are lifecycle hooks too)', () => {
  const args = packArgs('/repo/plugins/x', '/tmp/packs');
  assert.equal(args[0], 'pack');
  assert.ok(args.includes('--ignore-scripts'));
  assert.ok(args.includes('/repo/plugins/x'));
  assert.equal(args[args.indexOf('--pack-destination') + 1], '/tmp/packs');
});
