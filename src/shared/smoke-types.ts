export const FUNCTIONAL_SMOKE_MIN_ADAPTERS = 9;
export const FUNCTIONAL_SMOKE_MIN_TOOLS = 71;
export const FUNCTIONAL_SMOKE_FILE_CONTENT = 'nexus-functional-smoke\n';

export const FUNCTIONAL_SMOKE_REQUIRED_PROBES = [
  'workspace-open',
  'adapter-registry',
  'settings-ipc',
  'mission-prepare',
  'product-flags',
  'search-mixer-ipc',
  'provider-registry',
  'voice-runtime',
  'orchestration-state',
  'media-registry',
  'perf-ipc',
  'updater-ipc',
  'embedded-mcp',
  'mcp-perf',
  'mcp-pane-list',
  'mcp-media-providers',
  'mcp-ui-read',
  'mcp-file-read',
  'mcp-write-guard',
  'dictation-delivery',
  'dictation-governed-lane',
  'dictation-hold-to-talk',
] as const;

export type FunctionalSmokeProbe = (typeof FUNCTIONAL_SMOKE_REQUIRED_PROBES)[number];

export interface FunctionalSmokeSuccess {
  ok: true;
  probes: FunctionalSmokeProbe[];
  adapterCount: number;
  toolCount: number;
}

/**
 * Motivo FECHADO de falha dentro de uma sonda (sem texto livre: o relatório do
 * renderer nunca pode contrabandear log). Diz ao gate o que falhou de fato —
 * na 0.76.36 o gate só dizia "dictation-hold-to-talk" e a causa ficou opaca.
 */
export const FUNCTIONAL_SMOKE_FAILURE_REASONS = [
  'discriminator',
  'no-session',
  'spawn-failed',
  'write-refused-alive',
  'write-refused-exited',
  'echo-timeout-alive',
  'echo-timeout-exited',
] as const;

export type FunctionalSmokeFailureReason =
  (typeof FUNCTIONAL_SMOKE_FAILURE_REASONS)[number];

export interface FunctionalSmokeFailure {
  ok: false;
  probes: FunctionalSmokeProbe[];
  failedProbe: FunctionalSmokeProbe;
  reason?: FunctionalSmokeFailureReason;
}

export type FunctionalSmokeResult = FunctionalSmokeSuccess | FunctionalSmokeFailure;

const PROBE_SET = new Set<string>(FUNCTIONAL_SMOKE_REQUIRED_PROBES);
const SUCCESS_KEYS = new Set(['ok', 'probes', 'adapterCount', 'toolCount']);
const FAILURE_KEYS = new Set(['ok', 'probes', 'failedProbe']);
const FAILURE_KEYS_WITH_REASON = new Set([...FAILURE_KEYS, 'reason']);
const REASON_SET = new Set<string>(FUNCTIONAL_SMOKE_FAILURE_REASONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function parseProbes(value: unknown): FunctionalSmokeProbe[] | null {
  if (!Array.isArray(value) || value.length > FUNCTIONAL_SMOKE_REQUIRED_PROBES.length) {
    return null;
  }
  if (!value.every((entry) => typeof entry === 'string' && PROBE_SET.has(entry))) {
    return null;
  }
  const probes = value as FunctionalSmokeProbe[];
  return new Set(probes).size === probes.length ? [...probes] : null;
}

export function parseFunctionalSmokeResult(value: unknown): FunctionalSmokeResult | null {
  if (!isRecord(value)) return null;
  const probes = parseProbes(value.probes);
  if (!probes) return null;

  if (value.ok === true) {
    if (!hasExactKeys(value, SUCCESS_KEYS)) return null;
    if (
      probes.length !== FUNCTIONAL_SMOKE_REQUIRED_PROBES.length ||
      !FUNCTIONAL_SMOKE_REQUIRED_PROBES.every((probe) => probes.includes(probe)) ||
      !Number.isSafeInteger(value.adapterCount) ||
      (value.adapterCount as number) < FUNCTIONAL_SMOKE_MIN_ADAPTERS ||
      !Number.isSafeInteger(value.toolCount) ||
      (value.toolCount as number) < FUNCTIONAL_SMOKE_MIN_TOOLS
    ) {
      return null;
    }
    return {
      ok: true,
      probes,
      adapterCount: value.adapterCount as number,
      toolCount: value.toolCount as number,
    };
  }

  if (value.ok === false) {
    const withReason = 'reason' in value;
    if (!hasExactKeys(value, withReason ? FAILURE_KEYS_WITH_REASON : FAILURE_KEYS)) {
      return null;
    }
    if (
      withReason &&
      (typeof value.reason !== 'string' || !REASON_SET.has(value.reason))
    ) {
      return null;
    }
    if (
      typeof value.failedProbe !== 'string' ||
      !PROBE_SET.has(value.failedProbe) ||
      probes.includes(value.failedProbe as FunctionalSmokeProbe)
    ) {
      return null;
    }
    return {
      ok: false,
      probes,
      failedProbe: value.failedProbe as FunctionalSmokeProbe,
      ...(withReason
        ? { reason: value.reason as FunctionalSmokeFailureReason }
        : {}),
    };
  }

  return null;
}
