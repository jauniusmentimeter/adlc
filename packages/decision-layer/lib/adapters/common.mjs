// What the HTTP adapters share (docs/specs/decision-layer-ai-gateway.md, "Shared
// module"). A key travels only in a header. One bounded POST classifies every
// failure the same way (network, rate-limit, server-error, interrupted-response,
// http-redirect, http-<status>, response-too-large, malformed-response), and a
// body is never read past MAX_RESPONSE_BYTES. One run is one call, so every
// question of a pack must be Choice or Noul and declare the same inputs. A Noul
// answer is P(yes) = p: `yes` with probability p when p >= 0.5, otherwise `no`
// with probability 1 - p, so a tie escalates rather than passes.

export const MAX_RESPONSE_BYTES = 65_536;
const RATE_LIMITED = new Set([429, 529]);

const round = (value) => Math.round(value * 1e6) / 1e6;

export class Unsupported extends Error {
  constructor(errorClass) {
    super(errorClass);
    this.errorClass = errorClass;
  }
}

/** A key that can travel in an HTTP header: printable ASCII, no spaces. */
export const API_KEY_PATTERN = /^[\x21-\x7e]+$/;

/** `label` names the key in the error, e.g. 'the Jev API key'. */
export function assertApiKey(key, label) {
  if (typeof key !== 'string' || !API_KEY_PATTERN.test(key)) throw new TypeError(`${label} is missing or holds characters a header cannot carry`);
  return key;
}

/**
 * Why a provider cannot ask this pack's questions in one call, or null when it can:
 * every question must be Choice or Noul and declare the same inputs.
 * @param {{ questions: Array<{ kind: string, inputs: string[] }> }} pack
 */
export function singleCallUnsupported(pack) {
  if (pack.questions.some((question) => question.kind !== 'Choice' && question.kind !== 'Noul')) return 'unsupported-question';
  const inputs = new Set(pack.questions.map((question) => JSON.stringify([...question.inputs].sort())));
  return inputs.size === 1 ? null : 'unsupported-pack';
}

/** The one input every question of a neutral request shares; throws Unsupported when they differ. */
export function sharedInput(request) {
  const inputs = new Set(request.questions.map((question) => JSON.stringify(question.input)));
  if (inputs.size !== 1) throw new Unsupported('unsupported-pack');
  return request.questions[0].input;
}

/** The neutral Noul answer for P(yes) = p; a non-number stays as it is so validation rejects it. */
export function noulAnswer(id, p) {
  if (typeof p !== 'number') return { id, kind: 'Noul', value: p, probability: p };
  return p >= 0.5 ? { id, kind: 'Noul', value: 'yes', probability: p } : { id, kind: 'Noul', value: 'no', probability: round(1 - p) };
}

/** The body as text, or null once it passes `limit` bytes (the stream is then cancelled). */
export async function readBounded(response, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** POST `body` as JSON with a Bearer key and classify the outcome; `translate(parsed)` builds the neutral reply body. */
export async function postJson({ fetchImpl, apiUrl, apiKey, signal }, body, translate) {
  let response;
  try {
    response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal,
    });
  } catch {
    return { failure: 'network' };
  }
  if (response.type === 'opaqueredirect') return { rejected: 'http-redirect' };
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => {});
    if (RATE_LIMITED.has(response.status)) return { failure: 'rate-limit' };
    if (response.status >= 500) return { failure: 'server-error' };
    return { rejected: `http-${response.status}` };
  }
  let text;
  try {
    text = await readBounded(response);
  } catch {
    return { failure: 'interrupted-response' };
  }
  if (text === null) return { rejected: 'response-too-large' };
  try {
    return { body: translate(JSON.parse(text)) };
  } catch {
    return { rejected: 'malformed-response' };
  }
}
