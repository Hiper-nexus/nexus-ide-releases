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
import type { ProjectExecutionScope } from '../../shared/types';
import { ACCOUNT_CHANNELS, type FailoverEvent } from '../../shared/account-types';
import { FAILOVER_HANDOFF_HEADER } from '../../shared/failover-handoff';
import { testProjectScope } from './__tests__/scope-fixture';

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
  readSessionOutput: vi.fn(() => '$ npm test\n✓ 12 passed\nYou exceeded your current quota'),
  requestPaneClose: h.requestPaneClose,
}));
vi.mock('./tool-util', () => ({ injectPrompt: vi.fn() }));
vi.mock('../observability/main-trace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../observability/main-trace')>()),
  trace: h.trace,
}));
const HITS: Record<string, { kind: 'quota' | 'rate-limit' | 'auth'; reason: string; cooldownMs: number }> = {
  QUOTA: { kind: 'quota', reason: 'You exceeded your current quota', cooldownMs: 12 * 60 * 60_000 },
  SHORT: { kind: 'rate-limit', reason: 'rate limit — try again in 1 minute', cooldownMs: 60_000 },
  AUTH: { kind: 'auth', reason: '401 OAuth access token has expired', cooldownMs: 15 * 60_000 },
  LONG: { kind: 'rate-limit', reason: "You've hit your session limit", cooldownMs: 5 * 60 * 60_000 },
  HOUR: { kind: 'rate-limit', reason: 'Error: 429 Too Many Requests', cooldownMs: 60 * 60_000 },
};
vi.mock('./limit-detector', () => ({
  detectLimit: vi.fn((buffer: string) => {
    const marker = Object.keys(HITS).find((key) => buffer.includes(key));
    return marker ? HITS[marker] : null;
  }),
  tierScopeFromModelId: vi.fn(() => undefined),
}));
vi.mock('./limit-refutation', () => ({
  providerApiRefutesLimit: vi.fn(() => false),
  hasFreshProviderApiWindowForLimit: vi.fn(() => false),
  longCooldownNeedsFreshProviderApi: vi.fn(() => h.longNeedsApi),
}));
const ACCOUNTS: Record<string, { id: string; adapterId: string; label: string; mode: 'subscription'; upstream: string; createdAt: number }> = {
  'claude-a': { id: 'claude-a', adapterId: 'claude', label: 'gustavo@example.com', mode: 'subscription', upstream: 'anthropic', createdAt: 0 },
  'codex-a': { id: 'codex-a', adapterId: 'codex', label: 'ana@example.org', mode: 'subscription', upstream: 'openai', createdAt: 0 },
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
    throw new Error('quota optional in test');
  }),
}));
vi.mock('./failover-mission-respawn', () => ({
  respawnMainOwnedPaneWithAccount: h.respawnMainOwned,
  collectGitTaskState: vi.fn(async () => ({
    touchedFiles: ['src/login.ts'],
    diffStat: 'src/login.ts | 4 ++--',
  })),
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    handoffs: { submit: h.submit },
    missions: { get: () => ({ id: 'mission-1', orchestratorSessionId: 'session-maestro' }) },
  }),
}));
vi.mock('./idle-delivery', () => ({ onHandoffSubmitted: h.onHandoffSubmitted }));
vi.mock('../adapters/adapter-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/adapter-registry')>()),
  getAdapter: vi.fn((id: string) => {
    const label = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', grok: 'Grok' }[id];
    return label ? { id, label, models: { default: 'm', list: ['m'] } } : null;
  }),
  getAdapterResolvedBin: vi.fn(() => null),
}));

import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import {
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
import { resetPaneStartWatchdogForTests } from './pane-start-watchdog';

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
  h.requestPaneClose.mockClear().mockResolvedValue(true);
  h.respawnMainOwned.mockClear().mockResolvedValue(true);
  h.submit.mockClear();
  h.trace.mockClear();
  resolver.mockClear().mockResolvedValue({ adapterId: 'codex', model: 'gpt-6.1-sol' });
  setNextCliResolver(resolver);
  resetPaneTaskReroutesForTests();
  resetPaneStartWatchdogForTests();
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
