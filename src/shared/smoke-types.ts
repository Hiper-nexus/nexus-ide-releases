export const FUNCTIONAL_SMOKE_MIN_ADAPTERS = 9;
export const FUNCTIONAL_SMOKE_MIN_TOOLS = 71;
export const FUNCTIONAL_SMOKE_FILE_CONTENT = 'nexus-functional-smoke\n';

export const FUNCTIONAL_SMOKE_REQUIRED_PROBES = [
  'workspace-open',
  'adapter-registry',
  'settings-ipc',
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
] as const;

export type FunctionalSmokeProbe = (typeof FUNCTIONAL_SMOKE_REQUIRED_PROBES)[number];

export interface FunctionalSmokeSuccess {
  ok: true;
  probes: FunctionalSmokeProbe[];
  adapterCount: number;
  toolCount: number;
}

export interface FunctionalSmokeFailure {
  ok: false;
  probes: FunctionalSmokeProbe[];
  failedProbe: FunctionalSmokeProbe;
}

export type FunctionalSmokeResult = FunctionalSmokeSuccess | FunctionalSmokeFailure;

const PROBE_SET = new Set<string>(FUNCTIONAL_SMOKE_REQUIRED_PROBES);
const SUCCESS_KEYS = new Set(['ok', 'probes', 'adapterCount', 'toolCount']);
const FAILURE_KEYS = new Set(['ok', 'probes', 'failedProbe']);

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
    if (!hasExactKeys(value, FAILURE_KEYS)) return null;
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
    };
  }

  return null;
}
