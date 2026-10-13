// The AI Gateway provider: Vercel AI Gateway's OpenAI-compatible Decisions API
// over native fetch, built against the live responses in
// test/fixtures/ai-gateway-live-2026-10-11.json. The contract is
// docs/specs/decision-layer-ai-gateway.md.
//
// It translates in both directions and judges nothing itself: evaluateDecision
// still validates every answer against the pack and decides the status.
//
// Request. One run is one call (plus bounded retries) to the fixed URL; no
// variable can change it. The one input every question shares travels as
// canonical JSON text in `input`. A Choice question's labels become its choices
// (the gateway accepts 1 to 255) and a Noul question is a predicate. Score
// questions are refused before dispatch. No providerOptions are sent, so the
// gateway cannot fall back to another model.
//
// Reply. Answers match questions by name. A choice answer is its choice, with
// the probability of the first matching probabilities[] entry. A predicate is
// P(yes) = p, recorded with jev's Noul rule. A refusal or any other answer type
// keeps a kind the neutral validation rejects. The reply's model is the
// resolved model, and the provider declares exactModel, so evaluateDecision
// records any other model as model-mismatch. Only the three usage counters are
// kept; provider_metadata and every other key are dropped.
//
// Failures. As for jev, from common.mjs.
import { canonicalJson } from '../canonical.mjs';
import { Unsupported, assertApiKey, noulAnswer, postJson, sharedInput, singleCallUnsupported } from './common.mjs';

export const DEFAULT_API_URL = 'https://ai-gateway.vercel.sh/v1/decisions';
export const MAX_CHOICES = 255;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Why the gateway cannot ask this pack's questions in one call, or null when it can. */
export function aiGatewayUnsupported(pack) {
  const reason = singleCallUnsupported(pack);
  if (reason !== null) return reason;
  return pack.questions.some((question) => question.kind === 'Choice' && Array.isArray(question.domain) && question.domain.length > MAX_CHOICES) ? 'unsupported-question' : null;
}

function decisionsQuestion({ id, kind, prompt, domain }) {
  if (kind === 'Choice' && domain.length <= MAX_CHOICES) return { type: 'choice', name: id, instructions: prompt, choices: domain.map((value) => ({ value })) };
  if (kind === 'Noul') return { type: 'predicate', name: id, instructions: prompt };
  throw new Unsupported('unsupported-question');
}

/** The one Decisions request for a provider-neutral request; throws Unsupported when there is none. */
export function decisionsRequest(request) {
  const input = sharedInput(request);
  return { model: request.model, input: canonicalJson(input), questions: request.questions.map(decisionsQuestion) };
}

function neutralAnswer(answer) {
  if (!isObject(answer)) return { id: undefined, kind: 'not-an-answer', value: answer };
  const id = answer.name;
  if (answer.type === 'choice') {
    if (typeof answer.choice !== 'string') return { id, kind: 'not-an-answer', value: answer.choice };
    const entry = Array.isArray(answer.probabilities)
      ? answer.probabilities.find((item) => isObject(item) && item.value === answer.choice)
      : undefined;
    return {
      id,
      kind: 'Choice',
      value: answer.choice,
      ...(entry === undefined || entry.probability === undefined ? {} : { probability: entry.probability }),
      ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
    };
  }
  if (answer.type === 'predicate') return noulAnswer(id, answer.probability);
  return { id, kind: String(answer.type), value: undefined };
}

function usageCounters(usage) {
  if (usage === null || usage === undefined) return undefined;
  if (!isObject(usage)) return usage;
  return {
    ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
    ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
    ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
  };
}

/**
 * Translate a Decisions reply into the neutral reply body evaluateDecision
 * validates. Anything that is not the expected shape is passed on in a form
 * that validation rejects.
 */
export function neutralBody(reply) {
  if (!isObject(reply)) return reply;
  const { answers, model } = reply;
  const resolvedModel = { resolvedModel: typeof model === 'string' ? model : null };
  if (!Array.isArray(answers)) return { answers, ...resolvedModel };
  const usage = usageCounters(reply.usage);
  return { answers: answers.map(neutralAnswer), ...resolvedModel, ...(usage === undefined ? {} : { usage }) };
}

/**
 * @param {{ apiKey: string, fetch?: typeof fetch }} options
 * @returns {{ name: 'ai-gateway', exactModel: true, call: (request: object, options?: { signal?: AbortSignal }) => Promise<{ body: unknown } | { failure: string } | { rejected: string, dispatched?: false }> }}
 */
export function createAiGatewayProvider({ apiKey, fetch: fetchImpl = globalThis.fetch }) {
  assertApiKey(apiKey, 'the AI Gateway API key');
  return {
    name: 'ai-gateway',
    exactModel: true,
    async call(request, { signal } = {}) {
      let body;
      try {
        body = decisionsRequest(request);
      } catch (error) {
        if (error instanceof Unsupported) return { rejected: error.errorClass, dispatched: false };
        throw error;
      }
      return postJson({ fetchImpl, apiUrl: DEFAULT_API_URL, apiKey, signal }, body, neutralBody);
    },
  };
}
