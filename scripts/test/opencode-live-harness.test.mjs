// opencode-live-harness.test.mjs — the packed-plugin pack + install in the
// required live proofs must not run lifecycle scripts from the candidate checkout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PACKED_INSTALL_ARGS, packArgs, REPO, PLUGIN_PKG, MOCK_MODEL, MOCK_PATCH_MODEL, DENY_RAIL, DENY_RAIL_ORIGINAL,
  dependencyClosure, writeConfig, denyPatchText, denyResponder, toolResponder, reply, toolNames,
} from '../opencode-live-harness.mjs';
import { railHit } from '../../plugins/adlc-opencode/rails-checker.mjs';

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

const chunks = (events) => events.map((e) => e.choices?.[0]?.delta).filter(Boolean);
const toolCallOf = (events) => chunks(events).find((d) => d.tool_calls)?.tool_calls[0].function;
const textOf = (events) => chunks(events).map((d) => d.content ?? '').join('');
const toolsOf = (...names) => names.map((name) => ({ function: { name } }));

test('REPO is this checkout and PLUGIN_PKG names the package the proofs install from it', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'plugins', 'adlc-opencode', 'package.json'), 'utf8'));
  assert.equal(pkg.name, PLUGIN_PKG);
  assert.equal(dependencyClosure().get(PLUGIN_PKG), join(REPO, 'plugins', 'adlc-opencode'));
});

test('the mock model resolves to a provider and model that writeConfig defines', () => {
  const project = mkdtempSync(join(tmpdir(), 'oc-harness-cfg-'));
  try {
    writeConfig(project, { baseURL: 'http://127.0.0.1:1/v1', plugins: [] });
    const cfg = JSON.parse(readFileSync(join(project, 'opencode.json'), 'utf8'));
    for (const ref of [MOCK_MODEL, MOCK_PATCH_MODEL]) {
      const [provider, model] = ref.split('/');
      assert.ok(cfg.providers[provider]?.models[model], `${ref} is defined by the generated config`);
    }
    assert.equal(cfg.model, MOCK_MODEL);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('the deny proof targets a path the fixture ticket really freezes', () => {
  assert.ok(railHit(DENY_RAIL, ['test/**'], REPO), `${DENY_RAIL} is under the test/** rail`);
});

test('denyPatchText turns the rail\'s committed line into the opposite one', () => {
  const patch = denyPatchText();
  assert.ok(patch.includes(`*** Update File: ${DENY_RAIL}\n`));
  assert.ok(patch.includes(`\n-${DENY_RAIL_ORIGINAL.trimEnd()}\n+export const frozen = false;\n`));
});

test('denyResponder: utility calls get a title, the first tool call mutates the rail, a result ends the turn', () => {
  const sink = [];
  const respond = denyResponder(sink);
  assert.equal(textOf(respond({ messages: [], tools: [] })), 'live deny proof');
  const viaWrite = toolCallOf(respond({ messages: [], tools: toolsOf('write', 'edit') }));
  assert.equal(viaWrite.name, 'write');
  assert.equal(JSON.parse(viaWrite.arguments).path, DENY_RAIL);
  const viaPatch = toolCallOf(respond({ messages: [], tools: toolsOf('write', 'patch') }));
  assert.equal(viaPatch.name, 'patch');
  assert.equal(JSON.parse(viaPatch.arguments).patchText, denyPatchText());
  const done = respond({ messages: [{ role: 'tool', content: 'blocked: frozen rail' }], tools: toolsOf('write') });
  assert.equal(textOf(done), 'done');
  assert.deepEqual(sink, ['blocked: frozen rail']);
});

test('toolResponder: records what was advertised, answers the keyless prompt, then drives adlc_gate', () => {
  const seen = { advertisedAdlcGate: false, advertisedAdlcProsecute: false, keylessAnswered: false, toolResults: [] };
  const respond = toolResponder({ marker: 'MARK', verdict: 'VERDICT' }, seen);
  assert.equal(textOf(respond({ messages: [{ role: 'user', content: 'hi' }], tools: [] })), 'ok');
  assert.deepEqual([seen.advertisedAdlcGate, seen.advertisedAdlcProsecute, seen.keylessAnswered], [false, false, false]);
  const first = toolCallOf(respond({ messages: [], tools: toolsOf('adlc_gate') }));
  assert.equal(first.name, 'adlc_gate');
  assert.deepEqual(JSON.parse(first.arguments), { gate: 'spec-lint' });
  assert.equal(seen.advertisedAdlcGate, true);
  assert.equal(seen.advertisedAdlcProsecute, false);
  respond({ messages: [], tools: toolsOf('adlc_prosecute') });
  assert.equal(seen.advertisedAdlcProsecute, true);
  assert.equal(textOf(respond({ messages: [{ role: 'user', content: 'text with MARK inside' }], tools: [] })), 'VERDICT');
  assert.equal(seen.keylessAnswered, true);
  assert.equal(textOf(respond({ messages: [{ role: 'tool', content: 'gate said X' }], tools: toolsOf('adlc_gate') })), 'done');
  assert.deepEqual(seen.toolResults, ['gate said X']);
});

test('reply and toolNames are exercised by the responders above', () => {
  assert.deepEqual(toolNames(toolsOf('a', 'b')), ['a', 'b']);
  assert.equal(textOf(reply.text('x')), 'x');
});
