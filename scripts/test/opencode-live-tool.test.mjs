// opencode-live-tool.test.mjs — the live proof's entry contract, which is
// host-independent: with no `opencode` on PATH it SKIPs (exit 3), and under
// --require a missing binary is FATAL (exit 1), never a silent skip. The body
// past that gate needs a real OpenCode 2.x and runs in CI's opencode-live jobs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'opencode-live-tool.mjs');

function run(args) {
  const emptyBin = mkdtempSync(join(tmpdir(), 'oc-live-tool-nopath-'));
  try {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PATH: emptyBin } });
  } finally {
    rmSync(emptyBin, { recursive: true, force: true });
  }
}

test('without an opencode binary the proof skips with exit 3', () => {
  const r = run([]);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /opencode-live-tool: SKIP — no `opencode` binary on PATH/);
});

test('--require turns a missing opencode binary into a failure (exit 1)', () => {
  const r = run(['--require']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /opencode-live-tool: FAIL — `opencode` binary not found but --require was set/);
});
