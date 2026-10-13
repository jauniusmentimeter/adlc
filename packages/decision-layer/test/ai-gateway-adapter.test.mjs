// Contract assumed by these RED rails: ai-gateway.mjs exports DEFAULT_API_URL,
// decisionsRequest(), createAiGatewayProvider({ apiKey, fetch }), and
// aiGatewayUnsupported(); its provider is { name: 'ai-gateway', exactModel: true }.
// config includes ai-gateway and the gateway-slug MODEL_PATTERN; providerFor uses
// AI_GATEWAY_API_KEY; and evaluateDecision honours exactModel before normalization.
// The AI Gateway provider, replayed against live Vercel AI Gateway Decisions
// responses captured on 2026-10-11 (test/fixtures/ai-gateway-live-2026-10-11.json):
// the request it builds, how each captured reply maps onto the pack's answers,
// and the status rules (no answer is unknown, an unusable answer or a rejection
// is error). Every call goes through an injected fetch; nothing here reaches
// the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNoNetwork } from './helpers/no-network.mjs';
import { DEFAULT_API_URL, aiGatewayUnsupported, createAiGatewayProvider, decisionsRequest } from '../lib/adapters/ai-gateway.mjs';
import { MAX_RESPONSE_BYTES } from '../lib/adapters/common.mjs';
import { DEFAULT_TIMEOUT_MS } from '../lib/provider.mjs';
import { canonicalJson } from '../lib/canonical.mjs';
import { providerFor } from '../lib/evaluate.mjs';
import { ConfigError } from '../lib/errors.mjs';
import { validateConfig } from '../lib/config.mjs';
import { scanText } from '../lib/sanitizer.mjs';
import { MAX_RETRIES, evaluateDecision } from '../lib/provider.mjs';
import { reduce } from '../lib/reducer.mjs';

installNoNetwork();

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = JSON.parse(readFileSync(join(HERE, '..', 'packs', 'change-risk-v1', 'pack.json'), 'utf8'));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'ai-gateway-live-2026-10-11.json'), 'utf8'));
const capture = (label) => FIXTURE.captures.find((entry) => entry.label === label);
const OK_JEV = capture('ok-jev');
const OK_LUNA = capture('ok-luna');
const AUTH_INVALID = capture('auth-invalid-key');
const LANGUAGE_MODEL = capture('language-model');
const PINNED_NOT_OFFERED = capture('pinned-not-offered');
const NOT_FOUND = capture('model-not-found');
const INPUT = JSON.parse(OK_JEV.request.input);
const KEY = 'test-key-not-real';
const NOUL = 'needs-deeper-interrogation';

/** A fetch that replays `responses` in order and records each call. */
function replay(...responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses[Math.min(calls.length, responses.length) - 1];
    if (next instanceof Error) {
      throw next;
    }
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const run = ({ fetch, model = 'typesafe-ai/jev', pack = PACK, input = INPUT, timeoutMs }) => evaluateDecision({
  provider: createAiGatewayProvider({ apiKey: KEY, fetch }),
  model,
  pack,
  sanitizedInput: input,
  retryDelayMs: 0,
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

const okWith = (replacements) => ({
  status: 200,
  body: { ...OK_JEV.body, answers: OK_JEV.body.answers.map((answer) => replacements[answer.name] ?? answer) },
});
const okReply = (overrides) => ({ status: 200, body: { ...OK_JEV.body, ...overrides } });
const omit = (body, key) => Object.fromEntries(Object.entries(body).filter(([name]) => name !== key));
const predicate = (probability) => ({ type: 'predicate', name: NOUL, probability });

test('the fixture is a live capture with the endpoint, model and date, and no key', () => {
  assert.equal(FIXTURE.endpoint, DEFAULT_API_URL);
  assert.match(FIXTURE.capturedAt, /^2026-10-11T/);
  assert.equal(OK_JEV.status, 200);
  assert.equal(OK_JEV.body.model, 'typesafe-ai/jev');
  assert.equal(AUTH_INVALID.status, 401);
  assert.doesNotMatch(JSON.stringify(FIXTURE), /Bearer\s+(?!<)/);
  assert.doesNotMatch(JSON.stringify(FIXTURE), /gen_|generationId|startTime|cost/);
  const strings = (value) => (typeof value === 'string' ? [value]
    : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]) : []);
  for (const text of strings(FIXTURE)) {
    assert.equal(scanText(text).redactions, 0, text);
  }
});

test('the fixture has six redacted live captures and contains no credential-shaped text', () => {
  assert.equal(FIXTURE.captures.length, 6);
  const allowedOk = new Set(['answers', 'model', 'usage', 'provider_metadata']);
  for (const entry of FIXTURE.captures) {
    const keys = new Set(Object.keys(entry.body));
    assert.deepEqual(keys, entry.status === 200 ? allowedOk : new Set(keys.has('providerMetadata') ? ['error', 'providerMetadata'] : ['error']), entry.label);
    const metadata = entry.body.provider_metadata ?? entry.body.providerMetadata;
    if (metadata) {
      assert.deepEqual(Object.keys(metadata), ['gateway']);
      assert.deepEqual(Object.keys(metadata.gateway), ['routing']);
      const routingKeys = Object.keys(metadata.gateway.routing).sort();
      const allowedRouting = ['canonicalSlug', 'finalProvider', 'originalModelId', 'resolvedProvider'];
      assert.ok(routingKeys.every((key) => allowedRouting.includes(key)), entry.label);
      if (entry.status === 200) assert.deepEqual(routingKeys, allowedRouting);
    }
    if (entry.status === 200) assert.ok(entry.latencyMs < DEFAULT_TIMEOUT_MS / 2, entry.label);
  }
  assert.doesNotMatch(JSON.stringify(FIXTURE), /generationId|gen_|cost/);
});

test('the request matches the shape the live API accepted', async () => {
  const { fetch, calls } = replay({ status: 200, body: OK_JEV.body });
  await run({ fetch });
  assert.equal(calls.length, 1);
  const [sent] = calls;
  assert.equal(sent.url, DEFAULT_API_URL);
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(sent.init.headers['Content-Type'], 'application/json');
  assert.equal(sent.init.redirect, 'manual');
  assert.deepEqual(sent.body, OK_JEV.request);
  assert.equal(Object.hasOwn(sent.body, 'providerOptions'), false);
  assert.equal(sent.body.input, canonicalJson(INPUT));
  assert.ok(!sent.init.body.includes(KEY), 'the key is never in the body');
  assert.ok(!sent.init.body.includes(PACK.id), 'the pack ID is not sent');
});

test('the captured typesafe-ai/jev reply maps to the pack answers', async () => {
  const result = await run({ fetch: replay({ status: 200, body: OK_JEV.body }).fetch });
  const [risk, deeper] = OK_JEV.body.answers;
  assert.equal(result.status, 'ok');
  assert.equal(result.errorClass, null);
  assert.equal(result.resolvedModel, 'typesafe-ai/jev');
  assert.deepEqual(result.usage, {
    inputTokens: OK_JEV.body.usage.input_tokens,
    outputTokens: OK_JEV.body.usage.output_tokens,
    totalTokens: OK_JEV.body.usage.total_tokens,
  });
  assert.deepEqual(result.answers, [
    {
      id: 'risk',
      kind: 'Choice',
      value: risk.choice,
      probability: risk.probabilities.find((entry) => entry.value === risk.choice).probability,
      confidence: risk.confidence,
    },
    { id: NOUL, kind: 'Noul', value: 'no', probability: 0.51 },
  ]);
  assert.equal(reduce({ status: result.status, answers: result.answers, pack: PACK }).outcome, 'unknown');
});

test('the captured openai/gpt-6-luna-decisions reply maps with its own resolved model', async () => {
  const { fetch, calls } = replay({ status: 200, body: OK_LUNA.body });
  const result = await run({ fetch, model: 'openai/gpt-6-luna-decisions' });
  const [risk, deeper] = OK_LUNA.body.answers;
  assert.deepEqual(calls[0].body, OK_LUNA.request);
  assert.equal(result.status, 'ok');
  assert.equal(result.resolvedModel, 'openai/gpt-6-luna-decisions');
  assert.deepEqual(result.usage, {
    inputTokens: OK_LUNA.body.usage.input_tokens,
    outputTokens: OK_LUNA.body.usage.output_tokens,
    totalTokens: OK_LUNA.body.usage.total_tokens,
  });
  assert.deepEqual(result.answers[0], {
    id: 'risk',
    kind: 'Choice',
    value: risk.choice,
    probability: risk.probabilities.find((entry) => entry.value === risk.choice).probability,
    confidence: risk.confidence,
  });
  assert.deepEqual(result.answers[1], { id: NOUL, kind: 'Noul', value: 'yes', probability: deeper.probability });
});

test('a pinned model that the gateway reports under its alias is error', async () => {
  const result = await run({ fetch: replay({ status: 200, body: OK_JEV.body }).fetch, model: 'typesafe-ai/jev-1.13.0' });
  assert.equal(result.status, 'error');
  assert.equal(result.errorClass, 'model-mismatch');
  assert.equal(result.resolvedModel, 'typesafe-ai/jev');
});

for (const [name, entry, errorClass] of [
  ['the captured pinned-not-offered 404', PINNED_NOT_OFFERED, 'http-404'],
  ['the captured 401', AUTH_INVALID, 'http-401'],
  ['the captured language-model 400', LANGUAGE_MODEL, 'http-400'],
  ['the captured unknown-model 404', NOT_FOUND, 'http-404'],
]) {
  test(`${name} is error and is not retried`, async () => {
    const { fetch, calls } = replay({ status: entry.status, body: entry.body });
    const result = await run({ fetch, model: entry.request.model });
    assert.equal(result.status, 'error');
    assert.equal(result.errorClass, errorClass);
    assert.equal(result.attemptCount, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(result.answers, []);
  });
}

test('Noul: P(yes) >= 0.5 is yes with probability p, below is no with 1 - p, and a tie is yes', async () => {
  for (const [p, value, probability] of [[0.48, 'no', 0.52], [0.5, 'yes', 0.5], [0.9, 'yes', 0.9], [0, 'no', 1], [1, 'yes', 1]]) {
    const result = await run({ fetch: replay(okWith({ [NOUL]: predicate(p) })).fetch });
    assert.equal(result.status, 'ok', String(p));
    assert.deepEqual(result.answers[1], { id: NOUL, kind: 'Noul', value, probability }, String(p));
  }
});

for (const [name, replacements] of [
  ['a predicate probability above 1', { [NOUL]: predicate(1.2) }],
  ['a predicate probability below 0', { [NOUL]: predicate(-0.1) }],
  ['a predicate answer typed as a choice', { [NOUL]: { type: 'choice', name: NOUL, choice: 'yes' } }],
  ['an unknown answer type', { risk: { type: 'verdict', name: 'risk', value: 'low' } }],
  ['a refusal', { risk: { type: 'refusal', name: 'risk' } }],
  ['a score answer', { risk: { type: 'score', name: 'risk', score: 1.2 } }],
  ['an answer with no name', { risk: { type: 'choice', name: null, choice: 'low' } }],
  ['a bare string answer', { risk: 'low' }],
  ['an answer that is an array', { risk: ['low'] }],
  ['a choice answer without a type', { risk: { name: 'risk', choice: 'low' } }],
  ['a choice answer whose choice is a number', { risk: { type: 'choice', name: 'risk', choice: 1 } }],
]) {
  test(`${name} is error (malformed)`, async () => {
    const result = await run({ fetch: replay(okWith(replacements)).fetch });
    assert.deepEqual([result.status, result.errorClass, result.answers], ['error', 'malformed-response', []]);
  });
}

test('an extra answer, a duplicate answer and a missing answer are error (malformed)', async () => {
  const [risk, deeper] = OK_JEV.body.answers;
  for (const answers of [[risk, deeper, { type: 'predicate', name: 'extra', probability: 0.5 }], [risk, deeper, risk], [risk]]) {
    const result = await run({ fetch: replay(okReply({ answers })).fetch });
    assert.deepEqual([result.status, result.errorClass], ['error', 'malformed-response']);
  }
});

for (const [name, body] of [
  ['answers that are not an array', { answers: { risk: 'low' } }],
  ['no answers', {}],
]) {
  test(`a reply with ${name} is error (malformed)`, async () => {
    const result = await run({ fetch: replay({ status: 200, body: { model: 'typesafe-ai/jev', ...body } }).fetch });
    assert.deepEqual([result.status, result.errorClass, result.resolvedModel], ['error', 'malformed-response', 'typesafe-ai/jev']);
  });
}

for (const model of ['typesafe-ai/jev', 'typesafe-ai/jev-1.13.0']) {
  test(`a reply that reports no model is error, so a pin cannot pass unchecked (${model})`, async () => {
    const result = await run({ fetch: replay({ status: 200, body: omit(OK_JEV.body, 'model') }).fetch, model });
    assert.deepEqual([result.status, result.errorClass, result.resolvedModel], ['error', 'malformed-response', null]);
  });
}

for (const [name, body] of [
  ['null', 'null'],
  ['an array', '[]'],
  ['a number', '7'],
  ['html', '<html>gateway</html>'],
  ['a usage that is not an object', JSON.stringify({ ...OK_JEV.body, usage: 'x' })],
  ['a usage that is an array', JSON.stringify({ ...OK_JEV.body, usage: [] })],
]) {
  test(`a 2xx reply with ${name} is error (malformed)`, async () => {
    const result = await run({ fetch: replay({ status: 200, body }).fetch });
    assert.deepEqual([result.status, result.errorClass], ['error', 'malformed-response']);
  });
}

for (const [name, replacements] of [
  ['a choice outside the domain', { risk: { type: 'choice', name: 'risk', choice: 'severe', confidence: 0.9, probabilities: [{ value: 'severe', probability: 1 }] } }],
  ['a predicate without a number', { [NOUL]: { type: 'predicate', name: NOUL } }],
]) {
  test(`${name} is error (out of domain)`, async () => {
    const result = await run({ fetch: replay(okWith(replacements)).fetch });
    assert.deepEqual([result.status, result.errorClass], ['error', 'out-of-domain']);
  });
}

for (const [name, probabilities] of [['an empty list', []], ['an object', {}], ['a list of non-objects', ['low', null, 3]]]) {
  test(`a choice whose probabilities are ${name} keeps the choice without a probability`, async () => {
    const result = await run({ fetch: replay(okWith({ risk: { type: 'choice', name: 'risk', choice: 'low', probabilities, confidence: 0.4 } })).fetch });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.answers[0], { id: 'risk', kind: 'Choice', value: 'low', confidence: 0.4 });
  });
}

test('a choice label that names an Object prototype member keeps its own probability', async () => {
  const pack = { ...PACK, questions: [{ ...PACK.questions[0], domain: ['constructor', 'toString'] }, PACK.questions[1]] };
  const answer = { type: 'choice', name: 'risk', choice: 'constructor', probabilities: [{ value: 'constructor', probability: 0.7 }], confidence: 0.5 };
  const result = await run({ fetch: replay(okWith({ risk: answer })).fetch, pack });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.answers[0], { id: 'risk', kind: 'Choice', value: 'constructor', probability: 0.7, confidence: 0.5 });
});

for (const [name, providerMetadata] of [['an object', { gateway: { routing: { x: 1 } }, extra: [1] }], ['a string', 'x'], ['null', null]]) {
  test(`provider_metadata that is ${name} is dropped and the reply stays ok`, async () => {
    const result = await run({ fetch: replay(okReply({ provider_metadata: providerMetadata })).fetch });
    assert.equal(result.status, 'ok');
  });
}

for (const [name, usage, expected] of [
  ['no usage', undefined, null],
  ['a null usage', null, null],
  ['only input_tokens', { input_tokens: 9 }, { inputTokens: 9 }],
  ['only total_tokens', { total_tokens: 12 }, { totalTokens: 12 }],
]) {
  test(`a reply with ${name} is still ok, with usage ${JSON.stringify(expected)}`, async () => {
    const body = omit(OK_JEV.body, 'usage');
    const result = await run({ fetch: replay({ status: 200, body: usage === undefined ? body : { ...body, usage } }).fetch });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.usage, expected);
  });
}

test('a 400 is error and is not retried', async () => {
  const { fetch, calls } = replay({ status: 400, body: { error: { type: 'invalid_request_error' } } });
  const result = await run({ fetch });
  assert.deepEqual([result.status, result.errorClass, calls.length], ['error', 'http-400', 1]);
});

for (const [name, response, errorClass] of [
  ['429', { status: 429, body: {} }, 'rate-limit'],
  ['529', { status: 529, body: {} }, 'rate-limit'],
  ['a network failure', new TypeError('fetch failed'), 'network'],
]) {
  test(`${name} is unknown after ${MAX_RETRIES} retries`, async () => {
    const { fetch, calls } = replay(response);
    const result = await run({ fetch });
    assert.equal(result.status, 'unknown');
    assert.equal(result.errorClass, errorClass);
    assert.equal(result.attemptCount, MAX_RETRIES + 1);
    assert.equal(calls.length, MAX_RETRIES + 1);
    assert.equal(result.resolvedModel, null);
  });
}

test('a retried 429 that then succeeds is ok and counts both attempts', async () => {
  const result = await run({ fetch: replay({ status: 429, body: {} }, { status: 200, body: OK_JEV.body }).fetch });
  assert.equal(result.status, 'ok');
  assert.equal(result.attemptCount, 2);
});

test('a call that does not answer in time is unknown, not retried, and its fetch is aborted', async () => {
  let signal;
  const fetch = (_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  };
  const result = await run({ fetch, timeoutMs: 20 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.errorClass, 'timeout');
  assert.equal(result.attemptCount, 1);
  assert.equal(signal.aborted, true);
});

for (const status of [500, 503, 599]) {
  test(`a ${status} is unknown (server-error) and is not retried`, async () => {
    const { fetch, calls } = replay({ status, body: {} });
    const result = await run({ fetch });
    assert.deepEqual([result.status, result.errorClass, result.attemptCount, calls.length], ['unknown', 'server-error', 1, 1]);
  });
}

for (const status of [429, 503, 401]) {
  test(`the body of a ${status} is cancelled, not left holding the connection`, async () => {
    let cancelled = 0;
    const fetch = async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1)); },
      cancel() { cancelled += 1; },
    }), { status });
    const result = await run({ fetch });
    assert.equal(cancelled, result.attemptCount);
  });
}

test('a redirect is error and is not followed', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(init);
    return { type: 'opaqueredirect', status: 0, headers: new Headers(), body: null };
  };
  const result = await run({ fetch });
  assert.deepEqual([result.status, result.errorClass, calls.length], ['error', 'http-redirect', 1]);
});

for (const status of [301, 302, 307]) {
  test(`a real ${status} is error (http-${status}) and its Location is never fetched`, async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push(url);
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status, headers: { location: 'https://elsewhere.example.test/' } });
    };
    const result = await run({ fetch });
    assert.deepEqual([result.status, result.errorClass, calls], ['error', `http-${status}`, [DEFAULT_API_URL]]);
  });
}

test('a body that never ends is cut off at the limit and is error', async () => {
  let pulled = 0;
  let cancelled = false;
  // Finite on purpose: the stream closes after 64 chunks (eight times the
  // limit), so a limit that stops working fails the assertions below instead of
  // reading without bound. 64 is a literal so it does not move with MAX_RESPONSE_BYTES.
  const body = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 64) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(8192));
    },
    cancel() { cancelled = true; },
  });
  const fetch = async () => new Response(body, { status: 200 });
  const result = await run({ fetch });
  assert.deepEqual([result.status, result.errorClass], ['error', 'response-too-large']);
  assert.equal(cancelled, true);
  assert.ok(pulled * 8192 <= MAX_RESPONSE_BYTES + 2 * 8192, `read ${pulled} chunks`);
});

test('a declared Content-Length over the limit is error without reading the body', async () => {
  let pulled = 0;
  const body = new ReadableStream({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1)); } });
  const fetch = async () => new Response(body, { status: 200, headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } });
  const result = await run({ fetch });
  assert.deepEqual([result.status, result.errorClass], ['error', 'response-too-large']);
  assert.ok(pulled <= 1, `pulled ${pulled}`);
});

test('an oversized 2xx body is error', async () => {
  const result = await run({ fetch: replay({ status: 200, body: 'x'.repeat(70_000) }).fetch });
  assert.deepEqual([result.status, result.errorClass], ['error', 'response-too-large']);
});

test('a 2xx body that breaks off mid-read is unknown (interrupted-response) and is not retried', async () => {
  let reads = 0;
  const fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      reads += 1;
      controller.error(new Error('reset'));
    },
  }), { status: 200 });
  const result = await run({ fetch });
  assert.deepEqual([result.status, result.errorClass, result.attemptCount, reads], ['unknown', 'interrupted-response', 1, 1]);
});

for (const status of [200, 204]) {
  test(`a ${status} with no body is error (malformed)`, async () => {
    const result = await run({ fetch: async () => new Response(null, { status }) });
    assert.deepEqual([result.status, result.errorClass], ['error', 'malformed-response']);
  });
}

test('questions that declare different inputs are rejected before anything is sent: one run is one call', async () => {
  const { fetch, calls } = replay({ status: 200, body: OK_JEV.body });
  const pack = { ...PACK, questions: [{ ...PACK.questions[0], inputs: ['linesAdded'] }, { ...PACK.questions[1], inputs: ['filesChanged'] }] };
  const result = await run({ fetch, pack });
  assert.deepEqual([result.status, result.errorClass, result.attemptCount, calls.length], ['error', 'unsupported-pack', 0, 0]);
});

test('a Score question is rejected before anything is sent: no live Score reply has been captured', async () => {
  const { fetch, calls } = replay({ status: 200, body: OK_JEV.body });
  const pack = {
    ...PACK,
    questions: [{ id: 'severity', kind: 'Score', prompt: 'How severe?', domain: { min: 1, max: 3 }, phases: ['P0'], inputs: ['linesAdded'] }],
    aggregation: { escalateIf: [], allowIf: [] },
  };
  const result = await run({ fetch, pack });
  assert.deepEqual([result.status, result.errorClass, result.attemptCount, calls.length], ['error', 'unsupported-question', 0, 0]);
});

test('aiGatewayUnsupported names why a pack cannot be asked in one call, ignoring input order', () => {
  assert.equal(aiGatewayUnsupported(PACK), null);
  const reordered = { questions: [{ kind: 'Choice', inputs: ['a', 'b'] }, { kind: 'Noul', inputs: ['b', 'a'] }] };
  assert.equal(aiGatewayUnsupported(reordered), null);
  assert.equal(aiGatewayUnsupported({ questions: [{ kind: 'Choice', inputs: ['a'] }, { kind: 'Noul', inputs: ['b'] }] }), 'unsupported-pack');
  assert.equal(aiGatewayUnsupported({ questions: [{ kind: 'Score', inputs: ['a'] }] }), 'unsupported-question');
});

test('decisionsRequest sends a Choice domain as choices, a Noul as a predicate, and the input as canonical JSON text', () => {
  assert.deepEqual(decisionsRequest({
    model: 'typesafe-ai/jev',
    questions: [
      { id: 'risk', kind: 'Choice', prompt: 'p', domain: ['low', 'high'], input: { b: 2, a: 1 } },
      { id: 'n', kind: 'Noul', prompt: 'q', domain: ['yes', 'no'], input: { b: 2, a: 1 } },
    ],
  }), {
    model: 'typesafe-ai/jev',
    input: '{"a":1,"b":2}',
    questions: [
      { type: 'choice', name: 'risk', instructions: 'p', choices: [{ value: 'low' }, { value: 'high' }] },
      { type: 'predicate', name: 'n', instructions: 'q' },
    ],
  });
});

const SHADOW_GATEWAY = { mode: 'shadow', provider: 'ai-gateway', model: 'typesafe-ai/jev', pack: 'change-risk-v1' };

test('a missing AI_GATEWAY_API_KEY is a configuration error', () => {
  assert.throws(() => validateConfig(SHADOW_GATEWAY, {}), (error) => error instanceof ConfigError && /needs AI_GATEWAY_API_KEY/.test(error.message));
});

for (const key of ['abc\r', 'ab c', 'ab\ncd']) {
  test(`a key a header cannot carry (${JSON.stringify(key)}) is refused before anything is sent`, () => {
    assert.throws(() => validateConfig(SHADOW_GATEWAY, { AI_GATEWAY_API_KEY: key }), (error) => error instanceof ConfigError && /header cannot carry/.test(error.message));
    assert.throws(() => createAiGatewayProvider({ apiKey: key }), TypeError);
    assert.throws(() => providerFor({ ...SHADOW_GATEWAY, apiUrl: DEFAULT_API_URL }, { AI_GATEWAY_API_KEY: key }), (error) => error instanceof ConfigError && /header cannot carry/.test(error.message));
  });
}

test('providerFor refuses a missing key as a ConfigError', () => {
  assert.throws(() => providerFor({ ...SHADOW_GATEWAY, apiUrl: DEFAULT_API_URL }, {}), ConfigError);
});

test('config accepts vendor-scoped gateway models and refuses malformed slugs', () => {
  const env = { AI_GATEWAY_API_KEY: 'k' };
  for (const model of ['typesafe-ai/jev', 'openai/gpt-6-luna-decisions']) assert.equal(validateConfig({ ...SHADOW_GATEWAY, model }, env).model, model);
  for (const model of ['a/b/c', '/jev', 'jev/', 'a'.repeat(129)]) assert.throws(() => validateConfig({ ...SHADOW_GATEWAY, model }, env), ConfigError, model);
});

test('SYNTHETIC foreign model wins over unusable answers for an exact-model provider', async () => {
  for (const answers of [OK_JEV.body.answers, [{ ...OK_JEV.body.answers[0], choice: 'outside-domain' }, OK_JEV.body.answers[1]], [{ type: 'refusal', name: 'risk' }, OK_JEV.body.answers[1]]]) {
    const result = await run({ fetch: replay({ status: 200, body: { ...OK_JEV.body, model: 'openai/gpt-6-luna-decisions', answers } }).fetch });
    assert.deepEqual([result.status, result.errorClass, result.resolvedModel], ['error', 'model-mismatch', 'openai/gpt-6-luna-decisions']);
  }
});

for (const model of [undefined, null, 3]) {
  test(`a missing or non-string reply model (${String(model)}) is malformed`, async () => {
    const body = { ...OK_JEV.body };
    if (model === undefined) delete body.model;
    else body.model = model;
    const result = await run({ fetch: replay({ status: 200, body }).fetch });
    assert.deepEqual([result.errorClass, result.resolvedModel], ['malformed-response', null]);
  });
}

test('a Choice uses the first matching probability and tolerates no usable probabilities list', async () => {
  const first = { type: 'choice', name: 'risk', choice: 'low', confidence: 0.4, probabilities: [{ value: 'low', probability: 0.2 }, { value: 'low', probability: 0.9 }] };
  let result = await run({ fetch: replay(okWith({ risk: first })).fetch });
  assert.deepEqual(result.answers[0], { id: 'risk', kind: 'Choice', value: 'low', probability: 0.2, confidence: 0.4 });
  for (const probabilities of [undefined, {}, []]) {
    result = await run({ fetch: replay(okWith({ risk: { ...first, probabilities } })).fetch });
    assert.equal(result.status, 'ok');
    assert.equal(Object.hasOwn(result.answers[0], 'probability'), false);
  }
});

for (const [name, answer] of [
  ['a choice probability above one', { type: 'choice', name: 'risk', choice: 'low', probabilities: [{ value: 'low', probability: 1.1 }] }],
  ['a confidence that is not a number', { type: 'choice', name: 'risk', choice: 'low', confidence: 'high' }],
]) test(`${name} is malformed`, async () => {
  const result = await run({ fetch: replay(okWith({ risk: answer })).fetch });
  assert.equal(result.errorClass, 'malformed-response');
});

for (const usage of [{ input_tokens: null }, { output_tokens: -1 }, { total_tokens: 1.5 }, { input_tokens: '3' }]) {
  test(`a copied invalid usage counter is malformed: ${JSON.stringify(usage)}`, async () => {
    const result = await run({ fetch: replay(okReply({ usage })).fetch });
    assert.equal(result.errorClass, 'malformed-response');
  });
}

test('gateway usage drops unknown nested fields before shared validation', async () => {
  const result = await run({ fetch: replay(okReply({ usage: { input_tokens: 2, details: { cached: 1 }, ignored: 9 } })).fetch });
  assert.deepEqual([result.status, result.usage], ['ok', { inputTokens: 2 }]);
});

test('a 256-label Choice is refused before dispatch, while 255 is allowed', async () => {
  const labels = Array.from({ length: 256 }, (_value, index) => `label-${index}`);
  const tooMany = { ...PACK, questions: [{ ...PACK.questions[0], domain: labels }, PACK.questions[1]] };
  const { fetch, calls } = replay({ status: 200, body: OK_JEV.body });
  const refused = await run({ fetch, pack: tooMany });
  assert.deepEqual([refused.errorClass, refused.attemptCount, calls.length], ['unsupported-question', 0, 0]);
  assert.equal(aiGatewayUnsupported({ ...tooMany, questions: [{ ...tooMany.questions[0], domain: labels.slice(0, 255) }, tooMany.questions[1]] }), null);
});

test('the gateway provider declares its name and exact model requirement', () => {
  const provider = createAiGatewayProvider({ apiKey: KEY, fetch: async () => assert.fail('sent') });
  assert.deepEqual([provider.name, provider.exactModel], ['ai-gateway', true]);
});

