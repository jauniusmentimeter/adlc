#!/usr/bin/env node
// opencode-live-tool.mjs — LIVE proof for the native `adlc_gate` custom tool
// (Phase 4.2) on OpenCode 2.x. Drives a REAL `opencode` binary, with the plugin
// installed from `npm pack` tarballs, and a mock OpenAI-compatible provider,
// and proves the full path: the plugin's `ctx.tool.transform` adds adlc_gate →
// it is advertised to the model → the model calls it → execute() runs the
// LLM-backed gate keyless through `ctx.generate.text` → the verdict flows back
// to the model as the tool result.
//
// A fake `adlc` on PATH prints the gate's --prompt-only text carrying a marker;
// the mock answers the generate request carrying that marker with a canned
// verdict, so the verdict in the tool result proves the keyless round trip
// (not just that registration happened).
//
// Run with --require to make a missing binary fatal (CI); without it, a missing
// binary SKIPs (exit 3).

import { join } from 'node:path';
import {
  makeReporter, requireOpencodeV2, installPackedPlugin, startMockProvider,
  createProject, writeConfig, gitInit, runOpencode,
  assertPluginsLoaded, toolResponder, newToolSeen, writeAdlcShim, writeTicketFixture,
} from './opencode-live-harness.mjs';

const REQUIRE = process.argv.includes('--require');
const KEEP = process.argv.includes('--keep');
const KEYLESS_VERDICT = 'ADLC_KEYLESS_VERDICT_9C2E: spec is clear';
const GATE_PROMPT_MARKER = 'AUDIT_SPEC_PROMPT_5B1D';

const { log, fail } = makeReporter('opencode-live-tool');
log(`opencode ${requireOpencodeV2({ log, fail, require: REQUIRE })}`);

const seen = newToolSeen();
const { server, baseURL } = await startMockProvider(toolResponder({ marker: GATE_PROMPT_MARKER, verdict: KEYLESS_VERDICT }, seen));
log(`mock provider at ${baseURL}`);

const { work, project, home, cleanup } = createProject('oc-live-tool-');
try {
  const bin = join(work, 'bin');
  writeAdlcShim(bin, GATE_PROMPT_MARKER);

  // Enforcement ON with an active ticket + a real rail — proves adlc_gate is not
  // denied by the plugin's own execute.before rail guard.
  writeTicketFixture(project, { title: 'Live tool fixture', rails: ['locked/**'] });
  log('installing the packed plugin…');
  const pluginDir = installPackedPlugin(project, join(work, 'packs'));
  writeConfig(project, { baseURL, plugins: [pluginDir], permissions: [{ action: '*', resource: '*', effect: 'allow' }] });
  gitInit(project);

  log('running opencode: model calls adlc_gate(spec-lint) → keyless ctx.generate.text…');
  const r = await runOpencode({
    project, home, pathPrefix: bin,
    prompt: 'Run the spec-lint gate via adlc_gate',
    env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
  });
  assertPluginsLoaded(r, fail, 'run');
  const dump = `exit=${r.status} timedOut=${r.timedOut} after ${r.seconds}s\ntoolResults: ${JSON.stringify(seen.toolResults, null, 2)}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr.split('\n').slice(-80).join('\n')}`;

  if (!seen.advertisedAdlcGate) fail(`adlc_gate was not advertised to the model — ctx.tool.transform did not add it.\n${dump}`);
  log('✓ adlc_gate registered and advertised to the model (4.2)');
  if (!seen.advertisedAdlcProsecute) fail(`adlc_prosecute (T33) was not advertised alongside adlc_gate.\n${dump}`);
  log('✓ adlc_prosecute registered and advertised to the model (T33)');
  if (!seen.keylessAnswered) fail(`adlc_gate ran an LLM-backed gate but the gate prompt never reached the model through ctx.generate.text.\n${dump}`);
  log('✓ the keyless path sent the gate prompt to the model (ctx.generate.text)');
  if (!seen.toolResults.some((t) => t.includes(KEYLESS_VERDICT))) {
    fail(`the keyless request was answered, but its verdict never flowed back through adlc_gate to the model.\n${dump}`);
  }
  log('✓ the keyless verdict flowed back through adlc_gate to the model (4.1→4.2 wiring)');
  log('PASS — native adlc_gate tool + keyless bridge proven end-to-end');
} finally {
  server.close();
  if (KEEP) log(`--keep: ${work}`); else cleanup();
}
process.exit(); // reached only on success: fail() exits 1 itself
