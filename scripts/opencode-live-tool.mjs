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

import { makeReporter, requireOpencodeV2 } from './opencode-live-harness.mjs';
import { runToolProof } from './opencode-live-proofs.mjs';

const { log, fail } = makeReporter('opencode-live-tool');
log(`opencode ${requireOpencodeV2({ log, fail, require: process.argv.includes('--require') })}`);
await runToolProof({ log, fail, keep: process.argv.includes('--keep') });
// Reached only on success: fail() exits the process itself.
process.exit();
