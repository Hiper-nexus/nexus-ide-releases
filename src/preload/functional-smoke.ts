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
  FUNCTIONAL_SMOKE_FILE_CONTENT,
  FUNCTIONAL_SMOKE_MIN_ADAPTERS,
  FUNCTIONAL_SMOKE_MIN_TOOLS,
  type FunctionalSmokeFailureReason,
  type FunctionalSmokeProbe,
  type FunctionalSmokeResult,
} from '../shared/smoke-types';
import { FEATURE_FLAG_IDS } from '../shared/feature-flags';
import { stripTerminalControlSequences } from '../shared/terminal-control-sequences';
import {
  missionReviewSchema,
  type MissionPrepareRequest,
  type MissionReview,
} from '../shared/mission-engine-contract';
// Máquina de estados PURA (sem DOM, sem timers, sem imports) — é justamente
// por isso que o binário empacotado consegue exercitá-la de dentro do preload
// e provar o contrato do Space no mesmo build que vai para o usuário.
import {
  HoldToTalkDiscriminator,
  type HoldToTalkOutcome,
} from '../renderer/voice/hold-to-talk';

interface HoldToTalkLike {
  keyDown(event: { readonly repeat: boolean }): HoldToTalkOutcome;
  thresholdElapsed(): HoldToTalkOutcome;
  keyUp(): HoldToTalkOutcome;
}

export {
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
/**
 * Sondas que esperam o ECO de um shell real (dictation-delivery e
 * dictation-hold-to-talk). Num Mac carregado (load > 6, dois lançamentos
 * consecutivos do app no gate de release) o shell demorou mais de 5 s para
 * ecoar e a sonda reprovava um artefato bom (0.76.36). A janela é generosa e
 * o prazo da sonda acompanha; o custo só existe quando o eco realmente atrasa.
 */
export const PTY_ECHO_WAIT_MS = 15_000;
const PTY_ECHO_POLL_MS = 100;
const PTY_ECHO_ATTEMPTS = PTY_ECHO_WAIT_MS / PTY_ECHO_POLL_MS;
export const DEFAULT_ECHO_PROBE_TIMEOUT_MS = 20_000;
const FUNCTIONAL_SMOKE_MISSION_REQUEST: MissionPrepareRequest = {
  objective:
    'Verify canonical mission preparation without starting any workers.',
  title: 'Functional smoke: canonical mission preparation',
  contextPaths: [],
  roster: [
    {
      id: 'functional-smoke-orchestrator',
      agentName: 'Functional Smoke Orchestrator',
      category: 'orchestrator',
      cli: 'codex',
      allowedSkills: [],
      allowedTools: [],
    },
    {
      id: 'functional-smoke-executor',
      agentName: 'Functional Smoke Executor',
      category: 'executor',
      cli: 'codex',
      allowedSkills: [],
      allowedTools: [],
    },
    {
      id: 'functional-smoke-reviewer',
      agentName: 'Functional Smoke Reviewer',
      category: 'reviewer',
      cli: 'codex',
      allowedSkills: [],
      allowedTools: [],
    },
  ],
  advanced: { lane: 'standard' },
};
const FUNCTIONAL_SMOKE_PERMISSION_IDS = [
  'workspace-read',
  'workspace-write',
  'local-commands',
] as const;
const REVIEW_SHA256_RE = /^[a-f0-9]{64}$/u;

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
  jev: {
    status(): Promise<unknown>;
  };
  mission: {
    prepare(request: MissionPrepareRequest): Promise<unknown>;
  };
  orch: {
    getMcpInfo(): Promise<McpInfo>;
    listMissions(): Promise<unknown[]>;
    listSquads(): Promise<unknown[]>;
    listMissionPanes(missionId: string): Promise<unknown[]>;
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
    onExit(
      sessionId: string,
      cb: (info: { exitCode: number; signal?: number }) => void,
    ): () => void;
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
  /** Prazo das sondas que esperam eco de PTY; em testes herda probeTimeoutMs. */
  echoProbeTimeoutMs?: number;
  /**
   * Test-only seam: injeta um discriminador quebrado para provar que a probe
   * REPROVA a regressão (uma probe que só passa não prova nada).
   */
  holdToTalkFactory?: () => HoldToTalkLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFunctionalSmokeReview(value: unknown): MissionReview | null {
  const parsed = missionReviewSchema.safeParse(value);
  if (!parsed.success) return null;
  const review = parsed.data;
  const expectedRoster = FUNCTIONAL_SMOKE_MISSION_REQUEST.roster;
  const hasExactRoster =
    review.roster.length === expectedRoster.length &&
    review.roster.every((agent, index) => {
      const expected = expectedRoster[index];
      return (
        expected !== undefined &&
        agent.id === expected.id &&
        agent.agentName === expected.agentName &&
        agent.category === expected.category &&
        agent.cli === expected.cli &&
        agent.providerId === expected.providerId &&
        agent.model === expected.model &&
        agent.effort === expected.effort &&
        agent.instructions === expected.instructions &&
        agent.ownsPlanDocs === expected.ownsPlanDocs &&
        agent.persona === expected.persona
        // Capacidade (skills/tools) é autoridade MAIN-owned desde d86637d9:
        // a política papel × objetivo × lane concede no prepare (inclusive
        // null/"ponytail" com lane standard) e o schema Zod do review já
        // valida a forma. O smoke valida a IDENTIDADE da equipe; exigir
        // listas vazias/array aqui era expectativa da era pré-concessão e
        // derrubava o gate de release ("mission-prepare", 22/08).
      );
    });
  if (
    review.title !== FUNCTIONAL_SMOKE_MISSION_REQUEST.title ||
    review.objective !== FUNCTIONAL_SMOKE_MISSION_REQUEST.objective ||
    review.contextPaths.length !==
      FUNCTIONAL_SMOKE_MISSION_REQUEST.contextPaths.length ||
    !review.contextPaths.every(
      (contextPath, index) =>
        contextPath === FUNCTIONAL_SMOKE_MISSION_REQUEST.contextPaths[index],
    ) ||
    !hasExactRoster ||
    review.attachments !== undefined ||
    !REVIEW_SHA256_RE.test(review.reviewSha256) ||
    review.permissions.length !== FUNCTIONAL_SMOKE_PERMISSION_IDS.length ||
    !FUNCTIONAL_SMOKE_PERMISSION_IDS.every((permissionId) =>
      review.permissions.some((permission) => permission.id === permissionId),
    )
  ) {
    return null;
  }
  return review;
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
  const echoTimeoutMs =
    deps.echoProbeTimeoutMs ??
    deps.probeTimeoutMs ??
    DEFAULT_ECHO_PROBE_TIMEOUT_MS;
  let adapterCount = 0;
  let toolCount = 0;

  const probe = async (
    name: FunctionalSmokeProbe,
    run: () => Promise<unknown>,
    validate: (value: unknown) => boolean = (value) => value !== undefined,
    deadlineMs: number = timeoutMs,
  ): Promise<boolean> => {
    try {
      const value = await withTimeout(run(), deadlineMs);
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

  // Canonical prepare must return the exact review fence without starting
  // workers or materializing a mission pane.
  if (
    !(await probe(
      'mission-prepare',
      async () => {
        const review = parseFunctionalSmokeReview(
          await api.mission.prepare(FUNCTIONAL_SMOKE_MISSION_REQUEST),
        );
        if (!review) return { review: null, panes: null };
        return {
          review,
          panes: await api.orch.listMissionPanes(review.missionId),
        };
      },
      (value) =>
        isRecord(value) &&
        isRecord(value.review) &&
        Array.isArray(value.panes) &&
        value.panes.length === 0,
    ))
  ) {
    return { ok: false, probes, failedProbe: 'mission-prepare' };
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
  /** O espaço do toque viaja entre estes dois tokens — nada de ' ' solto. */
  const TAP_SPACE_LEFT = 'nexus-tap';
  const TAP_SPACE_RIGHT = 'space-marker';
  let dictationEcho = '';
  const dictationCleanup: {
    sessionId: string | null;
    unsubscribe: (() => void) | null;
    unsubscribeExit: (() => void) | null;
    /** A sessão do shell morreu antes de a sonda terminar. */
    exited: boolean;
    /** Motivo fechado da falha, para o gate não ficar cego. */
    reason: FunctionalSmokeFailureReason | null;
  } = {
    sessionId: null,
    unsubscribe: null,
    unsubscribeExit: null,
    exited: false,
    reason: null,
  };
  const refusedReason = (): FunctionalSmokeFailureReason =>
    dictationCleanup.exited ? 'write-refused-exited' : 'write-refused-alive';
  const echoReason = (): FunctionalSmokeFailureReason =>
    dictationCleanup.exited ? 'echo-timeout-exited' : 'echo-timeout-alive';
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
            dictationCleanup.reason = 'spawn-failed';
            return false;
          }
          dictationCleanup.sessionId = spawned.sessionId;
          dictationCleanup.unsubscribeExit = api.pty.onExit(
            spawned.sessionId,
            () => {
              dictationCleanup.exited = true;
            },
          );
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
          if (!accepted) {
            dictationCleanup.reason = refusedReason();
            return false;
          }
          for (
            let attempt = 0;
            attempt < PTY_ECHO_ATTEMPTS &&
            !dictationEcho.includes(DICTATION_MARKER);
            attempt += 1
          ) {
            await delay(PTY_ECHO_POLL_MS);
          }
          const markerDelivered = dictationEcho.includes(DICTATION_MARKER);
          if (!markerDelivered) dictationCleanup.reason = echoReason();
          return markerDelivered;
        },
        (value) => value === true,
        echoTimeoutMs,
      ))
    ) {
      return {
        ok: false,
        probes,
        failedProbe: 'dictation-delivery',
        ...(dictationCleanup.reason ? { reason: dictationCleanup.reason } : {}),
      };
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

    // Space hold-to-talk (regressão v0.26.0): o ditado armava no próprio
    // keydown, então TODO espaço de digitação normal era roubado e o HUD
    // piscava. Esta probe fecha as duas metades no binário empacotado:
    // (a) o CONTRATO do discriminador — toque nunca arma e devolve o espaço,
    //     hold arma (mesmo com auto-repeat do SO no meio: com o keydown
    //     retido o repeat é suprimido, não digita nem vaza a tecla), e um
    //     toque jamais emite start+stop (o "pisca");
    // (b) a ENTREGA física — o espaço que o toque devolve é escrito num PTY
    //     real e ECOA de volta. Sem (b), a correção poderia "passar" enquanto
    //     engole a tecla, que é um sintoma pior que o bug original.
    if (
      !(await probe(
        'dictation-hold-to-talk',
        async () => {
          if (!dictationCleanup.sessionId) {
            dictationCleanup.reason = 'no-session';
            return false;
          }
          const make =
            deps.holdToTalkFactory ?? (() => new HoldToTalkDiscriminator());

          const tap = make();
          const tapDown = tap.keyDown({ repeat: false });
          const tapUp = tap.keyUp();
          const tapTypesSpace =
            tapDown.startDictation === false &&
            tapUp.startDictation === false &&
            tapUp.stopDictation === false &&
            tapDown.emitSpaces + tapUp.emitSpaces === 1;

          const hold = make();
          hold.keyDown({ repeat: false });
          const holdArms = hold.thresholdElapsed().startDictation === true;

          // Auto-repeat do SO com o keydown retido (hold-to-talk.ts, aa08c268c):
          // suprimido — não digita espaço, não vaza a tecla, não arma o ditado
          // antes do limiar nem cancela o hold; a decisão segue só pelo tempo.
          const repeating = make();
          repeating.keyDown({ repeat: false });
          const repeat = repeating.keyDown({ repeat: true });
          const repeatIsSuppressed =
            repeat.suppressKey === true &&
            repeat.emitSpaces === 0 &&
            repeat.startDictation === false;
          const holdArmsAfterRepeat =
            repeating.thresholdElapsed().startDictation === true;

          if (
            !tapTypesSpace ||
            !holdArms ||
            !repeatIsSuppressed ||
            !holdArmsAfterRepeat
          ) {
            dictationCleanup.reason = 'discriminator';
            return false;
          }

          // O espaço retido tem de CHEGAR ao pane, com recibo e eco. O espaço
          // viaja ENTRE dois tokens únicos: procurar por um ' ' solto no
          // scrollback daria falso-verde no primeiro repaint de prompt do
          // shell — a probe tem de provar que ESTE caractere sobreviveu.
          const before = dictationEcho.length;
          const typed = `${TAP_SPACE_LEFT} ${TAP_SPACE_RIGHT}`;
          const spaceDelivered = await api.pty.writeConfirmed(
            dictationCleanup.sessionId,
            typed,
          );
          if (!spaceDelivered) {
            dictationCleanup.reason = refusedReason();
            return false;
          }
          const echoed = (): boolean =>
            stripTerminalControlSequences(dictationEcho.slice(before))
              .replace(/\s+/gu, ' ')
              .includes(typed);
          for (
            let attempt = 0;
            attempt < PTY_ECHO_ATTEMPTS && !echoed();
            attempt += 1
          ) {
            await delay(PTY_ECHO_POLL_MS);
          }
          const spaceEchoed = echoed();
          if (!spaceEchoed) dictationCleanup.reason = echoReason();
          return spaceEchoed;
        },
        (value) => value === true,
        echoTimeoutMs,
      ))
    ) {
      return {
        ok: false,
        probes,
        failedProbe: 'dictation-hold-to-talk',
        ...(dictationCleanup.reason ? { reason: dictationCleanup.reason } : {}),
      };
    }
  } finally {
    if (dictationCleanup.unsubscribe) dictationCleanup.unsubscribe();
    if (dictationCleanup.unsubscribeExit) dictationCleanup.unsubscribeExit();
    if (dictationCleanup.sessionId) {
      const sessionId = dictationCleanup.sessionId;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribeExit();
          resolve();
        };
        const unsubscribeExit = api.pty.onExit(sessionId, () => finish());
        const timer = setTimeout(finish, 4_000);
        api.pty.kill(sessionId);
      });
    }
  }

  return { ok: true, probes, toolCount, adapterCount };
}

function smokeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, ' ').slice(0, 512);
}
