/**
 * F-775 item 2: quando TODAS as contas da CLI esgotam, o trabalho continua em
 * OUTRA CLI elegível, sozinho — no pane do operador ("+ Pane") no lugar, com
 * aviso; na tarefa de missão por um pane novo na rota do spawn. A CLI vem do
 * roteador, a esgotada não volta antes de liberar e cada tarefa troca no
 * máximo 3 vezes.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { ProviderQuotaEntry } from '../../shared/quota-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { ACCOUNT_CHANNELS, type FailoverEvent } from '../../shared/account-types';
import { FAILOVER_HANDOFF_HEADER } from '../../shared/failover-handoff';
import { testProjectScope } from './__tests__/scope-fixture';
import { inFlightRequestOf, noteInFlightRequest, resetInFlightRequestsForTests } from './in-flight-request';
import { dotenvDump, expectNoSecretFragment, hardWrap } from '../../shared/__tests__/synthetic-secrets';

const h = vi.hoisted(() => ({
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  sessions: new Map<string, Record<string, unknown>>(),
  states: new Map<string, string>(),
  authorities: new Map<string, unknown>(),
  panes: new Map<string, unknown>(),
  runtime: new Map<string, unknown>(),
  requestPaneClose: vi.fn(async (_paneId: string, _sessionId?: string) => true),
  respawnMainOwned: vi.fn(async (_input: Record<string, unknown>) => true),
  submit: vi.fn((input: Record<string, unknown>) => ({ id: 'handoff-1', ...input })),
  onHandoffSubmitted: vi.fn(),
  trace: vi.fn(),
  available: new Set<string>(),
  longNeedsApi: false,
  realQuota: false,
  quotaEntry: undefined as ProviderQuotaEntry | undefined,
  probeEntry: undefined as ProviderQuotaEntry | undefined,
  refreshQuota: vi.fn(),
  sessionOutput: '$ npm test\n✓ 12 passed\nYou exceeded your current quota',
  /** F-1471: status da missão no store (ausente = a missão não é dona do pane). */
  missionStatus: undefined as string | undefined,
  /** F-1473: a conversa do pane foi religada à conta irmã (histórico compartilhado). */
  rebind: vi.fn((..._args: unknown[]) => false),
  /** F-1473: o pane retomado sobreviveu ao boot. */
  resumeBootOk: vi.fn(async (_target: { paneId?: string; sessionId?: string }): Promise<'proved' | 'failed' | 'closed'> => 'proved'),
  resumeBootDispose: vi.fn(),
  /** F-1486: o store da missão fora do ar (a leitura lança). */
  missionsThrow: false,
}));

vi.mock('../pty/pty-analysis-runtime', async () => {
  const { failoverAnalysisFixture } = await import('../pty/__tests__/failover-analysis-fixture');
  return failoverAnalysisFixture(h.dataTaps);
});

vi.mock('../pty/pty-manager', () => ({
  tapSessionData: vi.fn((tap: (sessionId: string, data: string) => void) => {
    h.dataTaps.push(tap);
    return () => h.dataTaps.splice(h.dataTaps.indexOf(tap), 1);
  }),
  tapSessionExit: vi.fn(() => () => undefined),
  getAgentSessionInfo: vi.fn((sessionId: string) => h.sessions.get(sessionId) ?? null),
  getSessionState: vi.fn((sessionId: string) => h.states.get(sessionId) ?? null),
  listAgentSessionsForPane: vi.fn((paneId: string) =>
    [...h.sessions.values()].filter((session) => session.paneId === paneId),
  ),
}));
vi.mock('./pane-registry', () => ({
  stripAnsi: (data: string) => data,
  getOwnedPaneAuthzInfoBySession: vi.fn((ref: string) => h.authorities.get(ref) ?? null),
  getPaneRuntimeAuthorityBySession: vi.fn((ref: string) => h.runtime.get(ref) ?? null),
  findPaneBySessionOwnedBy: vi.fn((_owner: WebContents, ref: string) => h.panes.get(ref) ?? null),
  readSessionOutput: vi.fn(() => h.sessionOutput),
  requestPaneClose: h.requestPaneClose,
}));
vi.mock('./tool-util', () => ({ injectPrompt: vi.fn() }));
vi.mock('../observability/main-trace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../observability/main-trace')>()),
  trace: h.trace,
}));
const HITS: Record<string, { kind: 'quota' | 'rate-limit' | 'auth'; reason: string; cooldownMs: number; adapterId?: string; confirmed?: boolean }> = {
  // F-1410: célula de status do Muse (confirmada pela posição) e a mesma frase solta.
  MUSE_CELL: { kind: 'rate-limit', reason: 'muse-spark-1.3 · medium · Usage limit reached', cooldownMs: 5 * 60 * 60_000, adapterId: 'muse', confirmed: true },
  MUSE_TEXT: { kind: 'rate-limit', reason: 'Usage limit reached', cooldownMs: 5 * 60 * 60_000 },
  QUOTA: { kind: 'quota', reason: 'You exceeded your current quota', cooldownMs: 12 * 60 * 60_000 },
  SHORT: { kind: 'rate-limit', reason: 'rate limit — try again in 1 minute', cooldownMs: 60_000 },
  AUTH: { kind: 'auth', reason: '401 OAuth access token has expired', cooldownMs: 15 * 60_000 },
  LONG: { kind: 'rate-limit', reason: "You've hit your session limit", cooldownMs: 5 * 60 * 60_000 },
  HOUR: { kind: 'rate-limit', reason: 'Error: 429 Too Many Requests', cooldownMs: 60 * 60_000 },
  // F-999: formato que as máscaras antigas não cobriam (o motivo vai na 2ª linha do pack).
  INSQ: { kind: 'quota', reason: 'insufficient_quota', cooldownMs: 12 * 60 * 60_000 },
};
vi.mock('./limit-detector', () => ({
  detectLimit: vi.fn((buffer: string) => {
    const marker = Object.keys(HITS).find((key) => buffer.includes(key));
    return marker ? HITS[marker] : null;
  }),
  tierScopeFromModelId: vi.fn(() => undefined),
}));
vi.mock('./limit-refutation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./limit-refutation')>();
  return {
    ...actual,
    providerApiRefutesLimit: vi.fn((...args: Parameters<typeof actual.providerApiRefutesLimit>) =>
      h.realQuota ? actual.providerApiRefutesLimit(...args) : false),
    hasFreshProviderApiWindowForLimit: vi.fn((...args: Parameters<typeof actual.hasFreshProviderApiWindowForLimit>) =>
      h.realQuota ? actual.hasFreshProviderApiWindowForLimit(...args) : false),
    longCooldownNeedsFreshProviderApi: vi.fn((...args: Parameters<typeof actual.longCooldownNeedsFreshProviderApi>) =>
      h.realQuota ? actual.longCooldownNeedsFreshProviderApi(...args) : h.longNeedsApi),
  };
});
const ACCOUNTS: Record<string, { id: string; adapterId: string; label: string; mode: 'subscription'; upstream: string; createdAt: number }> = {
  'claude-a': { id: 'claude-a', adapterId: 'claude', label: 'gustavo@example.com', mode: 'subscription', upstream: 'anthropic', createdAt: 0 },
  'codex-a': { id: 'codex-a', adapterId: 'codex', label: 'ana@example.org', mode: 'subscription', upstream: 'openai', createdAt: 0 },
  // F-1471: a conta irmã da MESMA CLI (só os testes do F-1471 a oferecem).
  'claude-b': { id: 'claude-b', adapterId: 'claude', label: 'maria@example.com', mode: 'subscription', upstream: 'anthropic', createdAt: 1 },
};
vi.mock('../persistence/account-store', () => ({
  getAccount: vi.fn((id: string) => ACCOUNTS[id] ?? null),
  getActiveAccount: vi.fn((adapterId: string) =>
    Object.values(ACCOUNTS).find((account) => account.adapterId === adapterId) ?? null,
  ),
  hasAvailableAccount: vi.fn((adapterId: string) => h.available.has(adapterId)),
  // Todas as contas da CLI atual esgotadas: nenhuma irmã livre.
  pickAvailableForFailover: vi.fn(() => ({ account: null, probe: false })),
  adoptNativeAccountForFailover: vi.fn(() => null),
  ensureFreshClaudeSubscription: vi.fn(async () => false),
  isAccountBlockedForScope: vi.fn(() => false),
  setCooldown: vi.fn(),
  clearCooldown: vi.fn(),
  prepareAccountForSpawn: vi.fn(() => ({ ok: false, error: 'not in test' })),
  verifyManagedClaudeAccountForSpawn: vi.fn(async () => 'match'),
}));
vi.mock('../quota/quota-service', () => ({
  noteQuotaLimitHit: vi.fn(),
  requireQuotaService: vi.fn(() => {
    if (!h.realQuota) throw new Error('quota optional in test');
    return {
      lastSnapshot: () => h.quotaEntry ? { entries: [h.quotaEntry] } : undefined,
      refreshForLimitHit: async () => { h.refreshQuota(); h.quotaEntry = h.probeEntry; },
    };
  }),
}));
vi.mock('../persistence/provider-session-store', () => ({
  rebindProviderPaneSessionAccount: h.rebind,
}));
vi.mock('./failover-mission-respawn', () => ({
  respawnMainOwnedPaneWithAccount: h.respawnMainOwned,
  observeResumeBoot: vi.fn(() => ({ confirm: h.resumeBootOk, dispose: h.resumeBootDispose })),
  collectGitTaskState: vi.fn(async () => ({
    touchedFiles: ['src/login.ts'],
    diffStat: 'src/login.ts | 4 ++--',
  })),
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    handoffs: { submit: h.submit },
    missions: {
      get: () => {
        if (h.missionsThrow) throw new Error('store da missão fora do ar');
        return { id: 'mission-1', orchestratorSessionId: 'session-maestro', status: h.missionStatus };
      },
    },
  }),
}));
vi.mock('./idle-delivery', () => ({ onHandoffSubmitted: h.onHandoffSubmitted }));
vi.mock('../adapters/adapter-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/adapter-registry')>()),
  getAdapter: vi.fn((id: string) => {
    const label = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', grok: 'Grok', muse: 'Muse Code' }[id];
    return label ? { id, label, models: { default: 'm', list: ['m'] } } : null;
  }),
  getAdapterResolvedBin: vi.fn(() => null),
}));

import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import {
  hasPendingFailoverRecovery,
  initFailover,
  registerFailoverListener,
  shutdownFailover,
  unregisterFailoverListener,
} from './failover';
import {
  registerPaneTaskReroute,
  resetPaneTaskReroutesForTests,
  setNextCliResolver,
  type NextCliResolver,
  type PaneTaskRerouteHandle,
} from './pane-task-reroute';
import {
  getPaneStartWatch,
  listConfirmedPaneLimits,
  resetPaneStartWatchdogForTests,
  trackPaneStart,
} from './pane-start-watchdog';
import { activeCliLimit, isCliLimited, resetCliLimits } from './cli-limit-registry';
import {
  pickAvailableForFailover,
  prepareAccountForSpawn,
  verifyManagedClaudeAccountForSpawn,
} from '../persistence/account-store';

type Renderer = WebContents & EventEmitter & { send: ReturnType<typeof vi.fn> };

function renderer(id: number): Renderer {
  const events = new EventEmitter() as Renderer;
  Object.assign(events, { id, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() });
  return events;
}

const SCOPE: ProjectExecutionScope = testProjectScope();
let owner: Renderer;
const resolver = vi.fn<NextCliResolver>(async () => ({ adapterId: 'codex', model: 'gpt-6.1-sol' }));

/** Pane no renderer: o do operador ("+ Pane", sem missão) ou worker de missão. */
function rendererPane(input: {
  paneId: string;
  sessionId: string;
  adapterId?: string;
  accountId?: string;
  missionId?: string;
  title?: string;
}): void {
  const adapterId = input.adapterId ?? 'claude';
  const pane = {
    paneId: input.paneId,
    sessionId: input.sessionId,
    kind: 'cli-agent',
    adapterId,
    accountId: input.accountId ?? 'claude-a',
  };
  h.panes.set(input.sessionId, pane);
  h.authorities.set(input.sessionId, {
    owner, ...pane, missionId: input.missionId, scope: SCOPE, title: input.title ?? 'Refatorar login',
  });
  h.sessions.set(input.sessionId, {
    sessionId: input.sessionId, paneId: input.paneId, adapterId,
    role: input.missionId ? 'worker' : 'user', agentName: 'Implementar login',
    ...(input.missionId ? { missionId: input.missionId } : {}),
  });
  h.states.set(input.sessionId, 'idle');
}

function handle(overrides: Partial<PaneTaskRerouteHandle> = {}): PaneTaskRerouteHandle {
  return {
    paneId: 'pane-claude',
    adapterId: 'claude',
    missionId: 'mission-1',
    role: 'worker',
    callerSessionId: 'session-maestro',
    routeTask: 'implementar o login',
    lineageId: 'pane-claude',
    operatorOpened: false,
    pinnedRuntime: false,
    generation: 0,
    reroute: vi.fn(async () => ({ paneId: 'pane-codex', adapterId: 'codex' })),
    hasAlternative: vi.fn(() => true),
    ...overrides,
  };
}

function events(): FailoverEvent[] {
  return owner.send.mock.calls
    .filter(([channel]) => channel === ACCOUNT_CHANNELS.failover)
    .map(([, event]) => event as FailoverEvent);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000_000);
  h.dataTaps.length = 0;
  for (const map of [h.sessions, h.states, h.authorities, h.panes, h.runtime]) map.clear();
  h.available.clear();
  h.longNeedsApi = false;
  h.realQuota = false;
  h.quotaEntry = undefined;
  h.probeEntry = undefined;
  h.refreshQuota.mockClear();
  h.sessionOutput = '$ npm test\n✓ 12 passed\nYou exceeded your current quota';
  h.missionStatus = undefined;
  h.rebind.mockReset().mockReturnValue(false);
  h.resumeBootOk.mockReset().mockResolvedValue('proved');
  h.missionsThrow = false;
  h.requestPaneClose.mockClear().mockResolvedValue(true);
  h.respawnMainOwned.mockClear().mockResolvedValue(true);
  h.submit.mockClear();
  h.trace.mockClear();
  resolver.mockClear().mockResolvedValue({ adapterId: 'codex', model: 'gpt-6.1-sol' });
  setNextCliResolver(resolver);
  resetPaneTaskReroutesForTests();
  resetPaneStartWatchdogForTests();
  resetCliLimits();
  owner = renderer(51);
  bindResolvedRendererWorkspaceScope(owner, SCOPE);
  registerFailoverListener(owner);
  initFailover();
});

afterEach(() => {
  unregisterFailoverListener(owner);
  clearRendererWorkspaceScope(owner);
  shutdownFailover();
  setNextCliResolver(null);
  vi.useRealTimers();
});

describe('F-775: pane do operador ("+ Pane") troca de CLI no lugar, com aviso', () => {
  it('Claude esgotou em todas as contas: a rota escolhe a próxima e o pane continua nela com o pacote', async () => {
    rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
    h.dataTaps[0]('session-op', 'QUOTA');
    await settle();

    // A rota parte da autoridade do operador e nunca recebe a CLI esgotada.
    expect(resolver).toHaveBeenCalledWith({
      callerSessionId: 'session-op',
      task: 'Continuar o trabalho do terminal "Refatorar login" em outra CLI',
      excludeAdapterIds: ['claude'],
    });
    expect(events()).toEqual([
      expect.objectContaining({
        paneId: 'pane-op', kind: 'quota', switched: false, cliSwitchPhase: 'requested',
        fromAdapterId: 'claude', fromAdapterLabel: 'Claude',
        toAdapterId: 'codex', toAdapterLabel: 'Codex', toModel: 'gpt-6.1-sol',
      }),
    ]);
    const requested = events()[0]!;
    expect(requested.reason).toMatch(/^Claude esgotou em todas as contas; continuando em Codex/);
    const pack = requested.continuityPack ?? '';
    expect(pack.startsWith(FAILOVER_HANDOFF_HEADER)).toBe(true);
    expect(pack).toContain('No Claude account can take more work right now');
    expect(pack).toContain('- src/login.ts');
    expect(pack).toContain('src/login.ts | 4 ++--');
    expect(pack).not.toContain('gustavo@example.com');
    const { detectLimit } = await vi.importActual<typeof import('./limit-detector')>('./limit-detector');
    expect(detectLimit(pack)).toBeNull();

    // Recibo só depois da sessão nova do MESMO pane, já na CLI nova.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events()).toHaveLength(1);
    h.sessions.set('session-op-2', { sessionId: 'session-op-2', paneId: 'pane-op', adapterId: 'codex' });
    h.states.set('session-op-2', 'busy');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(events()[1]).toMatchObject({ cliSwitchPhase: 'applied', switched: true, toAdapterId: 'codex' });
    expect(h.trace).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'cli-switched', toAdapterId: 'codex' }));
  });

  it('F-1482: o pedido em voo do pane vai no pacote da troca de CLI', async () => {
    noteInFlightRequest('pane-op', 'Trocar o login para OAuth');
    try {
      rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
      h.dataTaps[0]('session-op', 'QUOTA');
      await settle();
      const pack = events()[0]?.continuityPack ?? '';
      expect(pack).toContain(
        'Request in flight (last delivered to this pane; finish it if it is not done): Trocar o login para OAuth',
      );
    } finally {
      resetInFlightRequestsForTests();
    }
  });

  it('o religamento que não acontece não vira troca', async () => {
    rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
    h.dataTaps[0]('session-op', 'QUOTA');
    await settle();
    await vi.advanceTimersByTimeAsync(45_000);
    await settle();
    expect(events().some((event) => event.switched)).toBe(false);
    expect(events().at(-1)).toMatchObject({ cliSwitchPhase: 'applied', switched: false });
  });

  it('nenhuma CLI elegível: aviso honesto e a espera pela conta continua', async () => {
    resolver.mockResolvedValueOnce(null);
    rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
    h.dataTaps[0]('session-op', 'QUOTA');
    await settle();
    expect(events()).toEqual([expect.objectContaining({ switched: false })]);
    expect(events()[0]!.cliSwitchPhase).toBeUndefined();
    expect(events()[0]!.reason).toContain('nenhuma outra CLI elegível agora');
    expect(events()[0]!.scheduledRetryAtMs).toBeGreaterThan(Date.now());
  });

  it('a rota que devolve a própria CLI esgotada não conta como saída', async () => {
    resolver.mockResolvedValueOnce({ adapterId: 'claude' });
    rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
    h.dataTaps[0]('session-op', 'QUOTA');
    await settle();
    expect(events().some((event) => event.cliSwitchPhase)).toBe(false);
  });

  it('limite curto (volta em 1 min) espera a conta: não troca de CLI', async () => {
    rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
    h.dataTaps[0]('session-op', 'SHORT');
    await settle();
    expect(resolver).not.toHaveBeenCalled();
    expect(events().some((event) => event.cliSwitchPhase)).toBe(false);
  });

  it('credencial recusada em todas as contas também segue para outra CLI', async () => {
    rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
    h.dataTaps[0]('session-op', 'AUTH');
    await settle();
    expect(events()[0]).toMatchObject({ kind: 'auth', cliSwitchPhase: 'requested', toAdapterId: 'codex' });
  });

  it('F-249: limite longo sem leitura do provedor só troca na 2ª batida, depois da pausa curta', async () => {
    h.longNeedsApi = true;
    rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
    h.dataTaps[0]('session-op', 'LONG');
    await settle();
    // 1ª batida: pausa curta de 15 min na mesma conta, sem trocar nada.
    expect(resolver).not.toHaveBeenCalled();
    expect(events().at(-1)?.reason).toMatch(/não confirmou o limite/);

    // Repaint dentro da pausa não confirma.
    await vi.advanceTimersByTimeAsync(60_000);
    h.dataTaps[0]('session-op', 'LONG');
    await settle();
    expect(resolver).not.toHaveBeenCalled();

    // A sessão retomada bate no limite de novo depois da pausa: confirmado.
    vi.setSystemTime(Date.now() + 15 * 60_000);
    h.dataTaps[0]('session-op', 'LONG');
    await settle();
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(events().at(-1)).toMatchObject({ cliSwitchPhase: 'requested', toAdapterId: 'codex' });
  });
});

describe('F-775: tarefa de missão segue em outra CLI por um pane novo', () => {
  it('worker esgotado: fecha o parado, reabre pela rota sem a CLI esgotada, com o pacote, na mesma worktree', async () => {
    rendererPane({ paneId: 'pane-claude', sessionId: 'session-claude', missionId: 'mission-1' });
    const task = handle();
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();

    expect(resolver).not.toHaveBeenCalled(); // a rota é a do próprio spawn
    expect(h.requestPaneClose).toHaveBeenCalledWith('pane-claude', 'session-claude');
    const request = vi.mocked(task.reroute).mock.calls[0]![0];
    expect(request).toMatchObject({ excludeAdapterIds: ['claude'], worktreeFromPaneId: 'pane-claude' });
    expect(request.appendPrompt).toContain('No Claude account can take more work right now');
    expect(h.requestPaneClose.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(task.reroute).mock.invocationCallOrder[0],
    );
    expect(events()).toEqual([
      expect.objectContaining({
        paneId: 'pane-claude', kind: 'quota', switched: true,
        fromAdapterId: 'claude', toAdapterId: 'codex', toAdapterLabel: 'Codex', toPaneId: 'pane-codex',
      }),
    ]);
    const summary = String(h.submit.mock.calls[0]![0].summary);
    expect(summary).toContain('[troca-de-cli:pane-claude]');
    expect(summary).toContain('pane-codex');
    expect(summary).not.toContain('gustavo@example.com');
  });

  it('CLI pedida pelo operador: o esgotamento vence e a tarefa segue mesmo assim', async () => {
    rendererPane({ paneId: 'pane-claude', sessionId: 'session-claude', missionId: 'mission-1' });
    const task = handle({ pinnedRuntime: true });
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    expect(task.reroute).toHaveBeenCalledTimes(1);
  });

  it('pane aberto pelo operador DENTRO da missão (F-231) não é fechado pela máquina', async () => {
    rendererPane({ paneId: 'pane-claude', sessionId: 'session-claude', missionId: 'mission-1' });
    const task = handle({ operatorOpened: true });
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    expect(task.reroute).not.toHaveBeenCalled();
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    expect(events()[0]!.reason).toContain('o pane é do operador');
  });

  it('worker main-owned sem pedido guardado: a rota do Maestro escolhe e o Main religa a missão na CLI nova', async () => {
    h.runtime.set('session-headless', {
      owner: null, paneId: 'pane-headless', sessionId: 'session-headless', kind: 'cli-agent',
      missionId: 'mission-1', scope: SCOPE,
    });
    h.sessions.set('session-headless', {
      sessionId: 'session-headless', paneId: 'pane-headless', adapterId: 'claude',
      accountId: 'claude-a', missionId: 'mission-1', role: 'worker', agentName: 'Revisor',
    });
    h.states.set('session-headless', 'idle');
    h.dataTaps[0]('session-headless', 'QUOTA');
    await settle();
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      callerSessionId: 'session-maestro', excludeAdapterIds: ['claude'],
    }));
    expect(h.respawnMainOwned).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'pane-headless', sessionId: 'session-headless', adapterId: 'codex', toModel: 'gpt-6.1-sol',
    }));
    const call = h.respawnMainOwned.mock.calls[0]![0] as { continuityPack?: string; scrollbackExcerpt?: string };
    expect(call.continuityPack).toContain(FAILOVER_HANDOFF_HEADER);
    // ORC-05/F-249: o trecho do terminal vai para o recorte neutralizado, não cru no pack.
    expect(call.continuityPack).not.toContain('Recent terminal excerpt');
    expect(call.scrollbackExcerpt).toContain('You exceeded your current quota');
    expect(events().at(-1)).toMatchObject({ switched: true, toAdapterId: 'codex' });
  });
});

describe('F-1471: worker de missão troca de conta no MESMO provedor e segue a tarefa', () => {
  type Reopened = { paneId: string; adapterId: string; model?: string };
  /** Duas contas Claude: a do pane (claude-a) esgota, a irmã (claude-b) tem folga. */
  beforeEach(() => {
    h.missionStatus = 'running';
    vi.mocked(pickAvailableForFailover).mockImplementation((_adapterId, excludeId, _now, _scores, options) => ({
      account: excludeId !== 'claude-b' && !options?.excludeIds?.has('claude-b')
        ? ACCOUNTS['claude-b']! as never
        : null,
      probe: false,
    }));
    vi.mocked(prepareAccountForSpawn).mockImplementation(((adapterId: string, id: string) =>
      ACCOUNTS[id]?.adapterId === adapterId
        ? { ok: true, account: ACCOUNTS[id], apiKey: null, authEnv: {} }
        : { ok: false, error: 'missing' }) as never);
    vi.mocked(verifyManagedClaudeAccountForSpawn).mockImplementation(async (_id, onVerified) => {
      onVerified?.('verified-claude-blob');
      return 'match';
    });
  });
  afterEach(() => {
    vi.mocked(pickAvailableForFailover).mockImplementation(() => ({ account: null, probe: false }));
    vi.mocked(prepareAccountForSpawn).mockImplementation((() => ({ ok: false, error: 'not in test' })) as never);
    vi.mocked(verifyManagedClaudeAccountForSpawn).mockImplementation(async () => 'match');
  });

  /** Worker Claude no renderer, rodando claude-opus-5-5 na conta claude-a. */
  function worker(): void {
    rendererPane({ paneId: 'pane-claude', sessionId: 'session-claude', missionId: 'mission-1' });
    h.sessions.set('session-claude', { ...h.sessions.get('session-claude'), model: 'claude-opus-5-5' });
  }

  it('leitor: o pane novo nasce na conta irmã, MESMA CLI e MESMO modelo, ANTES de o velho fechar; recibo só com o pane novo', async () => {
    worker();
    let finish!: (next: Reopened) => void;
    const task = handle({
      exclusiveCheckout: false,
      reroute: vi.fn(() => new Promise<Reopened>((resolve) => { finish = resolve; })),
    });
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();

    // Nenhuma CLI nova: nem a rota de troca de CLI é consultada.
    expect(resolver).not.toHaveBeenCalled();
    expect(task.reroute).toHaveBeenCalledTimes(1);
    // A tarefa nunca fica sem pane: o velho segue aberto até o novo existir.
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    const request = vi.mocked(task.reroute).mock.calls[0]![0];
    expect(request.sameAdapter).toEqual({ adapterId: 'claude', accountId: 'claude-b', model: 'claude-opus-5-5' });
    expect(request.excludeAdapterIds).not.toContain('claude');
    expect(request.worktreeFromPaneId).toBe('pane-claude');
    // Pacote de troca de CONTA (sessão nova na conta irmã), não de CLI; rótulos mascarados.
    expect(request.appendPrompt).toContain(FAILOVER_HANDOFF_HEADER);
    expect(request.appendPrompt).toContain('You are now running on account');
    expect(request.appendPrompt).not.toContain('No Claude account can take more work');
    expect(request.appendPrompt).not.toContain('maria@example.com');
    expect(request.appendPrompt).not.toContain('gustavo@example.com');
    expect(request.appendPrompt).toContain('claude-opus-5-5');
    expect(events().some((event) => event.switched)).toBe(false);
    // Revisão A: com a troca em curso, a rede do supervisor não acha a ficha
    // nem reabre a mesma tarefa noutra CLI.
    expect(listConfirmedPaneLimits().some((limit) => limit.paneId === 'pane-claude')).toBe(false);
    expect(hasPendingFailoverRecovery('pane-claude', 'session-claude')).toBe(true);

    finish({ paneId: 'pane-claude-2', adapterId: 'claude', model: 'claude-opus-5-5' });
    await settle();
    expect(hasPendingFailoverRecovery('pane-claude', 'session-claude')).toBe(false);
    expect(h.requestPaneClose).toHaveBeenCalledWith('pane-claude', 'session-claude');
    expect(vi.mocked(task.reroute).mock.invocationCallOrder[0]).toBeLessThan(
      h.requestPaneClose.mock.invocationCallOrder[0]!,
    );
    expect(events().filter((event) => event.switched)).toEqual([
      expect.objectContaining({
        paneId: 'pane-claude', switched: true, kind: 'quota',
        fromAccountId: 'claude-a', toAccountId: 'claude-b', toAccountLabel: 'maria@example.com',
        fromAdapterId: 'claude', toAdapterId: 'claude', toPaneId: 'pane-claude-2',
      }),
    ]);
    expect(events().at(-1)!.reason).not.toContain('modelo');
    // O supervisor não reabre a tarefa em outra CLI depois da troca.
    expect(listConfirmedPaneLimits().some((limit) => limit.paneId === 'pane-claude')).toBe(false);
    const summary = String(h.submit.mock.calls.at(-1)![0].summary);
    expect(summary).toContain('[troca-de-conta:pane-claude]');
    expect(summary).toContain('pane-claude-2');
    expect(summary).not.toContain('maria@example.com');
    expect(summary).not.toContain('gustavo@example.com');
    expect(h.trace).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'account-failover', outcome: 'switched', toAccountId: 'claude-b', toPaneId: 'pane-claude-2',
    }));
  });

  it('writer: o checkout só aceita um writer — o velho sai e o novo nasce na conta irmã logo depois, sem trocar de CLI', async () => {
    worker();
    const task = handle({ reroute: vi.fn(async () => ({ paneId: 'pane-claude-2', adapterId: 'claude', model: 'claude-opus-5-5' })) });
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(h.requestPaneClose.mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(task.reroute).mock.invocationCallOrder[0]!,
    );
    expect(task.reroute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(task.reroute).mock.calls[0]![0].sameAdapter).toEqual({
      adapterId: 'claude', accountId: 'claude-b', model: 'claude-opus-5-5',
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(events().find((event) => event.switched)).toMatchObject({
      toAccountId: 'claude-b', toAdapterId: 'claude', toPaneId: 'pane-claude-2',
    });
    expect(String(h.submit.mock.calls.at(-1)![0].summary)).toContain('[troca-de-conta:pane-claude]');
  });

  it('F-1473: Claude com histórico compartilhado — o pane novo na conta irmã retoma a MESMA conversa e recebe só a nota', async () => {
    worker();
    h.rebind.mockReturnValue(true);
    const task = handle({ reroute: vi.fn(async () => ({ paneId: 'pane-claude-2', adapterId: 'claude', model: 'claude-opus-5-5' })) });
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(h.rebind).toHaveBeenCalledWith(SCOPE, 'pane-claude', 'claude', 'claude-a', 'claude-b');
    expect(task.reroute).toHaveBeenCalledTimes(1);
    const request = vi.mocked(task.reroute).mock.calls[0]![0];
    expect(request.sameAdapter).toEqual({ adapterId: 'claude', accountId: 'claude-b', model: 'claude-opus-5-5' });
    expect(request.nativeResume?.fromPaneId).toBe('pane-claude');
    expect(request.nativeResume?.note).toContain('resumed THIS SAME conversation');
    expect(request.nativeResume?.note).not.toContain('maria@example.com');
    expect(h.resumeBootOk).toHaveBeenCalledWith({ paneId: 'pane-claude-2' });
    expect(h.resumeBootDispose).toHaveBeenCalled();
    expect(events().find((event) => event.switched)).toMatchObject({
      toAccountId: 'claude-b', toAdapterId: 'claude', toPaneId: 'pane-claude-2', nativeResume: true,
    });
    expect(String(h.submit.mock.calls.at(-1)![0].summary)).toContain('retomando a MESMA conversa');
  });

  it.each([
    ['o pane retomado cai no boot', 'boot'],
    ['o spawn com resume é recusado (conversa não encontrada)', 'refused'],
  ] as const)('F-1473: fallback quando %s — a mesma troca refeita com o pacote, e a tarefa segue', async (_label, failure) => {
    worker();
    h.rebind.mockReturnValue(true);
    if (failure === 'boot') h.resumeBootOk.mockResolvedValueOnce('failed');
    const reroute = vi.fn<PaneTaskRerouteHandle['reroute']>();
    if (failure === 'refused') {
      reroute.mockRejectedValueOnce(new Error('resume_context_unavailable: conversa original indisponível'));
    } else {
      reroute.mockResolvedValueOnce({ paneId: 'pane-claude-resumed', adapterId: 'claude', model: 'claude-opus-5-5' });
    }
    reroute.mockResolvedValueOnce({ paneId: 'pane-claude-pack', adapterId: 'claude', model: 'claude-opus-5-5' });
    registerPaneTaskReroute(handle({ reroute }));
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    await settle();
    expect(reroute).toHaveBeenCalledTimes(2);
    expect(reroute.mock.calls[0]![0].nativeResume).toBeDefined();
    const fallback = reroute.mock.calls[1]![0];
    expect(fallback.nativeResume).toBeUndefined();
    expect(fallback.sameAdapter).toEqual({ adapterId: 'claude', accountId: 'claude-b', model: 'claude-opus-5-5' });
    expect(fallback.appendPrompt).toContain('You are now running on account');
    if (failure === 'boot') expect(h.requestPaneClose).toHaveBeenCalledWith('pane-claude-resumed');
    const receipt = events().find((event) => event.switched);
    expect(receipt).toMatchObject({ toPaneId: 'pane-claude-pack', toAccountId: 'claude-b' });
    expect(receipt?.nativeResume).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('F-1473: durante a prova, o failover é dono do substituto; sem prova, a ficha dele sai e o fallback só começa com ele fechado', async () => {
    worker();
    h.rebind.mockReturnValue(true);
    let prove!: (verdict: 'proved' | 'failed' | 'closed') => void;
    h.resumeBootOk.mockImplementationOnce(() => new Promise((resolve) => { prove = resolve; }));
    const reroute = vi.fn<PaneTaskRerouteHandle['reroute']>()
      .mockImplementationOnce(async () => {
        // O substituto nasce com a ficha de início dele (F-723), como num spawn de verdade.
        trackPaneStart({ paneId: 'pane-claude-resumed', adapterId: 'claude', requestId: 'r-resumed',
          callerSessionId: 'session-maestro', scope: SCOPE, role: 'worker' } as never);
        return { paneId: 'pane-claude-resumed', adapterId: 'claude', model: 'claude-opus-5-5' };
      })
      .mockResolvedValueOnce({ paneId: 'pane-claude-pack', adapterId: 'claude', model: 'claude-opus-5-5' });
    registerPaneTaskReroute(handle({ reroute }));
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    // Supervisor e ficha do substituto esperam: a recuperação é do failover.
    expect(hasPendingFailoverRecovery('pane-claude-resumed', '')).toBe(true);
    expect(getPaneStartWatch('pane-claude-resumed')).not.toBeNull();
    let closeSubstitute!: (closed: boolean) => void;
    h.requestPaneClose.mockImplementation(async (paneId: string) =>
      paneId === 'pane-claude-resumed' ? new Promise<boolean>((resolve) => { closeSubstitute = resolve; }) : true);
    prove('failed');
    await settle();
    expect(getPaneStartWatch('pane-claude-resumed')).toBeNull();
    // O pacote espera o substituto fechar de verdade.
    expect(reroute).toHaveBeenCalledTimes(1);
    closeSubstitute(true);
    await settle();
    await settle();
    expect(reroute).toHaveBeenCalledTimes(2);
    expect(reroute.mock.calls[1]![0].nativeResume).toBeUndefined();
    expect(hasPendingFailoverRecovery('pane-claude-resumed', '')).toBe(false);
    expect(events().find((event) => event.switched)).toMatchObject({ toPaneId: 'pane-claude-pack' });
  });

  it.each([
    ['com sessão viva', true],
    ['fechamento recusado mesmo sem sessão viva', false],
  ] as const)('F-1473: substituto sem prova que não fecha (%s) fica com a tarefa — sem segundo pane e sem "mesma conversa"', async (_label, live) => {
    worker();
    h.rebind.mockReturnValue(true);
    h.resumeBootOk.mockResolvedValueOnce('failed');
    if (live) {
      h.sessions.set('session-resumed', { sessionId: 'session-resumed', paneId: 'pane-claude-resumed', adapterId: 'claude' });
      h.states.set('session-resumed', 'busy');
    }
    h.requestPaneClose.mockImplementation(async (paneId: string) => paneId !== 'pane-claude-resumed');
    const reroute = vi.fn<PaneTaskRerouteHandle['reroute']>()
      .mockResolvedValueOnce({ paneId: 'pane-claude-resumed', adapterId: 'claude', model: 'claude-opus-5-5' });
    registerPaneTaskReroute(handle({ reroute }));
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(reroute).toHaveBeenCalledTimes(1);
    const receipt = events().find((event) => event.switched);
    expect(receipt).toMatchObject({ toPaneId: 'pane-claude-resumed', toAccountId: 'claude-b' });
    expect(receipt?.nativeResume).toBeUndefined();
  });

  it('F-1473: substituto encerrado pelo próprio Nexus na janela (missão cancelada, pane fechado) não é queda — sem fallback', async () => {
    worker();
    h.rebind.mockReturnValue(true);
    h.resumeBootOk.mockResolvedValueOnce('closed');
    const reroute = vi.fn<PaneTaskRerouteHandle['reroute']>()
      .mockResolvedValueOnce({ paneId: 'pane-claude-resumed', adapterId: 'claude', model: 'claude-opus-5-5' });
    registerPaneTaskReroute(handle({ reroute }));
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(reroute).toHaveBeenCalledTimes(1);
    expect(h.requestPaneClose).not.toHaveBeenCalledWith('pane-claude-resumed');
    const receipt = events().find((event) => event.switched);
    expect(receipt).toMatchObject({ toPaneId: 'pane-claude-resumed' });
    expect(receipt?.nativeResume).toBeUndefined();
  });

  it.each([false, true])('F-1482: troca na conta irmã reentrega o pedido em voo e o pane novo o herda (retomada nativa=%s)', async (resume) => {
    worker();
    h.rebind.mockReturnValue(resume);
    noteInFlightRequest('pane-claude', 'Ajuste do Maestro: usar a fila nova');
    try {
      const task = handle({ reroute: vi.fn(async () => ({ paneId: 'pane-claude-2', adapterId: 'claude', model: 'claude-opus-5-5' })) });
      registerPaneTaskReroute(task);
      h.dataTaps[0]('session-claude', 'QUOTA');
      await settle();
      await settle();
      const request = vi.mocked(task.reroute).mock.calls[0]![0];
      expect(request.appendPrompt).toContain(
        'Request in flight (last delivered to this pane; finish it if it is not done): Ajuste do Maestro: usar a fila nova',
      );
      if (resume) expect(request.nativeResume?.note).toContain('Request in flight: Ajuste do Maestro: usar a fila nova');
      else expect(request.nativeResume).toBeUndefined();
      expect(inFlightRequestOf('pane-claude-2')).toBe('Ajuste do Maestro: usar a fila nova');
    } finally {
      resetInFlightRequestsForTests();
    }
  });

  it('a rota sem o modelo anterior: segue no modelo dela e o recibo registra a troca de modelo', async () => {
    worker();
    const task = handle({ reroute: vi.fn(async () => ({ paneId: 'pane-claude-2', adapterId: 'claude', model: 'claude-sonnet-5-5' })) });
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    const receipt = events().find((event) => event.switched)!;
    expect(receipt).toMatchObject({ toPaneId: 'pane-claude-2', toAccountId: 'claude-b' });
    expect(receipt.reason).toContain('claude-opus-5-5');
    expect(receipt.reason).toContain('claude-sonnet-5-5');
    expect(String(h.submit.mock.calls.at(-1)![0].summary)).toContain('claude-sonnet-5-5');
  });

  it('leitor: o pane velho não fecha depois do novo — a troca vale e o orquestrador sabe que sobrou o pane antigo', async () => {
    h.requestPaneClose.mockResolvedValue(false);
    worker();
    const task = handle({
      exclusiveCheckout: false,
      reroute: vi.fn(async () => ({ paneId: 'pane-claude-2', adapterId: 'claude', model: 'claude-opus-5-5' })),
    });
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(events().find((event) => event.switched)).toMatchObject({ toPaneId: 'pane-claude-2' });
    expect(events().find((event) => event.switched)!.reason).toContain('pane antigo');
    expect(String(h.submit.mock.calls.at(-1)![0].summary)).toContain('pane-claude');
  });

  it('leitor: reenvio na conta irmã recusado — o pane velho fica e a tarefa segue em outra CLI, com recibo e aviso coerentes', async () => {
    worker();
    const task = handle({
      exclusiveCheckout: false,
      reroute: vi.fn(async (request: { sameAdapter?: unknown }) => {
        if (request.sameAdapter) throw new Error('a troca de conta exige a mesma CLI (claude); a rota devolveu codex');
        return { paneId: 'pane-codex', adapterId: 'codex' };
      }),
    });
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();

    expect(task.reroute).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(task.reroute).mock.calls.map(([request]) => request);
    expect(first!.sameAdapter).toBeDefined();
    expect(second!.sameAdapter).toBeUndefined();
    expect(second!.excludeAdapterIds).toEqual(['claude']);
    // O pane velho só fecha no caminho de troca de CLI, depois da recusa.
    expect(h.requestPaneClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(task.reroute).mock.invocationCallOrder[0]).toBeLessThan(
      h.requestPaneClose.mock.invocationCallOrder[0]!,
    );
    const receipt = events().find((event) => event.switched)!;
    expect(receipt).toMatchObject({ toAdapterId: 'codex', toPaneId: 'pane-codex' });
    expect(receipt.reason).toContain('não recebeu a tarefa');
    expect(receipt.reason).not.toContain('esgotou em todas as contas');
    const summary = String(h.submit.mock.calls.at(-1)![0].summary);
    expect(summary).toContain('[troca-de-cli:pane-claude]');
    expect(summary).toContain('pane-codex');
    expect(summary).not.toContain('maria@example.com');
  });

  it('leitor: reenvio recusado e nenhuma outra CLI — o pane velho fica, espera a conta e o orquestrador é avisado', async () => {
    worker();
    const task = handle({
      exclusiveCheckout: false,
      reroute: vi.fn(async () => { throw new Error('quem pediu o pane não tem mais sessão viva'); }),
      hasAlternative: vi.fn(() => false),
    });
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    expect(events().some((event) => event.switched)).toBe(false);
    const last = events().at(-1)!;
    expect(last).toMatchObject({ paneId: 'pane-claude', switched: false });
    expect(last.reason).toContain('não recebeu a tarefa');
    expect(last.scheduledRetryAtMs).toBeGreaterThan(Date.now());
    expect(String(h.submit.mock.calls.at(-1)![0].summary)).toContain('[troca-de-conta:pane-claude]');
  });

  it('writer: reenvio na conta irmã recusado depois de o velho sair — a tarefa segue em outra CLI no mesmo checkout', async () => {
    worker();
    const task = handle({
      reroute: vi.fn(async (request: { sameAdapter?: unknown }) => {
        if (request.sameAdapter) throw new Error('spawn recusado pela admissão de panes');
        return { paneId: 'pane-codex', adapterId: 'codex' };
      }),
    });
    h.requestPaneClose.mockImplementation(async (_paneId: string, sessionId?: string) => {
      if (sessionId) h.sessions.delete(sessionId);
      return true;
    });
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(h.requestPaneClose.mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(task.reroute).mock.invocationCallOrder[0]!,
    );
    expect(task.reroute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(task.reroute).mock.calls[1]![0]).toMatchObject({
      excludeAdapterIds: ['claude'], worktreeFromPaneId: 'pane-claude',
    });
    expect(events().find((event) => event.switched)).toMatchObject({ toAdapterId: 'codex', toPaneId: 'pane-codex' });
    expect(events().find((event) => event.switched)!.reason).toContain('não recebeu a tarefa');
  });

  it('F-1486: writer recusado depois de sair e nenhuma outra CLI — a tarefa espera e o Nexus a reabre sozinho na conta irmã', async () => {
    worker();
    const task = handle({
      reroute: vi.fn(async () => { throw new Error('quem pediu o pane não tem mais sessão viva'); }),
      hasAlternative: vi.fn(() => false),
    });
    h.requestPaneClose.mockImplementation(async (_paneId: string, sessionId?: string) => {
      if (sessionId) h.sessions.delete(sessionId);
      return true;
    });
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(events().some((event) => event.switched)).toBe(false);
    const last = events().at(-1)!;
    expect(last).toMatchObject({ paneId: 'pane-claude', switched: false });
    expect(last.reason).toContain('não recebeu a tarefa');
    // A tarefa sem pane ganha nova tentativa automática (antes: só o resume manual).
    expect(last.scheduledRetryAtMs).toBeGreaterThan(Date.now());
    expect(hasPendingFailoverRecovery('pane-claude', 'session-claude')).toBe(true);
    const summary = String(h.submit.mock.calls.at(-1)![0].summary);
    expect(summary).toContain('[troca-de-conta:pane-claude]');
    expect(summary).toContain('reabre a tarefa sozinho');
    const notices = h.submit.mock.calls.length;

    vi.mocked(task.reroute).mockImplementation(async () => ({
      paneId: 'pane-claude-2', adapterId: 'claude', model: 'claude-opus-5-5',
    }));
    await vi.advanceTimersByTimeAsync(last.scheduledRetryAtMs! - Date.now());
    await settle();
    await settle();
    expect(task.reroute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(task.reroute).mock.calls[1]![0].sameAdapter).toMatchObject({
      adapterId: 'claude', accountId: 'claude-b',
    });
    expect(events().filter((event) => event.switched)).toEqual([
      expect.objectContaining({ paneId: 'pane-claude', toAccountId: 'claude-b', toPaneId: 'pane-claude-2' }),
    ]);
    expect(hasPendingFailoverRecovery('pane-claude', 'session-claude')).toBe(false);
    // O orquestrador recebe o desfecho (um aviso por espera, não um por tentativa).
    expect(h.submit.mock.calls.length).toBe(notices + 1);
    expect(String(h.submit.mock.calls.at(-1)![0].summary)).toContain('pane-claude-2');
  });

  it('F-1486: com o prepare da conta irmã pendente, o supervisor já espera (marca antes do heal/prepare)', async () => {
    worker();
    registerPaneTaskReroute(handle());
    let verify!: (value: 'match') => void;
    vi.mocked(verifyManagedClaudeAccountForSpawn).mockImplementationOnce(
      () => new Promise((resolve) => { verify = resolve; }),
    );
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    expect(hasPendingFailoverRecovery('pane-claude', 'session-claude')).toBe(true);
    verify('match');
    await settle();
    await settle();
    expect(hasPendingFailoverRecovery('pane-claude', 'session-claude')).toBe(false);
  });

  it('F-1486: recusa da conta irmã não consome o teto de 3 trocas por hora', async () => {
    for (let n = 1; n <= 4; n += 1) {
      rendererPane({ paneId: `pane-${n}`, sessionId: `session-${n}`, missionId: 'mission-1' });
      const task = handle({
        paneId: `pane-${n}`,
        lineageId: 'pane-1',
        exclusiveCheckout: false,
        hasAlternative: vi.fn(() => false),
        reroute: vi.fn(async () => {
          if (n < 4) throw new Error('spawn recusado pela admissão de panes');
          return { paneId: 'pane-5', adapterId: 'claude' };
        }),
      });
      registerPaneTaskReroute(task);
      h.dataTaps[0](`session-${n}`, 'QUOTA');
      await settle();
      await settle();
      expect(vi.mocked(task.reroute).mock.calls[0]![0].sameAdapter).toMatchObject({ accountId: 'claude-b' });
    }
    expect(events().filter((event) => event.switched)).toEqual([
      expect.objectContaining({ paneId: 'pane-4', toAccountId: 'claude-b', toPaneId: 'pane-5' }),
    ]);
  });

  it('F-1486: duas reaberturas concorrentes da MESMA tarefa (linhagem) dão um só reroute', async () => {
    let finish!: (next: Reopened) => void;
    const reroute = vi.fn(() => new Promise<Reopened>((resolve) => { finish = resolve; }));
    for (const n of [1, 2]) {
      rendererPane({ paneId: `pane-${n}`, sessionId: `session-${n}`, missionId: 'mission-1' });
      registerPaneTaskReroute(handle({ paneId: `pane-${n}`, lineageId: 'pane-1', exclusiveCheckout: false, reroute }));
    }
    h.dataTaps[0]('session-1', 'QUOTA');
    h.dataTaps[0]('session-2', 'QUOTA');
    await settle();
    await settle();
    expect(reroute).toHaveBeenCalledTimes(1);
    finish({ paneId: 'pane-3', adapterId: 'claude' });
    await settle();
    expect(reroute).toHaveBeenCalledTimes(1);
  });

  it('F-1486: o store da missão fora do ar — nada de "trocado" genérico: recibo honesto e orquestrador avisado', async () => {
    worker();
    registerPaneTaskReroute(handle());
    h.missionsThrow = true;
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(events().some((event) => event.switched)).toBe(false);
    const last = events().at(-1)!;
    expect(last).toMatchObject({ paneId: 'pane-claude', switched: false });
    expect(last.reason).toContain('não conseguiu ler a missão');
    const summary = String(h.submit.mock.calls.at(-1)![0].summary);
    expect(summary).toContain('[troca-de-conta:pane-claude]');
    expect(summary).not.toContain('maria@example.com');
  });

  it('teto próprio: a 4ª troca de conta da mesma tarefa na hora não reabre de novo — segue o caminho de sempre', async () => {
    for (let n = 1; n <= 4; n += 1) {
      rendererPane({ paneId: `pane-${n}`, sessionId: `session-${n}`, missionId: 'mission-1' });
      const task = handle({
        paneId: `pane-${n}`,
        lineageId: 'pane-1',
        reroute: vi.fn(async (request: { sameAdapter?: unknown }) => request.sameAdapter
          ? { paneId: `pane-${n + 1}`, adapterId: 'claude' }
          : { paneId: 'pane-codex', adapterId: 'codex' }),
      });
      registerPaneTaskReroute(task);
      h.dataTaps[0](`session-${n}`, 'QUOTA');
      await settle();
      await settle();
      const request = vi.mocked(task.reroute).mock.calls.at(-1)![0];
      if (n <= 3) {
        expect(request.sameAdapter).toMatchObject({ adapterId: 'claude', accountId: 'claude-b' });
      } else {
        expect(request.sameAdapter).toBeUndefined();
        expect(request.excludeAdapterIds).toEqual(['claude']);
      }
    }
    const last = events().filter((event) => event.switched).at(-1)!;
    expect(last).toMatchObject({ toAdapterId: 'codex', toPaneId: 'pane-codex' });
    expect(last.reason).toContain('trocou de conta 3 vezes');
  });

  it('pane aberto pelo operador dentro da missão: nada de "trocado" falso — recibo honesto e orquestrador avisado', async () => {
    worker();
    const task = handle({ operatorOpened: true });
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(task.reroute).not.toHaveBeenCalled();
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    expect(events().some((event) => event.switched)).toBe(false);
    const last = events().at(-1)!;
    expect(last).toMatchObject({ paneId: 'pane-claude', switched: false });
    expect(last.reason).toContain('operador');
    const summary = String(h.submit.mock.calls.at(-1)![0].summary);
    expect(summary).toContain('[troca-de-conta:pane-claude]');
    expect(summary).not.toContain('maria@example.com');
  });

  it('worker sem pedido de spawn guardado: recibo honesto (switched:false) com o motivo e orquestrador avisado', async () => {
    worker();
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    expect(events().some((event) => event.switched)).toBe(false);
    expect(events().at(-1)!.reason).toContain('pedido de spawn');
    expect(String(h.submit.mock.calls.at(-1)![0].summary)).toContain('[troca-de-conta:pane-claude]');
  });

  it('missão que já não é dona do pane: o renderer troca no lugar, como no pane do operador', async () => {
    h.missionStatus = 'failed';
    worker();
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(events().at(-1)).toMatchObject({ switched: true, toAccountId: 'claude-b' });
    expect(events().at(-1)!.toPaneId).toBeUndefined();
  });

  it('worker headless (main-owned) segue religado pelo Main na conta irmã, sem reabrir a tarefa', async () => {
    h.runtime.set('session-headless', {
      owner: null, paneId: 'pane-headless', sessionId: 'session-headless', kind: 'cli-agent',
      adapterId: 'claude', accountId: 'claude-a', missionId: 'mission-1', scope: SCOPE,
    });
    h.sessions.set('session-headless', {
      sessionId: 'session-headless', paneId: 'pane-headless', adapterId: 'claude',
      accountId: 'claude-a', missionId: 'mission-1', role: 'worker', agentName: 'Revisor',
    });
    h.states.set('session-headless', 'idle');
    const task = handle({ paneId: 'pane-headless', lineageId: 'pane-headless' });
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-headless', 'QUOTA');
    await settle();
    await settle();
    expect(h.respawnMainOwned).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'pane-headless', sessionId: 'session-headless', adapterId: 'claude', toAccountId: 'claude-b',
    }));
    expect(task.reroute).not.toHaveBeenCalled();
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    expect(events().at(-1)).toMatchObject({ switched: true, toAccountId: 'claude-b' });
  });

  it('todas as contas da CLI em cooldown: segue a troca de CLI de sempre, sem reabrir no mesmo adapter', async () => {
    vi.mocked(pickAvailableForFailover).mockImplementation(() => ({ account: null, probe: false }));
    worker();
    const task = handle();
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(task.reroute).toHaveBeenCalledTimes(1);
    const request = vi.mocked(task.reroute).mock.calls[0]![0];
    expect(request.sameAdapter).toBeUndefined();
    expect(request.excludeAdapterIds).toEqual(['claude']);
  });

  it('sem irmã e sem caminho de troca de CLI: espera a conta com nextUnblockAtMs, sem fechar o pane', async () => {
    const unblockAt = Date.now() + 2 * 60 * 60_000;
    vi.mocked(pickAvailableForFailover).mockImplementation(() => ({
      account: null, probe: false, nextUnblockAtMs: unblockAt,
    }));
    worker();
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    await settle();
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    expect(events().at(-1)).toMatchObject({
      paneId: 'pane-claude', switched: false, nextUnblockAtMs: unblockAt,
    });
  });
});

describe('F-775: anti-laço — teto por tarefa e sem pingue-pongue', () => {
  /** Arma o pane N da mesma tarefa (linhagem `pane-1`) na CLI dada. */
  function stage(n: number, adapterId: string): PaneTaskRerouteHandle {
    rendererPane({ paneId: `pane-${n}`, sessionId: `session-${n}`, adapterId, missionId: 'mission-1' });
    const task = handle({
      paneId: `pane-${n}`, adapterId, lineageId: 'pane-1', generation: n - 1,
      reroute: vi.fn(async () => ({ paneId: `pane-${n + 1}`, adapterId: 'next' })),
    });
    registerPaneTaskReroute(task);
    return task;
  }

  it('a CLI que esgotou não volta antes de liberar, e a 4ª troca da tarefa não acontece', async () => {
    const first = stage(1, 'claude');
    h.dataTaps[0]('session-1', 'QUOTA');
    await settle();
    expect(vi.mocked(first.reroute).mock.calls[0]![0].excludeAdapterIds).toEqual(['claude']);

    const second = stage(2, 'codex');
    h.dataTaps[0]('session-2', 'QUOTA');
    await settle();
    // Claude segue esgotado: fica fora — nada de voltar e bater de novo.
    expect(vi.mocked(second.reroute).mock.calls[0]![0].excludeAdapterIds).toEqual(['codex', 'claude']);

    const third = stage(3, 'kimi');
    h.dataTaps[0]('session-3', 'QUOTA');
    await settle();
    expect(vi.mocked(third.reroute).mock.calls[0]![0].excludeAdapterIds).toEqual(['kimi', 'claude', 'codex']);

    const fourth = stage(4, 'grok');
    h.dataTaps[0]('session-4', 'QUOTA');
    await settle();
    expect(fourth.reroute).not.toHaveBeenCalled();
    expect(events().at(-1)?.reason).toContain('trocou de CLI 3 vezes');
  });

  it('liberada a cota da CLI anterior, ela volta a valer (e a troca segue contando no teto)', async () => {
    stage(1, 'claude');
    h.dataTaps[0]('session-1', 'HOUR');
    await settle();
    // Dentro da hora: Claude ainda fora.
    vi.setSystemTime(Date.now() + 30 * 60_000);
    const second = stage(2, 'codex');
    h.dataTaps[0]('session-2', 'QUOTA');
    await settle();
    expect(vi.mocked(second.reroute).mock.calls[0]![0].excludeAdapterIds).toEqual(['codex', 'claude']);
    // Passada a hora, com conta livre no Claude, ele volta a ser elegível.
    vi.setSystemTime(Date.now() + 31 * 60_000);
    h.available.add('claude');
    const third = stage(3, 'kimi');
    h.dataTaps[0]('session-3', 'QUOTA');
    await settle();
    expect(vi.mocked(third.reroute).mock.calls[0]![0].excludeAdapterIds).toEqual(['kimi', 'codex']);
  });
});

describe('F-999: o pacote da troca de CLI sai redigido e neutralizado em todo caminho do Main', () => {
  it('pane do operador trocando no lugar: a cauda do terminal sai sem segredo', async () => {
    h.sessionOutput = `${hardWrap(dotenvDump(), 80)}\nYou exceeded your current quota`;
    rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
    h.dataTaps[0]('session-op', 'QUOTA');
    await settle();
    const pack = events()[0]?.continuityPack ?? '';
    expect(pack.startsWith(FAILOVER_HANDOFF_HEADER)).toBe(true);
    expect(pack).toContain('[REDACTED]');
    expectNoSecretFragment(pack);
  });

  it('tarefa de missão reaberta pela rota: o pedido anexado sai sem segredo', async () => {
    h.sessionOutput = hardWrap(dotenvDump(), 80);
    rendererPane({ paneId: 'pane-claude', sessionId: 'session-claude', missionId: 'mission-1' });
    const task = handle();
    registerPaneTaskReroute(task);
    h.dataTaps[0]('session-claude', 'QUOTA');
    await settle();
    const appended = vi.mocked(task.reroute).mock.calls[0]![0].appendPrompt ?? '';
    expect(appended).toContain(FAILOVER_HANDOFF_HEADER);
    expectNoSecretFragment(appended);
  });

  it('motivo insufficient_quota na 2ª linha: nenhuma janela que começa depois do header dispara', async () => {
    rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
    h.dataTaps[0]('session-op', 'INSQ');
    await settle();
    const pack = events()[0]?.continuityPack ?? '';
    expect(pack).toContain('No Claude account can take more work right now');
    const { detectLimit } = await vi.importActual<typeof import('./limit-detector')>('./limit-detector');
    for (let start = 1; start < pack.length; start += 1) {
      const hit = detectLimit(pack.slice(start, start + 4_000));
      if (hit) throw new Error(`janela em ${start} disparou ${hit.kind} (${hit.reason})`);
    }
  });
});


describe('fresh cross-window account exhaustion uses the real quota policy', () => {
  function measured(kind: 'hours' | 'weekly', usedRatio: number, healthyAlleged = false): ProviderQuotaEntry {
    return {
      id: 'claude:claude-a', adapterId: 'claude', accountId: 'claude-a', label: 'Account A',
      installed: true, onCooldown: false, updatedAt: Date.now(),
      windows: [
        { kind, label: kind, usedRatio, source: 'provider-api', confidence: 'high' },
        ...(healthyAlleged ? [{ kind: kind === 'hours' ? 'weekly' as const : 'hours' as const,
          label: 'healthy alleged window', usedRatio: 0.1, source: 'provider-api' as const, confidence: 'high' as const }] : []),
      ],
    };
  }

  it.each([
    ['LONG', 'weekly', 0.79, false], ['LONG', 'weekly', 0.8, false],
    ['LONG', 'weekly', 0.99, false], ['LONG', 'weekly', 1, true],
    ['QUOTA', 'hours', 0.79, false], ['QUOTA', 'hours', 0.8, false],
    ['QUOTA', 'hours', 0.99, false], ['QUOTA', 'hours', 1, true],
  ] as const)('live %s opposite %s at %s confirms only exhaustion (%s)', async (marker, kind, ratio, confirmed) => {
    h.realQuota = true;
    h.quotaEntry = measured(kind, ratio);
    h.probeEntry = h.quotaEntry;
    rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
    h.dataTaps[0]('session-op', marker);
    await settle();
    expect(resolver).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    expect(h.refreshQuota).toHaveBeenCalledTimes(confirmed ? 0 : 1);
    expect(events().at(-1)).toMatchObject(confirmed
      ? { cliSwitchPhase: 'requested', switched: false }
      : { switched: false, scheduledRetryAtMs: expect.any(Number) });
  });

  it.each(['live', 'probe', 'retry'] as const)('%s: exhausted opposite window overrides healthy alleged window', async (phase) => {
    h.realQuota = true;
    if (phase === 'live') h.quotaEntry = measured('weekly', 1, true);
    if (phase === 'probe') h.probeEntry = measured('weekly', 1, true);
    rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
    h.dataTaps[0]('session-op', 'LONG');
    await settle();
    if (phase === 'retry') {
      expect(resolver).not.toHaveBeenCalled();
      h.probeEntry = { ...measured('weekly', 1, true), updatedAt: Date.now() + 15 * 60_000 + 1_000 };
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
      await settle();
    }
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(events().at(-1)).toMatchObject({ cliSwitchPhase: 'requested', switched: false });
    // O recibo de sucesso exige sessão física nova, no mesmo pane.
    expect(events().some(event => event.switched)).toBe(false);
    h.sessions.set('session-op-2', { sessionId: 'session-op-2', paneId: 'pane-op', adapterId: 'codex' });
    h.states.set('session-op-2', 'busy');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(events().at(-1)).toMatchObject({ cliSwitchPhase: 'applied', switched: true });
  });

  it.each([0.79, 0.8, 0.99])('probe at opposite %s preserves the live account and capped retry', async (ratio) => {
    h.realQuota = true;
    h.probeEntry = measured('weekly', ratio);
    rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
    h.dataTaps[0]('session-op', 'LONG');
    await settle();
    expect(resolver).not.toHaveBeenCalled();
    expect(events().at(-1)).toMatchObject({ switched: false, scheduledRetryAtMs: expect.any(Number) });
  });

  it.each([0.79, 0.8, 0.99])('retry at opposite %s preserves matching-window healthy refutation', async (ratio) => {
    h.realQuota = true;
    rendererPane({ paneId: 'pane-op', sessionId: 'session-op' });
    h.dataTaps[0]('session-op', 'LONG');
    await settle();
    h.probeEntry = { ...measured('weekly', ratio, true), updatedAt: Date.now() + 15 * 60_000 + 1_000 };
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
    await settle();
    expect(resolver).not.toHaveBeenCalled();
    expect(events().some(event => event.switched)).toBe(false);
    expect(h.trace).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unconfirmed-refuted' }));
  });
});

describe('F-1410: limite do Muse (login nativo, sem conta gerenciada)', () => {
  it('célula de status confirmada: a CLI fica limitada até o reset e a tarefa segue em outra CLI', async () => {
    h.longNeedsApi = true;
    rendererPane({ paneId: 'pane-muse', sessionId: 'session-muse', adapterId: 'muse', accountId: '' });
    h.dataTaps[0]('session-muse', 'MUSE_CELL');
    await settle();
    expect(isCliLimited('muse')).toBe(true);
    expect(activeCliLimit('muse')?.until).toBe(Date.now() + 5 * 60 * 60_000);
    expect(h.trace).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'cli-limited', adapterId: 'muse' }));
    // Confirmado: sem a pausa de 15 min do F-249 — a troca de CLI sai na hora.
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0][0].excludeAdapterIds).toContain('muse');
  });

  it('F-249: a mesma frase solta (cat de log, handoff) não limita a CLI nem troca', async () => {
    h.longNeedsApi = true;
    rendererPane({ paneId: 'pane-muse', sessionId: 'session-muse', adapterId: 'muse', accountId: '' });
    h.dataTaps[0]('session-muse', 'MUSE_TEXT');
    await settle();
    expect(isCliLimited('muse')).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('a célula do Muse lida no pane de OUTRA CLI não põe o Muse em quarentena', async () => {
    h.longNeedsApi = true;
    rendererPane({ paneId: 'pane-kimi', sessionId: 'session-kimi', adapterId: 'kimi', accountId: '' });
    h.dataTaps[0]('session-kimi', 'MUSE_CELL');
    await settle();
    expect(isCliLimited('muse')).toBe(false);
    expect(isCliLimited('kimi')).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });
});
