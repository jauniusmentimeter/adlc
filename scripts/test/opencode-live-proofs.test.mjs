// opencode-live-proofs.test.mjs — the live proofs' own logic, driven against a
// FAKE OpenCode host: a proof must pass when the plugin enforces and fail,
// naming why, for each way the evidence can be missing. The real binary runs
// in CI's opencode-live jobs; this keeps the proofs from rotting into hollow
// ones (a proof that passes whatever the host did).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as realHarness from '../opencode-live-harness.mjs';
import { runDenyProof, runToolProof, KEYLESS_VERDICT, GATE_PROMPT_MARKER } from '../opencode-live-proofs.mjs';

const { MOCK_PATCH_MODEL, DENY_RAIL, DENY_RAIL_ORIGINAL, toolResultText } = realHarness;
const WRITE_DENY = 'ADLC rails-guard: blocked write — frozen rail "test/**"';
const PATCH_DENY = 'ADLC rails-guard: blocked patch — frozen rail "test/**"';
const toolsOf = (...names) => names.map((name) => ({ function: { name } }));
const callOf = (events) => events.map((e) => e.choices?.[0]?.delta?.tool_calls?.[0]?.function).find(Boolean);
const textOf = (events) => events.map((e) => e.choices?.[0]?.delta?.content ?? '').join('');

/** A fake host: real fixtures and responders, a scripted stand-in for `opencode run`. */
function fakeHost(behavior = {}) {
  const b = { enforce: true, executes: true, dispatches: true, denyMessage: true, patchDenyMessage: true, patchApplies: true, ...behavior };
  const calls = { runs: [], configs: [], closed: 0, installs: [], loaded: [], projects: [] };
  let respond;
  const probe = [];
  const h = {
    ...realHarness,
    startMockProvider: async (r) => { respond = r; return { server: { close: () => { calls.closed += 1; } }, baseURL: 'http://127.0.0.1:1/v1' }; },
    createProject: (prefix) => { const p = realHarness.createProject(prefix); calls.projects.push(p); return p; },
    installPackedPlugin: (project, packDir) => { calls.installs.push({ project, packDir }); return '/fake/plugin'; },
    writePermissionProbe: (dir, logFile) => { calls.probeFile = logFile; return `${dir}-probe`; },
    readProbe: () => probe,
    writeConfig: (project, cfg) => { calls.configs.push(cfg); },
    gitInit: () => {},
    assertPluginsLoaded: (run, fail, label) => { calls.loaded.push(label); },
    runOpencode: async (opts) => {
      calls.runs.push(opts);
      if (opts.prompt.includes('spec-lint')) return runToolConversation(opts);
      return runDenyConversation(opts);
    },
  };
  function runDenyConversation({ project, env, model }) {
    const patching = model === MOCK_PATCH_MODEL;
    const tools = patching ? toolsOf('patch', 'write') : toolsOf('write', 'edit');
    const call = callOf(respond({ messages: [], tools }));
    const enforced = env.ADLC_P4_ENFORCEMENT === '1' && b.enforce;
    const target = join(project, DENY_RAIL);
    if (!enforced && b.executes && (!patching || b.patchApplies)) writeFileSync(target, 'export const frozen = false;\n');
    if (!enforced && b.dispatches) probe.push({ action: 'edit', resources: [DENY_RAIL] });
    const content = enforced && b.denyMessage && (!patching || b.patchDenyMessage) ? JSON.stringify({ error: { message: patching ? PATCH_DENY : WRITE_DENY } }) : 'ok';
    respond({ messages: [{ role: 'tool', content }], tools });
    assert.ok(call, 'the mock model asked for a tool call');
    return { status: 0, timedOut: false, seconds: 0, stdout: '', stderr: '' };
  }
  function runToolConversation() {
    const tools = toolsOf('adlc_gate', ...(b.prosecute === false ? [] : ['adlc_prosecute']));
    if (b.gate === false) tools.shift();
    respond({ messages: [], tools });
    let verdict = '';
    if (b.keyless !== false) verdict = textOf(respond({ messages: [{ role: 'user', content: `Audit. ${GATE_PROMPT_MARKER}` }], tools: [] }));
    respond({ messages: [{ role: 'tool', content: b.flows === false ? 'nothing' : verdict }], tools });
    return { status: 0, timedOut: false, seconds: 0, stdout: '', stderr: '' };
  }
  return { h, calls, probe };
}

const harnessOf = (behavior) => { const fx = fakeHost(behavior); const logs = []; return { ...fx, logs, opts: { h: fx.h, log: (m) => logs.push(m), fail: (m) => { throw new Error(m); } } }; };
const rejects = (promise, re) => assert.rejects(promise, (e) => re.test(e.message));

test('deny proof passes when the plugin blocks the write and the patch, and cleans up', async () => {
  const { opts, logs, calls } = harnessOf();
  await runDenyProof(opts);
  assert.ok(logs.includes('PASS — live deny proof holds (AC7)'), logs.join('\n'));
  assert.equal(calls.closed, 1, 'the mock provider is closed');
  assert.equal(existsSync(calls.projects[0].work), false, 'the temp project is removed');
  assert.deepEqual(calls.loaded, ['control', 'treatment', 'patch control', 'patch treatment']);
  assert.ok(logs.includes('treatment: permission.evaluate invoked: no (execute.before denies first)'), 'the execute.before deny precedes the permission step');
  assert.ok(logs.includes('control: permission.evaluate invoked: yes'));
});

test('deny proof drives opencode with the packed plugin, the probe, and a prompt naming the rail', async () => {
  const { opts, calls } = harnessOf();
  await runDenyProof(opts);
  assert.equal(calls.installs[0].packDir, join(calls.projects[0].work, 'packs'));
  assert.deepEqual(calls.configs[0].plugins, [`${join(calls.projects[0].work, 'probe')}-probe`, '/fake/plugin']);
  assert.equal(calls.probeFile, join(calls.projects[0].work, 'permission-probe.jsonl'));
  assert.deepEqual(calls.configs[0].permissions, [{ action: '*', resource: '*', effect: 'allow' }]);
  assert.deepEqual(calls.runs.map((r) => [r.env.ADLC_P4_ENFORCEMENT, r.model ?? null]), [['0', null], ['1', null], ['0', MOCK_PATCH_MODEL], ['1', MOCK_PATCH_MODEL]]);
  assert.ok(calls.runs.every((r) => r.prompt === `Overwrite ${DENY_RAIL} please`));
});

test('deny proof fails when the treatment write lands on the frozen rail', async () => {
  await rejects(runDenyProof(harnessOf({ enforce: false }).opts), /TREATMENT run WROTE to the frozen rail/);
});

test('deny proof fails when the control never executes the write (a hollow harness)', async () => {
  await rejects(runDenyProof(harnessOf({ executes: false }).opts), /CONTROL run did not write the file/);
});

test('deny proof fails when the host never dispatches permission.evaluate', async () => {
  await rejects(runDenyProof(harnessOf({ dispatches: false }).opts), /never dispatched permission\.evaluate/);
});

test('deny proof fails when the block cannot be attributed to the plugin', async () => {
  await rejects(runDenyProof(harnessOf({ denyMessage: false }).opts), /deny naming the rail never reached the model/);
});

test('deny proof fails when the patch control does not apply', async () => {
  await rejects(runDenyProof(harnessOf({ patchApplies: false }).opts), /PATCH CONTROL run did not apply the patch/);
});

test('deny proof fails when the patch treatment modifies the frozen rail', async () => {
  const { opts, h } = harnessOf();
  const run = h.runOpencode;
  h.runOpencode = async (o) => { const r = await run(o); if (o.model === MOCK_PATCH_MODEL && o.env.ADLC_P4_ENFORCEMENT === '1') writeFileSync(join(o.project, DENY_RAIL), 'tampered\n'); return r; };
  await rejects(runDenyProof(opts), /PATCH TREATMENT run modified the frozen rail/);
});

test('deny proof fails when only the patch deny never reaches the model', async () => {
  await rejects(runDenyProof(harnessOf({ patchDenyMessage: false }).opts), /patch deny never reached the model/);
});

test('deny proof --keep leaves the project and says where', async () => {
  const { opts, logs, calls } = harnessOf();
  await runDenyProof({ ...opts, keep: true });
  const { work } = calls.projects[0];
  try {
    assert.ok(existsSync(work), 'the project is retained');
    assert.ok(logs.includes(`--keep: temp project retained at ${work}`));
  } finally { calls.projects[0].cleanup(); }
});

test('deny proof restores the rail between runs so each run starts from the committed content', async () => {
  const { opts, calls, h } = harnessOf();
  const seenStart = [];
  const realRun = h.runOpencode;
  h.runOpencode = async (o) => { seenStart.push(readFileSync(join(o.project, DENY_RAIL), 'utf8')); return realRun(o); };
  await runDenyProof(opts);
  assert.deepEqual(seenStart, [DENY_RAIL_ORIGINAL, DENY_RAIL_ORIGINAL, DENY_RAIL_ORIGINAL, DENY_RAIL_ORIGINAL]);
  assert.equal(calls.runs.length, 4);
});

test('tool proof passes when the tools are advertised and the keyless verdict round-trips', async () => {
  const { opts, logs, calls } = harnessOf();
  await runToolProof(opts);
  assert.ok(logs.includes('PASS — native adlc_gate tool + keyless bridge proven end-to-end'), logs.join('\n'));
  assert.equal(calls.closed, 1);
  assert.equal(existsSync(calls.projects[0].work), false);
  assert.deepEqual(calls.loaded, ['run']);
});

test('tool proof runs opencode with the fake adlc on PATH, enforcement on and T1 active', async () => {
  const { opts, calls } = harnessOf();
  let shim;
  const realRun = opts.h.runOpencode;
  opts.h.runOpencode = async (o) => { shim = readFileSync(join(o.pathPrefix, 'adlc'), 'utf8'); return realRun(o); };
  await runToolProof(opts);
  const [run] = calls.runs;
  assert.equal(run.pathPrefix, join(calls.projects[0].work, 'bin'));
  assert.deepEqual(run.env, { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' });
  assert.match(shim, new RegExp(GATE_PROMPT_MARKER));
  assert.deepEqual(calls.configs[0].plugins, ['/fake/plugin']);
  assert.equal(calls.installs[0].packDir, join(calls.projects[0].work, 'packs'));
});

test('tool proof fails, naming the missing evidence', async () => {
  await rejects(runToolProof(harnessOf({ gate: false }).opts), /adlc_gate was not advertised/);
  await rejects(runToolProof(harnessOf({ prosecute: false }).opts), /adlc_prosecute \(T33\) was not advertised/);
  await rejects(runToolProof(harnessOf({ keyless: false }).opts), /gate prompt never reached the model/);
  await rejects(runToolProof(harnessOf({ flows: false }).opts), /verdict never flowed back through adlc_gate/);
});

test('the verdict constant is what the responder answers the keyless prompt with', () => {
  assert.equal(toolResultText({ content: KEYLESS_VERDICT }), KEYLESS_VERDICT);
});
