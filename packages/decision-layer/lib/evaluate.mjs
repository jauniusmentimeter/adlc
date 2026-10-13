// One shadow evaluation: load the pack, collect and sanitize inputs, ask the
// provider, reduce, and record. The answers never change the exit code: 0 when
// the run was recorded, 1 when it failed before dispatch or was not recorded.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, GitOutputError, RecordError } from './errors.mjs';
import { diffStats, mainCheckoutRoot, projectRoot, resolveRevision, ticketFacts } from './inputs.mjs';
import { aiGatewayUnsupported, createAiGatewayProvider } from './adapters/ai-gateway.mjs';
import { createJevProvider, jevUnsupported } from './adapters/jev.mjs';
import { createMockProvider } from './mock-provider.mjs';
import { PackError, loadPack } from './pack.mjs';
import { evaluateDecision } from './provider.mjs';
import { RECORD_SCHEMA_VERSION, appendRecord, recordPath } from './record.mjs';
import { reduce } from './reducer.mjs';
import { SanitizationError, sanitize } from './sanitizer.mjs';

const EXPECTED_FAILURES = [ConfigError, GitOutputError, PackError, SanitizationError, RecordError];

function readMockResponse(cwd, file) {
  if (file === null) return undefined;
  try {
    return readFileSync(resolve(cwd, file), 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read --mock-response ${file}: ${error.message}`);
  }
}

/** The Jev provider's key and endpoint: TYPESAFE_API_KEY, else JEV_API_KEY; the checked URL from config. */
export function jevOptions(config, env) {
  return { apiKey: env.TYPESAFE_API_KEY || env.JEV_API_KEY, apiUrl: config.apiUrl };
}

/** The AI Gateway provider's key: AI_GATEWAY_API_KEY only. Its endpoint is fixed. */
export function aiGatewayOptions(env) {
  return { apiKey: env.AI_GATEWAY_API_KEY };
}

/** Why a remote provider cannot ask a pack, by provider; mock can ask any pack. */
const UNSUPPORTED = { jev: jevUnsupported, 'ai-gateway': aiGatewayUnsupported };
const QUESTION_LIMITS = {
  jev: 'it supports only Choice and Noul questions',
  'ai-gateway': 'it supports only Choice and Noul questions, and at most 255 choices',
};

/** The provider a validated config names; a key that is absent or unusable here is a ConfigError. */
export function providerFor(config, env, responseText) {
  try {
    if (config.provider === 'jev') return createJevProvider(jevOptions(config, env));
    if (config.provider === 'ai-gateway') return createAiGatewayProvider(aiGatewayOptions(env));
  } catch (error) {
    throw new ConfigError(error.message);
  }
  return createMockProvider({ responseText });
}

async function shadowRun(config, { cwd, env, retryDelayMs, now }) {
  const root = projectRoot(cwd);
  const mainRoot = mainCheckoutRoot(cwd);
  const ticket = ticketFacts(root, config.ticket);
  const responseText = readMockResponse(cwd, config.mockResponse);
  const pack = loadPack(config.pack, { projectRoot: root });
  const unsupported = UNSUPPORTED[config.provider]?.(pack) ?? null;
  if (unsupported === 'unsupported-question') throw new ConfigError(`--provider ${config.provider} cannot ask pack ${pack.id}: ${QUESTION_LIMITS[config.provider]}`);
  if (unsupported === 'unsupported-pack') throw new ConfigError(`--provider ${config.provider} cannot ask pack ${pack.id}: every question must declare the same inputs`);
  const revision = resolveRevision(root, config.revision);
  const { sanitizedInput, inputHash } = sanitize({ ...diffStats(root, revision), ...ticket }, pack);

  const result = await evaluateDecision({
    provider: providerFor(config, env, responseText),
    model: config.model,
    pack,
    sanitizedInput,
    revision,
    retryDelayMs,
  });
  const { outcome, wouldAct } = reduce({ status: result.status, answers: result.answers, pack });
  const record = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordedAt: now().toISOString(),
    revision,
    provider: config.provider,
    requestedModel: result.requestedModel,
    resolvedModel: result.resolvedModel,
    packId: pack.id,
    packHash: result.packHash,
    inputHash,
    ticketId: config.ticket,
    prNumber: config.pr,
    answers: result.answers,
    outcome,
    wouldAct,
    status: result.status,
    errorClass: result.errorClass,
    attemptCount: result.attemptCount,
    latencyMs: result.latencyMs,
    usage: result.usage,
  };
  appendRecord(mainRoot, record);
  return { exitCode: 0, record, path: recordPath(mainRoot) };
}

/**
 * @param {{ mode: string } & Record<string, unknown>} config output of validateConfig
 * @param {{ cwd: string, env?: Record<string, string|undefined>, retryDelayMs?: number, now?: () => Date }} context
 * @returns {Promise<{ exitCode: 0|1, record?: object, path?: string, error?: Error }>}
 */
export async function runEvaluate(config, { cwd, env = {}, retryDelayMs, now = () => new Date() }) {
  if (config.mode === 'off') return { exitCode: 0 };
  try {
    return await shadowRun(config, { cwd, env, retryDelayMs, now });
  } catch (error) {
    if (EXPECTED_FAILURES.some((type) => error instanceof type)) return { exitCode: 1, error };
    throw error;
  }
}
