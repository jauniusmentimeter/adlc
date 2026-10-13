// opencode-live-proofs.mjs — the live OpenCode proofs as functions, so the
// harness logic (what each run must show, and what fails the proof) is
// testable without an OpenCode 2 binary. `h` is the harness the proof drives;
// tests hand it a fake host. `fail` must not return (the scripts exit 1; tests
// throw).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as harness from './opencode-live-harness.mjs';

const { MOCK_PATCH_MODEL, DENY_RAIL: RAIL, DENY_RAIL_ORIGINAL: RAIL_ORIGINAL } = harness;

export const KEYLESS_VERDICT = 'ADLC_KEYLESS_VERDICT_9C2E: spec is clear';
export const GATE_PROMPT_MARKER = 'AUDIT_SPEC_PROMPT_5B1D';

/** AC7 — the rails-guard deny aborts a write and a patch, with an enforcement-off control for each. */
export async function runDenyProof({ log, fail, keep = false, h = harness }) {
  let toolResults = [];
  const { server, baseURL } = await h.startMockProvider(({ messages, tools }) => h.denyResponder(toolResults)({ messages, tools }));
  log(`mock provider at ${baseURL}`);

  const { work, project, home, cleanup } = h.createProject('oc-live-deny-');
  try {
    h.writeDenyFixture(project);
    log('installing the packed plugin…');
    const pluginDir = h.installPackedPlugin(project, join(work, 'packs'));
    const probeLog = join(work, 'permission-probe.jsonl');
    const probeDir = h.writePermissionProbe(join(work, 'probe'), probeLog);
    h.writeConfig(project, {
      baseURL,
      plugins: [probeDir, pluginDir],
      permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    });
    h.gitInit(project);

    const run = async (env, model) => { toolResults = []; const r = await h.runOpencode({ project, home, prompt: `Overwrite ${RAIL} please`, env, model }); return { ...r, toolResults: [...toolResults] }; };
    const evaluated = () => h.readProbe(probeLog).filter((d) => d.action === 'edit' && Array.isArray(d.resources) && d.resources.includes(RAIL));
    const dump = (r) => `exit=${r.status} timedOut=${r.timedOut} after ${r.seconds}s\ntool results: ${JSON.stringify(r.toolResults, null, 2)}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr.split('\n').slice(-80).join('\n')}`;

    // ---- run 1: CONTROL (enforcement off) — the write must actually land ----
    log('control run (enforcement off)…');
    const control = await run({ ADLC_P4_ENFORCEMENT: '0' });
    h.assertPluginsLoaded(control, fail, 'control');
    if (readFileSync(join(project, RAIL), 'utf8') === RAIL_ORIGINAL) {
      fail(`CONTROL run did not write the file — the harness never executed the write, so the deny proof would be hollow.\n${dump(control)}`);
    }
    log('control: write landed (harness genuinely executes the tool)');
    const dispatched = evaluated();
    log(`control: permission.evaluate invoked: ${dispatched.length > 0 ? 'yes' : 'no'}`);
    if (dispatched.length === 0) {
      fail(`the host never dispatched permission.evaluate (action "edit", resources [${RAIL}]) for the control write — the plugin's permission lever has nothing to bind to.\nprobe: ${JSON.stringify(h.readProbe(probeLog))}`);
    }

    writeFileSync(join(project, RAIL), RAIL_ORIGINAL);

    // ---- run 2: TREATMENT (enforcement on) — the write must be BLOCKED ----
    log('treatment run (ADLC_P4_ENFORCEMENT=1)…');
    const treatment = await run({ ADLC_P4_ENFORCEMENT: '1' });
    h.assertPluginsLoaded(treatment, fail, 'treatment');
    if (readFileSync(join(project, RAIL), 'utf8') !== RAIL_ORIGINAL) {
      fail(`TREATMENT run WROTE to the frozen rail — the execute.before throw did NOT abort the tool.\n${dump(treatment)}`);
    }
    const DENY = 'ADLC rails-guard: blocked write — frozen rail "test/**"';
    if (!treatment.toolResults.some((t) => t.includes(DENY))) {
      fail(`rail file unchanged but the rails-guard deny naming the rail never reached the model — cannot attribute the block to the plugin.\n${dump(treatment)}`);
    }
    log('treatment: write blocked AND the deny reason reached the model');
    log(`treatment: permission.evaluate invoked: ${evaluated().length > dispatched.length ? 'yes' : 'no'} (execute.before denies first)`);

    // ---- run 3: PATCH control + treatment ----
    writeFileSync(join(project, RAIL), RAIL_ORIGINAL);
    log('patch control run (enforcement off)…');
    const patchControl = await run({ ADLC_P4_ENFORCEMENT: '0' }, MOCK_PATCH_MODEL);
    h.assertPluginsLoaded(patchControl, fail, 'patch control');
    if (readFileSync(join(project, RAIL), 'utf8') === RAIL_ORIGINAL) {
      fail(`PATCH CONTROL run did not apply the patch — the patch deny proof would be hollow.\n${dump(patchControl)}`);
    }
    log('patch control: patch applied');
    writeFileSync(join(project, RAIL), RAIL_ORIGINAL);
    log('patch treatment run (ADLC_P4_ENFORCEMENT=1)…');
    const patchTreatment = await run({ ADLC_P4_ENFORCEMENT: '1' }, MOCK_PATCH_MODEL);
    h.assertPluginsLoaded(patchTreatment, fail, 'patch treatment');
    if (readFileSync(join(project, RAIL), 'utf8') !== RAIL_ORIGINAL) {
      fail(`PATCH TREATMENT run modified the frozen rail.\n${dump(patchTreatment)}`);
    }
    if (!patchTreatment.toolResults.some((t) => t.includes('ADLC rails-guard: blocked patch — frozen rail "test/**"'))) {
      fail(`rail unchanged but the rails-guard patch deny never reached the model.\n${dump(patchTreatment)}`);
    }
    log('patch treatment: patch blocked AND the deny reason reached the model');
    log('PASS — live deny proof holds (AC7)');
  } finally {
    server.close();
    if (keep) log(`--keep: temp project retained at ${work}`);
    else cleanup();
  }
}

/** adlc_gate + adlc_prosecute are advertised and the keyless gate round-trips through the host model. */
export async function runToolProof({ log, fail, keep = false, h = harness }) {
  const seen = h.newToolSeen();
  const { server, baseURL } = await h.startMockProvider(h.toolResponder({ marker: GATE_PROMPT_MARKER, verdict: KEYLESS_VERDICT }, seen));
  log(`mock provider at ${baseURL}`);

  const { work, project, home, cleanup } = h.createProject('oc-live-tool-');
  try {
    const bin = join(work, 'bin');
    h.writeAdlcShim(bin, GATE_PROMPT_MARKER);

    // Enforcement ON with an active ticket + a real rail — proves adlc_gate is not
    // denied by the plugin's own execute.before rail guard.
    h.writeTicketFixture(project, { title: 'Live tool fixture', rails: ['locked/**'] });
    log('installing the packed plugin…');
    const pluginDir = h.installPackedPlugin(project, join(work, 'packs'));
    h.writeConfig(project, { baseURL, plugins: [pluginDir], permissions: [{ action: '*', resource: '*', effect: 'allow' }] });
    h.gitInit(project);

    log('running opencode: model calls adlc_gate(spec-lint) → keyless ctx.generate.text…');
    const r = await h.runOpencode({
      project, home, pathPrefix: bin,
      prompt: 'Run the spec-lint gate via adlc_gate',
      env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
    });
    h.assertPluginsLoaded(r, fail, 'run');
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
    if (keep) log(`--keep: ${work}`); else cleanup();
  }
}
