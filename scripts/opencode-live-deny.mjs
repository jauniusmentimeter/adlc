#!/usr/bin/env node
// opencode-live-deny.mjs — AC7: the LIVE deny proof for the ADLC OpenCode plugin.
//
// Drives a REAL OpenCode 2.x binary end-to-end, with the plugin installed from
// `npm pack` tarballs, and proves the enforcement contract the plugin relies
// on: a thrown error in the v2 `ctx.tool.hook('execute.before')` aborts the
// tool call. No real model is needed — a local mock OpenAI-compatible server
// plays the model and always asks for a `write` to a frozen-rail path.
//
// Two runs, both against the same temp project:
//   1. CONTROL   (enforcement off): the write MUST land. This proves the mock
//      provider + tool loop actually executes the write — without it, a broken
//      harness would make the treatment run pass hollowly. A probe plugin also
//      records whether the host dispatched `permission.evaluate` for that write
//      (the hook the plugin's permission lever registers on) — printed as
//      `permission.evaluate invoked: yes|no`, and required.
//   2. TREATMENT (ADLC_P4_ENFORCEMENT=1): the rail file MUST be unchanged AND
//      the tool result the model receives (captured by the mock server on the
//      follow-up request) MUST contain the rails-guard deny message. The probe
//      line is printed for this run too: it reads `no`, because the plugin's
//      execute.before deny aborts the call before the host's permission step.
//   3. PATCH control + treatment: the same pair with a `gpt-5*` model, which
//      OpenCode gives the `patch` tool (a patchText envelope) instead of
//      edit/write.
//
// Exit codes: 0 = pass, 1 = fail, 3 = skipped (no `opencode` binary and not
// --require). CI passes --require so a missing binary can never silently skip.

import { makeReporter, requireOpencodeV2 } from './opencode-live-harness.mjs';
import { runDenyProof } from './opencode-live-proofs.mjs';

const { log, fail } = makeReporter('opencode-live-deny');
log(`opencode ${requireOpencodeV2({ log, fail, require: process.argv.includes('--require') })}`);
await runDenyProof({ log, fail, keep: process.argv.includes('--keep') });
process.exit(); // reached only on success: fail() exits 1 itself
