import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'opencode-live-compaction.mjs');

test('opencode-live-compaction registers the compaction wiring on the shipped entry and exits 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, `status ${r.status}:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /opencode-live-compaction: PASS/);
});
