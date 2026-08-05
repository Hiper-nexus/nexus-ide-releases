/**
 * Packaged functional smoke probes.
 *
 * This module intentionally knows only a narrow, read-only slice of the
 * preload bridge. It runs inside preload after React mounts and proves that
 * the packaged renderer can cross real IPC handlers and the audited MCP
 * dispatch path. Results contain probe identifiers only, never provider
 * output, file content, tokens, or exception messages.
 */

import {
  FUNCTIONAL_SMOKE_ARM_SQUAD_ID,
  FUNCTIONAL_SMOKE_FILE_CONTENT,
  FUNCTIONAL_SMOKE_MIN_ADAPTERS,
  FUNCTIONAL_SMOKE_MIN_TOOLS,
  type FunctionalSmokeProbe,
  type FunctionalSmokeResult,
} from '../shared/smoke-types';
import { FEATURE_FLAG_IDS } from '../shared/feature-flags';

export {
  FUNCTIONAL_SMOKE_ARM_SQUAD_ID,
  FUNCTIONAL_SMOKE_FILE_CONTENT,
  FUNCTIONAL_SMOKE_MIN_ADAPTERS,
  FUNCTIONAL_SMOKE_MIN_TOOLS,
} from '../shared/smoke-types';

const MCP_POLL_ATTEMPTS = 80;
const MCP_POLL_DELAY_MS = 100;
// MCP bootstrap intentionally polls for up to eight seconds. Keep the generic
// probe deadline above that window so a healthy slow packaged launch cannot be
// rejected by the wrapper before the MCP-specific poll completes.
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

interface McpInfo {
  running: boolean;
  url: string | null;
  toolCount: number;
}

interface McpResult {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: string;
  denied?: boolean;
  requiredConfirmation?: boolean;
  effectMayHaveCommitted?: boolean;
}

const MISSING_EFFECT_AUTHORITY_ERROR =
  'mission effect blocked: projectId, checkoutId, missionId and contextRevision are required';

export interface FunctionalSmokeApi {
  workspace: {
    open(path: string): Promise<unknown>;
  };
  adapters: {
    list(): Promise<unknown[]>;
  };
  settings: {
    get(): Promise<unknown>;
    orchGet(): Promise<unknown>;
    audioGet(): Promise<unknown>;
    uiGet(): Promise<unknown>;
    listShells(): Promise<string[]>;
  };
  providers: {
    list(): Promise<unknown[]>;
  };
  voice: {
    getInfo(): Promise<unknown>;
  };
  orch: {
    getMcpInfo(): Promise<McpInfo>;
    listMissions(): Promise<unknown[]>;
    listSquads(): Promise<unknown[]>;
    listMissionPanes?(missionId: string): Promise<unknown[]>;
    /** Intent-first arm: awaiting_goal shell without orchestrator pane. */
    armMission(input: {
      title: string;
      squadId: string;
    }): Promise<unknown>;
    /** Lane do operador — deve RECUSAR sessões sem vínculo de missão. */
    sendPaneOperatorInput(input: {
      sessionId: string;
      data: string;
    }): Promise<boolean>;
  };
  pty: {
    spawn(req: {
      cwd?: string;
      cols: number;
      rows: number;
      kind: 'shell';
    }): Promise<unknown>;
    writeConfirmed(sessionId: string, data: string): Promise<boolean>;
    kill(sessionId: string): void;
    onData(sessionId: string, cb: (data: string) => void): () => void;
  };
  mcp: {
    invoke(tool: string, args?: Record<string, unknown>): Promise<McpResult>;
  };
  media: {
    listProviders(): Promise<unknown[]>;
  };
  perf: {
    snapshot(): Promise<unknown>;
  };
  update: {
    getState(): Promise<unknown>;
  };
  product: {
    flagsList(): Promise<
      Array<{
        id: string;
        enabled: boolean;
        reason: string;
        definition: unknown;
      }>
    >;
    searchQuery(input: {
      text: string;
      limit?: number;
    }): Promise<unknown>;
  };
}

interface FunctionalSmokeDeps {
  delay?: (ms: number) => Promise<void>;
  probeTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasLoopbackMcpUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]') &&
      url.pathname === '/mcp' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function mcpSucceeded(value: unknown, tool: string): value is McpResult {
  return isRecord(value) && value.ok === true && value.tool === tool;
}

async function defaultDelay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('probe_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForMcp(
  api: FunctionalSmokeApi,
  delay: (ms: number) => Promise<void>,
): Promise<McpInfo> {
  for (let attempt = 0; attempt < MCP_POLL_ATTEMPTS; attempt += 1) {
    const info = await api.orch.getMcpInfo();
    if (info.running) return info;
    await delay(MCP_POLL_DELAY_MS);
  }
  return api.orch.getMcpInfo();
}

export async function runFunctionalSmokeProbes(
  api: FunctionalSmokeApi,
  workspacePath: string,
  deps: FunctionalSmokeDeps = {},
): Promise<FunctionalSmokeResult> {
  const probes: FunctionalSmokeProbe[] = [];
  const delay = deps.delay ?? defaultDelay;
  const timeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let adapterCount = 0;
  let toolCount = 0;

  const probe = async (
    name: FunctionalSmokeProbe,
    run: () => Promise<unknown>,
    validate: (value: unknown) => boolean = (value) => value !== undefined,
  ): Promise<boolean> => {
    try {
      const value = await withTimeout(run(), timeoutMs);
      if (!validate(value)) return false;
      probes.push(name);
      return true;
    } catch (error) {
      console.error(
        `[smoke] probe ${name} failed: ${smokeErrorMessage(error)}`,
      );
      return false;
    }
  };

  if (
    !(await probe(
      'workspace-open',
      () => api.workspace.open(workspacePath),
      (value) =>
        isRecord(value) &&
        isRecord(value.current) &&
        value.current.path === workspacePath,
    ))
  ) {
    return { ok: false, probes, failedProbe: 'workspace-open' };
  }

  if (
    !(await probe(
      'adapter-registry',
      async () => {
        const adapters = await api.adapters.list();
        adapterCount = adapters.length;
        return adapters;
      },
      (value) => Array.isArray(value) && value.length >= FUNCTIONAL_SMOKE_MIN_ADAPTERS,
    ))
  ) {
    return { ok: false, probes, failedProbe: 'adapter-registry' };
  }

  if (
    !(await probe(
      'settings-ipc',
      async () =>
        Promise.all([
          api.settings.get(),
          api.settings.orchGet(),
          api.settings.audioGet(),
          api.settings.uiGet(),
          api.settings.listShells(),
        ]),
      (value) =>
        Array.isArray(value) &&
        value.length === 5 &&
        Array.isArray(value[4]) &&
        value[4].length > 0,
    ))
  ) {
    return { ok: false, probes, failedProbe: 'settings-ipc' };
  }

  // Intent-first must be the default product path (explicit false = legacy kickoff).
  if (
    !(await probe(
      'intent-first-settings',
      () => api.settings.orchGet(),
      (value) =>
        isRecord(value) && value.intentFirstMissionRuntimeV1 !== false,
    ))
  ) {
    return { ok: false, probes, failedProbe: 'intent-first-settings' };
  }

  // Arm creates awaiting_goal without binding an orchestrator session or panes.
  if (
    !(await probe(
      'intent-arm',
      async () => {
        const mission = await api.orch.armMission({
          title: 'Smoke intent arm',
          squadId: FUNCTIONAL_SMOKE_ARM_SQUAD_ID,
        });
        if (!isRecord(mission) || typeof mission.id !== 'string') {
          return { ok: false };
        }
        const panes =
          typeof api.orch.listMissionPanes === 'function'
            ? await api.orch.listMissionPanes(mission.id)
            : [];
        return { mission, panes };
      },
      (value) =>
        isRecord(value) &&
        isRecord(value.mission) &&
        value.mission.intentState === 'awaiting_goal' &&
        value.mission.orchestratorSessionId == null &&
        value.mission.status !== 'running' &&
        Array.isArray(value.panes) &&
        value.panes.length === 0,
    ))
  ) {
    return { ok: false, probes, failedProbe: 'intent-arm' };
  }

  // Product flags are enumerable and each definition exposes killSwitch authority.
  if (
    !(await probe(
      'product-flags',
      () => api.product.flagsList(),
      (value) => {
        if (!Array.isArray(value) || value.length < 5) return false;
        const required = new Set<string>([
          FEATURE_FLAG_IDS.searchMixer,
          FEATURE_FLAG_IDS.missionEventJournal,
          FEATURE_FLAG_IDS.mcpHub,
          FEATURE_FLAG_IDS.nexusMemory,
          FEATURE_FLAG_IDS.skillsCatalog,
        ]);
        let found = 0;
        for (const entry of value) {
          if (!isRecord(entry) || typeof entry.id !== 'string') return false;
          if (!isRecord(entry.definition)) return false;
          if (typeof entry.definition.killSwitch !== 'boolean') return false;
          if (typeof entry.enabled !== 'boolean') return false;
          if (required.has(entry.id)) found += 1;
        }
        return found === required.size;
      },
    ))
  ) {
    return { ok: false, probes, failedProbe: 'product-flags' };
  }

  // SearchMixer IPC returns a bounded envelope (empty hits OK; shape is the contract).
  if (
    !(await probe(
      'search-mixer-ipc',
      () => api.product.searchQuery({ text: 'smoke', limit: 5 }),
      (value) =>
        isRecord(value) &&
        typeof value.generation === 'number' &&
        Number.isFinite(value.generation) &&
        Array.isArray(value.hits) &&
        typeof value.partial === 'boolean',
    ))
  ) {
    return { ok: false, probes, failedProbe: 'search-mixer-ipc' };
  }

  const readOnlyProbes: Array<
    [FunctionalSmokeProbe, () => Promise<unknown>, (value: unknown) => boolean]
  > = [
    ['provider-registry', () => api.providers.list(), Array.isArray],
    ['voice-runtime', () => api.voice.getInfo(), isRecord],
    [
      'orchestration-state',
      async () => Promise.all([api.orch.listMissions(), api.orch.listSquads()]),
      (value) => Array.isArray(value) && value.every(Array.isArray),
    ],
    ['media-registry', () => api.media.listProviders(), Array.isArray],
    ['perf-ipc', () => api.perf.snapshot(), isRecord],
    ['updater-ipc', () => api.update.getState(), isRecord],
  ];
  for (const [name, run, validate] of readOnlyProbes) {
    if (!(await probe(name, run, validate))) {
      return { ok: false, probes, failedProbe: name };
    }
  }

  if (
    !(await probe(
      'embedded-mcp',
      async () => {
        const info = await waitForMcp(api, delay);
        toolCount = info.toolCount;
        return info;
      },
      (value) =>
        isRecord(value) &&
        value.running === true &&
        typeof value.url === 'string' &&
        hasLoopbackMcpUrl(value.url) &&
        typeof value.toolCount === 'number' &&
        value.toolCount >= FUNCTIONAL_SMOKE_MIN_TOOLS,
    ))
  ) {
    return { ok: false, probes, failedProbe: 'embedded-mcp' };
  }

  const mcpProbes: Array<
    [FunctionalSmokeProbe, string, Record<string, unknown>, (value: unknown) => boolean]
  > = [
    ['mcp-perf', 'nexus_perf_snapshot', {}, (value) => mcpSucceeded(value, 'nexus_perf_snapshot')],
    ['mcp-pane-list', 'nexus_pane_list', {}, (value) => mcpSucceeded(value, 'nexus_pane_list')],
    [
      'mcp-media-providers',
      'nexus_media_providers',
      {},
      (value) => mcpSucceeded(value, 'nexus_media_providers'),
    ],
    [
      'mcp-ui-read',
      'nexus_ui_read',
      {},
      (value) =>
        mcpSucceeded(value, 'nexus_ui_read') &&
        isRecord(value.result) &&
        value.result.surface === 'nexus-ui',
    ],
    [
      'mcp-file-read',
      'nexus_file_read',
      { path: 'smoke.txt' },
      (value) =>
        mcpSucceeded(value, 'nexus_file_read') &&
        isRecord(value.result) &&
        value.result.content === FUNCTIONAL_SMOKE_FILE_CONTENT,
    ],
    [
      'mcp-write-guard',
      'nexus_file_write',
      { path: 'must-not-exist.txt', content: 'blocked' },
      (value) =>
        isRecord(value) &&
        value.ok === false &&
        value.tool === 'nexus_file_write' &&
        value.effectMayHaveCommitted !== true &&
        (value.requiredConfirmation === true ||
          (value.denied === true &&
            value.error === MISSING_EFFECT_AUTHORITY_ERROR)),
    ],
  ];
  for (const [name, tool, args, validate] of mcpProbes) {
    if (!(await probe(name, () => api.mcp.invoke(tool, args), validate))) {
      return { ok: false, probes, failedProbe: name };
    }
  }

  // Ditado (regressão v0.25.1/v0.26.0): prova as DUAS lanes de entrega com
  // recibo real no binário empacotado — voz nunca mais shipada na fé.
  // Lane terminal: PTY real recebe e ECOA o texto (recibo ponta a ponta).
  // Lane do operador + sessão fantasma: as recusas de autoridade continuam
  // vivas (sem false-green) — é a fronteira que o fix 61f91fb1 contorna
  // legitimamente via missão governada.
  const DICTATION_MARKER = 'nexus-dictation-smoke-marker';
  let dictationEcho = '';
  const dictationCleanup: {
    sessionId: string | null;
    unsubscribe: (() => void) | null;
  } = { sessionId: null, unsubscribe: null };
  try {
    if (
      !(await probe(
        'dictation-delivery',
        async () => {
          const spawned = await api.pty.spawn({
            cwd: workspacePath,
            cols: 80,
            rows: 24,
            kind: 'shell',
          });
          if (
            !isRecord(spawned) ||
            spawned.ok !== true ||
            typeof spawned.sessionId !== 'string'
          ) {
            return false;
          }
          dictationCleanup.sessionId = spawned.sessionId;
          dictationCleanup.unsubscribe = api.pty.onData(
            spawned.sessionId,
            (data) => {
              dictationEcho += data;
            },
          );
          const accepted = await api.pty.writeConfirmed(
            spawned.sessionId,
            DICTATION_MARKER,
          );
          if (!accepted) return false;
          for (
            let attempt = 0;
            attempt < 50 && !dictationEcho.includes(DICTATION_MARKER);
            attempt += 1
          ) {
            await delay(100);
          }
          return dictationEcho.includes(DICTATION_MARKER);
        },
        (value) => value === true,
      ))
    ) {
      return { ok: false, probes, failedProbe: 'dictation-delivery' };
    }

    if (
      !(await probe(
        'dictation-governed-lane',
        async () => {
          if (!dictationCleanup.sessionId) return false;
          const operatorDenied = await api.orch.sendPaneOperatorInput({
            sessionId: dictationCleanup.sessionId,
            data: 'nexus-smoke',
          });
          const ghostDenied = await api.pty.writeConfirmed(
            'pty-ghost-nexus-smoke',
            'x',
          );
          return operatorDenied === false && ghostDenied === false;
        },
        (value) => value === true,
      ))
    ) {
      return { ok: false, probes, failedProbe: 'dictation-governed-lane' };
    }
  } finally {
    if (dictationCleanup.unsubscribe) dictationCleanup.unsubscribe();
    if (dictationCleanup.sessionId) api.pty.kill(dictationCleanup.sessionId);
  }

  return { ok: true, probes, toolCount, adapterCount };
}

function smokeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, ' ').slice(0, 512);
}
