import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'opencode-live-prosecute.mjs');

test('opencode-live-prosecute executes deterministic P5 loop over write-disabled sessions and exits 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, `opencode-live-prosecute failed with status ${r.status}:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /PASS — deterministic P5 loop/);
});
