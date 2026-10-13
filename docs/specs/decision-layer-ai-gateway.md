# Spec — decision layer: `ai-gateway` provider over Vercel AI Gateway's Decisions API

**Status:** Approved by Rafael Belliard, 2026-10-11 (P1: one interrogation
round, three premortem rounds)
**Date:** 2026-10-11
**Issue:** [#1210](https://github.com/voodootikigod/adlc/issues/1210)
**Tier:** architectural
**Extends:** [`decision-layer-shadow.md`](./decision-layer-shadow.md). Every rule
there still holds unless this spec names it. Shadow mode only.

## Summary

Add `--provider ai-gateway` to `@adlc/decision-layer`. It asks a decision model
on Vercel AI Gateway through the gateway's OpenAI-compatible Decisions API, with
the key in `AI_GATEWAY_API_KEY`. A developer who has a gateway key but no
TypeSafe key can then run `adlc decision evaluate --mode shadow`.

Nothing changes for a project that does not select the new provider, except
one thing that `jev` and `mock` also see: a model ID, in `--model` and in a
reply, may now carry one `/` (see "Interface").

## Goals

1. A third provider, `ai-gateway`, that reaches every decision model on the
   gateway (for example `typesafe-ai/jev` and `openai/gpt-6-luna-decisions`)
   through `POST https://ai-gateway.vercel.sh/v1/decisions`.
2. No request-level fallback can put another model's probability in a
   record. Three rules make this hold:
   - The gateway refuses a language model on this endpoint (400).
   - The request never sends `providerOptions`. The gateway's decision
     fallbacks are opt-in per request through
     `providerOptions.gateway.models` (Vercel docs, "Decision Fallbacks").
   - A reply whose `model` is not the requested slug is `model-mismatch`.
     The reply's `model` names the model that produced the answers.

   This covers fallbacks a request can ask for. It does not cover the
   gateway re-pointing an alias to a new release, or account-level routing
   rules: the reply's `model` stays the same in both cases, and the record
   names only the alias.
3. The adapter is built against a committed live capture, made before any
   adapter code exists (shadow spec decision 9).
4. The HTTP code that `jev` and `ai-gateway` share lives in one module, not in
   two copies (CONVENTIONS rule 2). `jev`'s requests, replies, failure classes
   and messages do not change.

## Non-goals

- An endpoint override for `ai-gateway`. The key only goes to the fixed URL.
- `Score` questions on `ai-gateway`. The gateway scores over 2-10 labelled
  levels, a pack's `Score` domain is a numeric range, and no capture exists.
- An OpenRouter provider (no key for the live capture decision 9 requires).
- Documenting `jev` pointed at the gateway's `/typesafe/v1/systemone` endpoint.
- New defaults: shadow mode still needs `--provider`, `--model` and `--pack`.
- Any change to the reducer, packs, sanitizer, run record fields, timeout, or
  the jev key and endpoint rules.
- A scheduled live check after merge. Who re-runs criterion 9, and how often,
  is the maintainer's decision (#1210).
- Enforce mode, `CHANGELOG.md`, `packages/cli`, and `.adlc/` (the maintainer
  records ADLC evidence; see #1210).

## Interface

```
adlc decision evaluate --mode shadow --provider <ai-gateway|jev|mock> --model <id> \
  --pack <pack-id> [--revision <rev>] [--ticket <id>] [--pr <number>] \
  [--mock-response <file>] [--json]
```

- `--provider ai-gateway` reads its key from `AI_GATEWAY_API_KEY` only. No
  other variable is read for it, and no variable can change its endpoint.
- `--model` is a gateway decision-model slug, `vendor/model`. The gateway lists
  only alias slugs (for example `typesafe-ai/jev`, with no release number), so
  an `ai-gateway` record names the model, not its release.
- `MODEL_PATTERN` becomes
  `/^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)?$/`:
  zero or one `/`, never leading or trailing, the same 128-character total cap
  and the same characters as today. Every ID valid today stays valid.
- `MODEL_PATTERN` checks `--model` for every provider, so `--provider jev` or
  `--provider mock` also accepts an ID with one `/` (for example
  `typesafe-ai/jev`). For `jev` that ID goes to TypeSafe as it is, and TypeSafe
  answers or rejects it.
- `MODEL_PATTERN` also checks the reply's model in `lib/provider.mjs`
  (`validModel`), for every provider. So a `jev` or `mock` reply that names a
  model with one `/` stops being `malformed-response`.
- These two are the only changes `jev` and `mock` see, and tests cover both.
- `isPinnedModel` does not change.
- The run record keeps its fields: `provider` is `ai-gateway`, `requestedModel`
  is the `--model` value, `resolvedModel` is the model the reply names.

Configuration errors exit 1 before anything is sent, and write no record. The
key errors are found before the pack is read. The pack errors are found after
the pack and ticket facts are read (`lib/evaluate.mjs`). Exact text:

| Case | Message |
| --- | --- |
| No key | `--provider ai-gateway needs AI_GATEWAY_API_KEY in the environment` |
| Key with characters a header cannot carry | `the AI Gateway API key holds whitespace or other characters a header cannot carry` |
| A `Score` question, or a `Choice` question with more than 255 labels | `--provider ai-gateway cannot ask pack <id>: it supports only Choice and Noul questions, and at most 255 choices` |
| Questions that declare different inputs | `--provider ai-gateway cannot ask pack <id>: every question must declare the same inputs` |
| Unknown provider | `unknown --provider "<value>": expected mock or jev or ai-gateway` |
| `--mock-response` with `ai-gateway` | `--mock-response is valid only with --provider mock` (unchanged) |
| Bad model ID | `--model "<value>" must match <MODEL_PATTERN>` (unchanged form) |

The jev messages do not change.

## Adapter contract

### Request

One run is one call (plus the retries below). The body is:

```json
{
  "model": "<--model>",
  "input": "<canonical JSON text of the one input every question shares>",
  "questions": [
    { "type": "choice", "name": "<question id>", "instructions": "<prompt>", "choices": [{ "value": "<label>" }] },
    { "type": "predicate", "name": "<question id>", "instructions": "<prompt>" }
  ]
}
```

- `input` is `canonicalJson` (`lib/canonical.mjs`) of the sanitized input.
- Questions keep pack order. `Choice` labels keep domain order.
- `Noul` is a `predicate`. `Score`, and a `Choice` over more than 255 labels
  (the gateway accepts 1 to 255), are refused before dispatch.
- No other key is sent. In particular no `providerOptions`.
- Headers: `Authorization: Bearer <key>`, `Content-Type: application/json`.
  `redirect: 'manual'`. The key is never in the body.
- The size bounds (4 KiB per field, 32 KiB in total) apply to the neutral
  request, as for `jev`. The escaped `input` string is not bounded again. A
  body the gateway refuses for its size is `http-<status>`, so `error`.

### Reply

- Answers match questions by `name`. Exactly one answer per question; a
  missing, duplicate, extra or unnamed answer is `malformed-response`. An
  answer whose type does not fit its question (a `predicate` for a `Choice`
  question, or the reverse) is `malformed-response`.
- `choice`: the value is `choice`. The probability is the `probability` of the
  first `probabilities[]` entry whose `value` equals `choice`. With no such
  entry, or with `probabilities` not an array, the answer has no probability.
  `confidence` passes through. A probability or confidence that is not a
  number in [0, 1] is `malformed-response`. A non-string `choice` is
  `malformed-response`. A choice outside the domain is `out-of-domain`.
- `predicate`: with p = `probability`, the answer is `yes` with probability p
  when p >= 0.5, else `no` with probability 1 - p rounded to 6 decimals. A tie
  is `yes`, so a coin flip escalates. This is jev's `Noul` rule, with the same
  error classes:
  - An absent `probability` is `out-of-domain`.
  - A present non-number (string, `null`, boolean) is `malformed-response`.
  - A number outside [0, 1] is `malformed-response`.
- Any other answer type, including `refusal` and `score`, is
  `malformed-response`. A refusal is folded into that class on purpose: one
  unanswered question leaves the reducer nothing to act on, and the shadow
  spec's error classes stay as they are. The README names refusal as one cause
  of `malformed-response`.
- `model` is the resolved model. A reply without a string `model` that
  matches `MODEL_PATTERN` is `malformed-response`. A reply whose `model` is not
  exactly the requested slug is `model-mismatch`, for alias and pinned
  requests alike. This is stricter than `jev`, where only a pinned request can
  mismatch, because the gateway names the model that produced the answers.
  The provider object declares `exactModel: true`, and `checkResolvedModel` in
  `lib/provider.mjs` applies the strict rule only for such a provider, so
  `jev` and `mock` keep the pinned-only rule. The mismatch goes through the
  `UnusableReply` path, so the record is `status: error`,
  `errorClass: model-mismatch`, and `resolvedModel` is the model the reply
  names. It is never a `rejected` outcome, which would record
  `resolvedModel: null`. For an `exactModel` provider, `evaluateDecision`
  compares the reported model (a valid `model` string in the reply) with the
  request **before** `normalizeReply`, so a reply from another model is
  `model-mismatch` even when its answers are also unusable. For `jev` and
  `mock` the order does not change.
- `usage`: the adapter copies only `input_tokens`, `output_tokens` and
  `total_tokens`, as `inputTokens`, `outputTokens` and `totalTokens`, and drops
  every other key (including nested detail objects) before the shared
  validation sees it, as `jev` does. `null` or absent usage means no usage. A
  copied counter that is not a non-negative integer (including `null`) is
  `malformed-response`, from the shared validation. Any other non-object
  `usage` is `malformed-response`.
- `provider_metadata` and every other key are dropped.

### Failures

The same classes as `jev`, from the shared module:

| Outcome | Class | Status | Retried |
| --- | --- | --- | --- |
| No response (network error) | `network` | `unknown` | yes, up to `MAX_RETRIES` (2) |
| 429 or 529 | `rate-limit` | `unknown` | yes, up to 2 |
| Timeout (`DEFAULT_TIMEOUT_MS`, 10 s, unchanged) | `timeout` | `unknown` | no |
| Any other 5xx | `server-error` | `unknown` | no |
| 2xx body that breaks off mid-read | `interrupted-response` | `unknown` | no |
| Any other non-2xx (401 bad key, 400 language model, 404 unknown model, real 3xx) | `http-<status>` | `error` | no |
| Opaque redirect | `http-redirect` | `error` | no; `Location` is never fetched |
| Body over 64 KiB (declared or read) | `response-too-large` | `error` | no |
| Body that is not JSON, or empty | `malformed-response` | `error` | no |

The 10 s timeout stays: the prototype's ok calls on 2026-10-11 took 336-426 ms.
The adapter test asserts that each captured ok latency is under half of
`DEFAULT_TIMEOUT_MS`.

## Shared module

`lib/adapters/common.mjs` holds what both remote adapters need. It moves out of
`lib/adapters/jev.mjs` without behaviour change:

- `MAX_RESPONSE_BYTES`, `readBounded`, and the bounded POST with its failure
  classes. Each adapter passes its own reply translation.
- `API_KEY_PATTERN` and a key check that takes the provider's label, so each
  provider keeps its own message.
- The one-call-per-run pack rule, the shared-input rule, and the `Noul`
  mapping with its rounding. `ai-gateway` adds its 255-choice limit on top.

`assertSafeApiUrl` and its "the Jev API URL" messages stay in `jev.mjs`, because
`lib/config.mjs` rewrites that text for `TYPESAFE_API_URL`. `jev.mjs` keeps every
export it has today (some become re-exports), so no jev test changes.
`lib/adapters/ai-gateway.mjs` holds only the Decisions request and reply
translation. Every `lib` file stays under 400 lines, the package keeps zero
runtime dependencies, and `enforce` keeps its one occurrence in
`lib/config.mjs`.

The mutation gate sees moved lines as changed lines. The existing jev tests
must kill the mutants it samples there.

## Live capture

A prerequisite of the adapter, made first and committed alone.

- A standalone script, not committed, builds each request **by hand** from
  `packs/change-risk-v1/pack.json` and a fixed synthetic input (made-up counts,
  not taken from a real repository or ticket), using `lib/canonical.mjs` only.
  It imports no adapter code. The PR description includes the script.
- Cases:
  - `ok-jev` (`typesafe-ai/jev`, 200).
  - `ok-luna` (`openai/gpt-6-luna-decisions`, 200). If the gateway does not
    offer the model to the account, drop the case; do not try other models.
  - `pinned-not-offered` (`typesafe-ai/jev-1.13.0`, 404 `model_not_found`,
    checked 2026-10-11; so a pinned request is `error` on this provider).
  - `auth-invalid-key` (401).
  - `language-model` (`openai/gpt-5-mini`, 400).
  - `model-not-found` (404).
- Saved as `packages/decision-layer/test/fixtures/ai-gateway-live-<UTC date>.json`
  with the endpoint, capture time and auth placeholder. Each case holds its
  request, status, content type, latency and body. Latency is capture metadata.
- Redaction is an allowlist. An ok body keeps only `answers`, `model`, `usage`,
  and `provider_metadata.gateway.routing.{originalModelId, resolvedProvider, canonicalSlug, finalProvider}`.
  An error body keeps only `error` and the same routing keys when present.
  Generation IDs, costs, timings and anything else are dropped. The script
  refuses to write if the key appears in the output.
- For every ok case, the script asserts that every `choice` answer carries a
  `probabilities` array. Without one, `change-risk-v1` can never reach
  `allow` for that model (its `allowIf` needs `minProbability`); if a model
  lacks it, the README says so.
- For every ok case, the script asserts that the reply's `model` equals the
  request's `model`. If that fails, stop and revise this spec: the exact-model
  rule would make that model unusable. Do not drop the case to get past it.
- The adapter must then send exactly the captured request; a test asserts this.
- The capture holds no fallback reply. The `model-mismatch` test uses a
  synthetic body, and the test names it as synthetic.

## Docs

- `packages/decision-layer/README.md`: usage line, `--provider` row, env list,
  and a Providers paragraph. It covers the endpoint, the key, the slug form,
  Choice and Noul only, the no-fallback rules, the capture date, and that
  OpenRouter is not a provider yet because no live capture exists. It also
  says that `ai-gateway` sends the input as a canonical JSON string while
  `jev` sends a structured `state`, so records of the same model from the two
  providers must not be pooled.
- `apps/docs/content/docs/toolkit/decision-layer.mdx`: usage line and
  `--provider` row.
- `docs/package-reference.md`: usage line.
- `docs/specs/decision-layer-shadow.md`: only the Interface usage line and the
  env list in "Operating modes", plus a pointer to this spec. This item waits
  for the maintainer's answer in #1210; if the maintainer prefers no change
  there, drop it.

## Delivery order

1. This spec.
2. The live fixture, alone.
3. The RED rails: `test/ai-gateway-adapter.test.mjs`, the new
   `test/cli.test.mjs` cases, and the test-helper env scrub
   (`AI_GATEWAY_API_KEY` cleared in spawned runs). The rails fail on the
   pre-change tree.
4. The shared-module refactor, with the jev tests green and unedited.
5. The provider: `lib/adapters/ai-gateway.mjs`, `lib/config.mjs` (provider,
   key, `MODEL_PATTERN`), `lib/provider.mjs` (`exactModel` in
   `checkResolvedModel`), `lib/evaluate.mjs` (`providerFor`, the pack check
   and its messages), and the `lib/cli.mjs` help.
6. The docs.

## Acceptance criteria

1. The live fixture is committed before any adapter code for `ai-gateway`, in
   an earlier commit. This holds on the branch; a squash merge removes it.
   verify: `F=$(git log --reverse --diff-filter=A --format=%H origin/main..HEAD -- 'packages/decision-layer/test/fixtures/ai-gateway-live-*.json' | head -1); A=$(git log --reverse --diff-filter=A --format=%H origin/main..HEAD -- packages/decision-layer/lib/adapters/ai-gateway.mjs | head -1); test -n "$F" && test -n "$A" && test "$F" != "$A" && git merge-base --is-ancestor "$F" "$A"`
2. The adapter replays the fixture: its request equals the captured request;
   the ok replies map as under "Reply"; 401, 400 and both 404s are `error` with
   `http-<status>` after one attempt; every case under "Reply" and "Failures"
   classifies as stated; the injected fetch receives `POST` to the fixture's
   `endpoint` with `Authorization: Bearer <key>` and
   `redirect: 'manual'`; a reply from another model records `status: error`,
   `errorClass: model-mismatch` and that model as `resolvedModel`, also when
   one of its answers is out of domain or a refusal; each
   fixture body's keys equal the redaction allowlist; and each captured ok
   latency is under half of `DEFAULT_TIMEOUT_MS`. verify: `node --test packages/decision-layer/test/ai-gateway-adapter.test.mjs`
3. `jev` is unchanged: its tests pass, and neither they nor their fixture are
   edited. verify: `node --test packages/decision-layer/test/jev-adapter.test.mjs && git diff --exit-code origin/main -- packages/decision-layer/test/jev-adapter.test.mjs packages/decision-layer/test/fixtures/jev-live-2026-10-08.json`
4. Every configuration error under "Interface" exits 1 with its exact
   message, sends nothing and writes no record; `--model a/b/c`, `/jev`,
   `jev/` and a 129-character ID are refused, and `typesafe-ai/jev` is
   accepted; with a valid key the run reaches the provider's fetch (exit 97
   from the test preload; criterion 2 asserts the URL); with `AI_GATEWAY_API_KEY` unset or empty and
   `TYPESAFE_API_KEY`, `JEV_API_KEY` and an invalid `TYPESAFE_API_URL` set,
   `--provider ai-gateway` exits 1 with the "No key" message; and a `mock`
   reply that names a model with one `/` is accepted (the same `validModel`
   check serves `jev`). verify: `node --test packages/decision-layer/test/cli.test.mjs`
5. The package suite passes and makes no network call, also when the
   developer's shell has `AI_GATEWAY_API_KEY` set. verify: `AI_GATEWAY_API_KEY=placeholder node --test packages/decision-layer/test/*.test.mjs`
6. `enforce` still occurs once in `lib`, and every `lib` file is under 400
   lines. verify: `node --test packages/decision-layer/test/isolation.test.mjs && test -z "$(wc -l packages/decision-layer/lib/*.mjs packages/decision-layer/lib/adapters/*.mjs | awk '$2 != "total" && $1 >= 400')"`
7. The docs under "Docs" are updated, and the repository doc checks pass.
   verify: `for f in packages/decision-layer/README.md apps/docs/content/docs/toolkit/decision-layer.mdx docs/package-reference.md packages/decision-layer/lib/cli.mjs; do grep -q -- '--provider <ai-gateway|jev|mock>' "$f" || { echo "usage line missing: $f"; exit 1; }; done && grep -q AI_GATEWAY_API_KEY packages/decision-layer/README.md && grep -q -i 'must not be pooled' packages/decision-layer/README.md && node --test scripts/test/docs-truth.test.mjs scripts/test/package-reference-coverage.test.mjs`
8. CI parity: tests, rail freeze and mutation gate. verify: `npm run preflight`
9. One live run with a real key records `status: ok` with
   `resolvedModel: typesafe-ai/jev` (needs a key; not in CI). verify:
   `node packages/decision-layer/bin/adlc-decision.mjs evaluate --mode shadow --provider ai-gateway --model typesafe-ai/jev --pack change-risk-v1 --json | node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(r.status === "ok" && r.resolvedModel === "typesafe-ai/jev" ? 0 : 1)'`

## Design alternatives (P1 panel, 2026-10-11)

Three designs came from differently anchored prompts. None of them saw the
earlier prototype.

| Anchor | Endpoint | Noul | Override | Name | Defaults |
| --- | --- | --- | --- | --- | --- |
| MVP-first | `/v1/decisions` | yes/no `choice` | none | `ai-gateway` | unchanged |
| Risk-first | `/typesafe/v1/systemone` via the jev adapter | jev rule | none | `ai-gateway` | unchanged |
| Ops-first | `/v1/decisions` | `predicate`, jev rule | none | `vercel-ai-gateway` | provider, model and pack defaults |

All three agree on:

- a distinct provider name in the record;
- no `providerOptions`;
- `Score` refused, and one call per run;
- a shared HTTP module;
- one `/` in model IDs;
- replay of a committed capture.

The synthesis takes:

- the native endpoint (MVP, ops);
- the jev `Noul` rule over `predicate` (risk, ops);
- no override (all three);
- the `ai-gateway` name (MVP, risk);
- unchanged defaults (MVP, risk);
- the 128-character total cap (all three).

## Decisions (P1 interrogation, round 1, 2026-10-11)

1. The endpoint is the native Decisions API, not the gateway's System One
   endpoint: it reaches every decision model on the gateway, and a live capture
   of it exists. The System One route reaches only Jev.
2. The provider is `ai-gateway`, matching Vercel's own names
   (`AI_GATEWAY_API_KEY`, `ai-gateway.vercel.sh`).
3. No endpoint override: the key only goes to the fixed URL. An override can
   come later if a proxy needs it.
4. `Noul` is a `predicate` with jev's P(yes) rule, so both providers record a
   `Noul` answer the same way. The yes/no `choice` alternative changes the
   question type and may calibrate differently.
5. A fresh capture is made before any adapter code, from hand-built requests,
   so decision 9 holds to the letter. The 2026-10-11 prototype capture is not
   reused.
6. Shadow mode keeps its required flags; no defaults are added. A default
   provider chosen by which key is present would be hidden routing.
7. `MODEL_PATTERN` keeps today's 128-character total cap with one `/`; a
   per-segment cap would allow 257 characters.
8. The unknown-provider message keeps its current form,
   `PROVIDERS.join(' or ')`.

## Decisions (P1 premortem, round 1, 2026-10-11)

9. The predicate error classes are jev's exactly: an absent probability is
   `out-of-domain`, and a present non-number is `malformed-response`. The
   shared `Noul` mapping then serves both providers.
10. The wider `MODEL_PATTERN` also applies to reply models for every provider.
    A second, reply-only pattern would add a rule to keep in step for no
    benefit; a test pins the new behaviour.
11. A reply from any model other than the requested slug is `model-mismatch`.
    Decision fallbacks are opt-in per request and the reply's `model` names
    the answering model, so this check turns a fallback into an error instead
    of a misattributed probability.
12. A `Choice` over more than 255 labels is refused before dispatch, so the
    sanitized input is not sent for a request the gateway would reject.
13. The capture adds `pinned-not-offered`, because the gateway lists only
    alias slugs.
14. Fixture redaction is an allowlist of body keys, and the capture input is
    synthetic.
15. `assertSafeApiUrl` stays in `jev.mjs`; key messages come from each
    provider. The jev messages then stay exact.

## Decisions (P1 premortem, round 2, 2026-10-11)

16. The exact-model rule lives in `checkResolvedModel`, behind a
    provider-declared `exactModel` flag, and raises `UnusableReply`. The record
    then keeps the model that answered, and `jev` and `mock` keep the
    pinned-only rule.
17. The capture proves the exact-model rule for every ok case. A failure there
    revises the spec; it is not a reason to drop the case.
18. `ai-gateway` reads no jev variable. A CLI test sets the jev key and URL
    variables without the gateway key and expects the "No key" error.
19. The adapter forwards only the three usage counters, so a gateway that adds
    usage details does not turn a valid reply into `malformed-response`.
20. The size bounds stay on the neutral request; an oversized body is the
    gateway's `http-<status>`. The README warns not to pool records across
    `jev` and `ai-gateway`, because the two send the input in different forms.

## Decisions (P1 premortem, round 3, 2026-10-11)

21. For an `exactModel` provider, the model check runs before answer
    validation, so a foreign model is never hidden behind an answer error.
22. A refusal stays `malformed-response`, on purpose, and the README says so.
23. Goal 2 claims only what the checks prove: no request-level fallback. Alias
    re-pointing and account routing are named limits.
24. The URL, method and headers are asserted on the injected fetch in the
    adapter test; the CLI test only proves that the fetch is reached.
25. Criterion 7 checks the docs by text, because the repository doc tests do
    not read the decision-layer pages.

Premortem rounds reached the cap of three. Decisions 21-25 were folded in
after round 3 without a fourth round.

## Decisions (contributor review, 2026-10-11)

26. The wider `MODEL_PATTERN` also applies to `--model` for `jev` and `mock`,
    not only to reply models. A fresh review found that the spec claimed less
    than the code and the frozen CLI test do. One pattern for every provider
    follows decision 10, keeps the frozen test valid, and lets `jev` reach a
    TypeSafe-compatible endpoint that uses vendor-scoped IDs. Re-approved by
    Rafael Belliard, 2026-10-11.
