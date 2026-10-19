import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreEffectRefusalError, type AgentGateContext } from './gate';
import { compileIntentContract } from '../../shared/mission-intent';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  spawn: vi.fn(async (
    _options: Record<string, unknown>,
    hooks?: {
      onPaneCreated?: (p: string) => void;
      invocation?: { assertCurrentAuthority?: () => void };
      onPendingMissionPane?: (recorded: Promise<'recorded' | 'no-session' | 'unrecorded'>) => void;
      onSeatRemap?: (remap: { requested: string; reason: string; adapterId: string; model: string | null }) => void;
    },
  ) => {
    hooks?.onPaneCreated?.('pane-w');
    return { paneId: 'pane-w', sessionId: 'session-w' };
  }),
  pending: vi.fn((): unknown => null),
  injectPrompt: vi.fn(async (_sessionId: string, _text: string) => {}),
  judge: vi.fn(async () => null as Record<string, unknown> | null),
  recordDecision: vi.fn(() => 'dec-1'),
  semantic: vi.fn((_sessionId: string) => null as Record<string, unknown> | null),
  authority: vi.fn((_sessionId: string) => null as Record<string, unknown> | null),
  stdinWritable: vi.fn((_sessionId: string) => true),
  jevKey: { value: false },
  assertRouteReservation: vi.fn(),
  gateContext: vi.fn((_sessionId: string): AgentGateContext | null => null),
  assignVisualTask: vi.fn(() => true),
  consumeRouteReservation: vi.fn(),
  mission: {} as Record<string, unknown>,
  panes: [] as Array<Record<string, unknown>>,
  resumeSpec: null as Record<string, unknown> | null,
  providerSession: vi.fn((..._args: unknown[]): unknown => ({ key: 'session_id', id: 'provider-conversation' })),
  // F-797: expor o navegador ao worker não pode abrir aba nenhuma.
  requestBrowserPane: vi.fn(async () => ({ requestId: 'never', ok: false, error: 'não deveria ser chamado' })),
  catalogAgent: vi.fn((_ref: string): unknown => null),
}));
vi.mock('./tool-util', async (original) => ({
  ...(await original<typeof import('./tool-util')>()),
  spawnPaneAndMaybePrompt: h.spawn,
  injectPrompt: h.injectPrompt,
}));
vi.mock('./pane-registry', async (original) => ({
  ...(await original<typeof import('./pane-registry')>()),
  listPaneSnapshots: () => h.panes,
  takePendingPaneSpawnResult: () => h.pending(),
  getPaneRuntimeAuthorityBySession: (sessionId: string) => h.authority(sessionId),
  requestBrowserPane: h.requestBrowserPane,
}));
vi.mock('../pty/pty-manager', async (original) => ({
  ...(await original<typeof import('../pty/pty-manager')>()),
  isSessionStdinWritable: (sessionId: string) => h.stdinWritable(sessionId),
}));
vi.mock('./agent-status', async (original) => ({
  ...(await original<typeof import('./agent-status')>()),
  getAgentSemanticStatusBySession: (sessionId: string) => h.semantic(sessionId),
}));
vi.mock('../jev/jev-client', async (original) => ({
  ...(await original<typeof import('../jev/jev-client')>()),
  judge: h.judge,
}));
vi.mock('../jev/jev-secrets', async (original) => ({
  ...(await original<typeof import('../jev/jev-secrets')>()),
  hasJevCredential: () => h.jevKey.value,
}));
vi.mock('../jev/jev-decision-log', async (original) => ({
  ...(await original<typeof import('../jev/jev-decision-log')>()),
  recordJevDecision: h.recordDecision,
}));
vi.mock('./gate', async (original) => ({
  ...(await original<typeof import('./gate')>()),
  getContextBySession: h.gateContext,
  assertCurrentMissionOrchestratorSession: vi.fn(),
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => h.mission,
      assertRouteReservation: h.assertRouteReservation,
      consumeRouteReservation: h.consumeRouteReservation,
    },
    missionPanes: { list: () => [{ paneId: 'pane-w', role: 'worker' }], findByPaneId: () => h.resumeSpec, assignVisualTask: h.assignVisualTask },
  }),
}));
// F-1151: this suite is about routing. The durable reservation is proved in
// mission-pane-resume-ownership.test.ts; here it only mirrors the one contract the
// routing tests rely on: the native conversation captured at reservation must still
// be the current one at every later fence.
const continuationFixture = vi.hoisted(() => ({ baseline: '' }));
vi.mock('./mission-pane-resume-ownership', async original => ({
  ...(await original<typeof import('./mission-pane-resume-ownership')>()),
  reserveWorkerContinuation: () => {
    continuationFixture.baseline = JSON.stringify(h.providerSession());
    return { sourcePaneId: 'pane-old', attemptId: 'attempt-routing-fixture' };
  },
  assertWorkerContinuationCurrent: () => {
    if (JSON.stringify(h.providerSession()) !== continuationFixture.baseline) {
      throw new Error('resume_authority_changed: origem, conta, conversa ou tentativa mudou');
    }
    return {} as never;
  },
  rollbackWorkerContinuationBeforeBirth: () => true,
}));
vi.mock('../persistence/provider-session-store', async original => ({
  ...(await original<typeof import('../persistence/provider-session-store')>()),
  getProviderPaneSession: (...args: unknown[]) => h.providerSession(...args),
}));
vi.mock('./task-dispatch-authority', () => ({ isTaskQueueManagedMission: () => false }));
vi.mock('../adapters/adapter-registry', async (original) => ({
  ...(await original<typeof import('../adapters/adapter-registry')>()),
  // AGY lê o MCP do perfil nativo (canUseNexusMcp=false); Codex carrega o Nexus.
  listAdapters: () => [
    { id: 'agy', kind: 'cli-pty', bin: 'agy', quirks: { nexusMcp: 'agy' } },
    { id: 'devin', kind: 'cli-pty', bin: 'devin', quirks: { nexusMcp: 'none' } },
    { id: 'codex', kind: 'cli-pty', bin: 'codex', quirks: { nexusMcp: 'codex' } },
  ],
}));
vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: () => ({ getMissionWorkflow: () => ({ contract: null }) }),
}));
vi.mock('./squad-store', async (original) => ({
  ...(await original<typeof import('./squad-store')>()),
  findAgentInAnySquad: () => null,
  requireCatalogAgent: (ref: string) => h.catalogAgent(ref),
  getSquad: () => null,
  squadRoutableCliIds: () => new Set(['codex']),
}));
vi.mock('./operator-cli-mentions', () => ({
  OPERATOR_CHOICE_PROOF_WINDOW_MS: 30 * 60_000,
  operatorRecentlyNamedCli: vi.fn((): boolean => false),
}));
vi.mock('./operator-submitted-prompts', () => ({
  operatorNamedCliInSubmittedPrompts: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock('./isolated-writer-worktree', async (original) => ({
  ...(await original<typeof import('./isolated-writer-worktree')>()),
  resumeIsolatedWriterWorktree: () => null,
}));
// F-218 lê o cache real das CLIs para promover a linha do modelo pedido —
// o teste precisa de um conjunto determinístico (nenhum descoberto).
vi.mock('../adapters/cli-model-discovery', async (original) => ({
  ...(await original<typeof import('../adapters/cli-model-discovery')>()),
  discoverCliModels: () => new Map(),
}));

import { operatorRecentlyNamedCli } from './operator-cli-mentions';
import { operatorNamedCliInSubmittedPrompts } from './operator-submitted-prompts';

import { paneSpawnTool, reserveWorkerSpawnSlot, setOperatorRouteResolver, spawnRouteAuthority } from './tools-panes';
import { NEXUS_BROWSER_WORKER_TOOLS } from './nexus-browser-policy';
import type { MissionIntentContract } from '../../shared/mission-intent';

const ctx: AgentGateContext = {
  token: 'orch', label: 'Maestro', role: 'orchestrator', sessionId: 'orch-session',
  missionId: 'mission-a', scope: testProjectScope(),
  allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(operatorRecentlyNamedCli).mockImplementation(() => false);
  h.judge.mockResolvedValue(null);
  h.authority.mockReturnValue(null);
  h.semantic.mockReturnValue(null);
  h.stdinWritable.mockReturnValue(true);
  h.jevKey.value = false;
  h.panes = [];
  h.resumeSpec = null;
  h.gateContext.mockReturnValue(null);
  h.assignVisualTask.mockReturnValue(true);
  h.providerSession.mockReturnValue({ key: 'session_id', id: 'provider-conversation' });
  h.mission = {
    id: 'mission-a', title: 'Feature', description: '', status: 'running', squadId: 'squad',
    intentContract: { ...compileIntentContract({ goal: 'Feature', intentVersion: 1 }), maxWorkers: 8 },
  };
});

describe('nexus_pane_spawn dentro da missão sem adapterId', () => {
  const resumeSpec = () => ({
    id: 'composition-old', paneId: 'pane-old', missionId: ctx.missionId,
    adapterId: 'muse', model: 'muse-recorded-model', accountId: 'account-recorded', effort: 'high',
    title: 'Original', role: 'worker', scope: ctx.scope, executionScope: ctx.scope,
    cwd: ctx.scope.rootRealPath, readOnly: true, allowedTools: null, allowedSkills: null, createdAt: 1,
  });
  it('resumes a mission Muse pane without routing and preserves its recorded runtime', async () => {
    h.resumeSpec = resumeSpec();
    h.mission.intentContract = { ...(h.mission.intentContract as object), freeAgentChoice: true };
    const route = vi.fn(); setOperatorRouteResolver(route);
    await paneSpawnTool.handler({ resume: 'pane-old', prompt: 'continue' }, ctx);
    expect(route).not.toHaveBeenCalled();
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ adapterId: 'muse', model: 'muse-recorded-model',
      accountId: 'account-recorded', effort: 'high', readOnly: true, resumeFromPaneId: 'pane-old' });
  });
  it.each(['missing', 'foreign-mission', 'foreign-root', 'missing-conversation', 'mismatched-cli'])('refuses %s resume without starting a fresh pane', async scenario => {
    h.resumeSpec = resumeSpec();
    if (scenario === 'missing') h.resumeSpec = null;
    if (scenario === 'foreign-mission') h.resumeSpec!.missionId = 'other';
    if (scenario === 'foreign-root') h.resumeSpec!.scope = { ...ctx.scope, rootRealPath: '/other' };
    if (scenario === 'missing-conversation') h.providerSession.mockReturnValue(null);
    const route = vi.fn(); setOperatorRouteResolver(route);
    await expect(paneSpawnTool.handler({ resume: 'pane-old', ...(scenario === 'mismatched-cli' ? { adapterId: 'codex' } : {}) }, ctx)).rejects.toThrow(/resume/);
    expect(route).not.toHaveBeenCalled(); expect(h.spawn).not.toHaveBeenCalled();
  });
  it('rechecks the original conversation after asynchronous preparation', async () => {
    h.resumeSpec = resumeSpec();
    h.mission.intentContract = { ...(h.mission.intentContract as object), freeAgentChoice: true };
    h.spawn.mockImplementationOnce(async (_options, hooks) => {
      await Promise.resolve();
      h.providerSession.mockReturnValue({ key: 'session_id', id: 'replacement' });
      hooks!.invocation!.assertCurrentAuthority!();
      return { paneId: 'pane-w', sessionId: 'session-w' };
    });
    await expect(paneSpawnTool.handler({ resume: 'pane-old' }, ctx)).rejects.toThrow('resume_authority_changed');
  });
  it('never allocates a replacement when the original isolated worktree cannot be resumed', async () => {
    h.resumeSpec = { ...resumeSpec(), cwd: '/missing-original', executionScope: { ...ctx.scope, rootRealPath: '/missing-original' } };
    h.mission.intentContract = { ...(h.mission.intentContract as object), freeAgentChoice: true };
    await expect(paneSpawnTool.handler({ resume: 'pane-old' }, ctx)).rejects.toThrow('resume_worktree_unavailable');
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it('roteia pela task da missão e consome a RouteReservation devolvida', async () => {
    const resolver = vi.fn(async () => ({
      adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-1', tier: 'medium',
    }));
    setOperatorRouteResolver(resolver);
    const receipt = await paneSpawnTool.handler(
      { task: 'implementar o login', prompt: 'faça o login', model: 'ignorado' }, ctx,
    ) as Record<string, any>;
    expect(resolver).toHaveBeenCalledWith('implementar o login', ctx, { classificationPrompt: 'faça o login' });
    expect(h.assertRouteReservation).toHaveBeenCalledWith({
      reservationId: 'rr-1', missionId: 'mission-a', adapterId: 'codex', model: 'gpt-5.4', effort: 'high',
    });
    expect(h.consumeRouteReservation).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'rr-1' }), 'orch-session');
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ adapterId: 'codex', model: 'gpt-5.4', role: 'worker', missionId: 'mission-a' });
    expect(receipt.harness.source).toBe('auto-route');
    expect(receipt.route.tier).toBe('medium');
    expect(receipt.route.ignored).toEqual({ model: 'ignorado' });
  });

  it.each([false, true])('recibo com remap mostra o harness real (pending=%s)', async (pending) => {
    h.mission.intentContract = { ...(h.mission.intentContract as object), freeAgentChoice: true };
    setOperatorRouteResolver(vi.fn(async () => ({
      adapterId: 'muse', model: 'muse-wonder-full-1.0', routeReservationId: 'rr-remap',
    })));
    h.spawn.mockImplementationOnce(async (_options, hooks) => {
      hooks?.onSeatRemap?.({
        requested: 'muse', reason: '[missing-credential] muse: login',
        adapterId: 'openclaude', model: 'sonnet',
      });
      if (pending) throw new Error('pane spawn failed');
      return { paneId: 'pane-w', sessionId: 'session-w' };
    });
    if (pending) {
      h.pending.mockReturnValueOnce({
        requestId: 'req-remap', ok: true, paneId: 'pane-w', sessionId: null, pending: true,
      });
    }
    const receipt = await paneSpawnTool.handler(
      { task: 'implementar o login', prompt: 'faça o login' }, ctx,
    ) as Record<string, any>;
    expect(receipt.pending === true).toBe(pending);
    expect(receipt.harness).toMatchObject({
      adapterId: 'openclaude', model: 'sonnet',
      seatRemap: { requested: 'muse', reason: '[missing-credential] muse: login' },
    });
  });

  // F-1477 (revisão Codex): a rota dentro da missão não sabia que o pane era
  // somente leitura — a diversificação da revisão informativa nunca chegava.
  it.each([
    ['readOnly do pedido', { readOnly: true }, {}, { readOnly: true, informativeReview: true }],
    ['readOnly herdado do chamador', {}, { readOnly: true }, { readOnly: true, informativeReview: true }],
    ['writer isolado rotulado readOnly', { readOnly: true, isolatedWriter: true }, {}, { readOnly: true }],
  ] as const)('F-1477: a rota da missão recebe a autoridade efetiva (%s)', async (_label, extraArgs, extraCtx, expected) => {
    const resolver = vi.fn(async () => ({ adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-ro' }));
    setOperatorRouteResolver(resolver);
    const caller = { ...ctx, ...extraCtx };
    await paneSpawnTool.handler({ task: 'revisar a segurança da migração', prompt: 'revise', ...extraArgs }, caller)
      .catch(() => undefined);
    const internal = (resolver.mock.calls[0] as unknown[] | undefined)?.[2] as Record<string, unknown> | undefined;
    expect(internal).toBeDefined();
    expect({ readOnly: internal!.readOnly, informativeReview: internal!.informativeReview })
      .toEqual({ informativeReview: undefined, ...expected });
  });

  it('F-1477: spawnRouteAuthority — informativa só quando somente leitura e sem worktree de escrita', () => {
    expect(spawnRouteAuthority({}, {})).toEqual({});
    expect(spawnRouteAuthority({ readOnly: true }, {})).toEqual({ readOnly: true, informativeReview: true });
    expect(spawnRouteAuthority({}, { readOnly: true })).toEqual({ readOnly: true, informativeReview: true });
    expect(spawnRouteAuthority({ readOnly: true, isolatedWriter: true }, {})).toEqual({ readOnly: true });
    expect(spawnRouteAuthority({ isolatedWriter: true }, {})).toEqual({});
  });

  // F-1477 (re-veredito): o pane que a rota informativa tirou de Claude/Codex
  // numa tarefa de segurança crítica nasce marcado — o approve dele nunca
  // satisfaz o portão de integração, seja qual for a missão.
  it.each([
    ['Grok informativo em segurança crítica', 'grok', { readOnly: true }, true],
    ['Claude em segurança crítica (juiz de sempre)', 'claude', { readOnly: true }, false],
    ['Grok sem readOnly (rota de writer)', 'grok', {}, false],
  ] as const)('F-1477: marca de revisão informativa no spawn — %s', async (_label, adapterId, extraArgs, marked) => {
    const resolver = vi.fn(async () => ({
      adapterId, model: 'fixture-model', effort: 'high', routeReservationId: 'rr-sec', tier: 'critical', specialty: 'security',
    }));
    setOperatorRouteResolver(resolver);
    // Escolha livre: o roster do squad não restringe a CLI roteada.
    h.mission.intentContract = { ...(h.mission.intentContract as object), freeAgentChoice: true };
    await paneSpawnTool.handler({ task: 'auditar a segurança da auth antes do merge', prompt: 'audite', ...extraArgs }, ctx)
      .catch(() => undefined);
    expect(h.spawn).toHaveBeenCalled();
    const options = h.spawn.mock.calls[0][0] as { informativeReview?: true };
    expect(options.informativeReview === true).toBe(marked);
  });

  it('carries the visual routing specialty even when the brief has no UI keyword', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex', routeReservationId: 'rr-visual', specialty: 'visual' })));
    await paneSpawnTool.handler({ task: 'continuar o trabalho', prompt: 'siga a atribuição' }, ctx);
    expect(h.spawn.mock.calls[0][0].visualTask).toEqual({ since: expect.any(Number), id: expect.any(String) });
  });

  it('F-793: worker com ACK pendente segura a vaga de maxWorkers até a linha durável existir', async () => {
    let settle: (outcome: 'recorded') => void = () => {};
    const recorded = new Promise<'recorded'>((resolve) => {
      settle = resolve;
    });
    h.spawn.mockImplementationOnce(async (_options, hooks) => {
      hooks?.onPendingMissionPane?.(recorded);
      throw new Error('pane spawn failed');
    });
    h.pending.mockReturnValueOnce({
      requestId: 'req-w', ok: true, paneId: 'pane-w', sessionId: null, pending: true,
    });
    setOperatorRouteResolver(vi.fn(async () => ({
      adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-p',
    })));
    const receipt = await paneSpawnTool.handler(
      { task: 'implementar o login', prompt: 'faça o login' }, ctx,
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({ paneId: 'pane-w', pending: true });

    const contract = h.mission.intentContract as MissionIntentContract;
    const probe = () => reserveWorkerSpawnSlot({
      scope: ctx.scope,
      missionId: 'mission-a',
      contract: { ...contract, budgets: { ...contract.budgets, maxWorkers: 1 } },
      currentWorkerCount: 0,
      allowedTools: null,
    });
    // Sem linha durável ainda: é a reserva que conta o worker pendente.
    expect(probe().ok).toBe(false);

    settle('recorded');
    await recorded;
    await Promise.resolve();
    const after = probe();
    expect(after.ok).toBe(true);
    if (after.ok) after.release();
  });

  it('tentativa abortada antes do spawn fecha a reserva do auto-roteamento', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({
      adapterId: 'kimi', model: 'kimi-k2', routeReservationId: 'rr-abort',
    })));
    await expect(paneSpawnTool.handler({ task: 'implementar o login' }, ctx)).rejects.toThrow();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.consumeRouteReservation).toHaveBeenCalledWith(
      { reservationId: 'rr-abort', missionId: 'mission-a', adapterId: 'kimi', model: 'kimi-k2' },
      'orch-session',
    );
  });

  it('no modo livre a reserva criada pelo auto-roteamento é consumida, não fica pendurada', async () => {
    h.mission = {
      ...h.mission,
      intentContract: { ...(h.mission.intentContract as object), freeAgentChoice: true },
    };
    setOperatorRouteResolver(vi.fn(async () => ({
      adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-free',
    })));
    await paneSpawnTool.handler({ task: 'implementar o login', prompt: 'faça o login' }, ctx);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.consumeRouteReservation).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'rr-free', adapterId: 'codex', model: 'gpt-5.4' }),
      'orch-session',
    );
  });

  it('só com task, o worker recebe a task como tarefa (não nasce sem brief)', async () => {
    h.mission = {
      ...h.mission,
      intentContract: { ...(h.mission.intentContract as object), freeAgentChoice: true },
    };
    setOperatorRouteResolver(vi.fn(async () => ({
      adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-task',
    })));
    await paneSpawnTool.handler({ task: 'implementar o login com OTP' }, ctx);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(String(h.spawn.mock.calls[0][0].prompt)).toContain('implementar o login com OTP');
  });

  it('pin sem menção do operador vira preferência suave e passa pelo roteador', async () => {
    const resolver = vi.fn(async () => ({
      adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-pin',
    }));
    setOperatorRouteResolver(resolver);
    const receipt = await paneSpawnTool.handler(
      { adapterId: 'claude', model: 'claude-opus-5-5', task: 'olha o repo', prompt: 'olhe' },
      ctx,
    ) as Record<string, any>;
    expect(resolver).toHaveBeenCalledWith('olha o repo', ctx, {
      classificationPrompt: 'olhe',
      preferAdapterIds: ['claude'],
    });
    expect(h.spawn.mock.calls[0][0]).toMatchObject({
      adapterId: 'codex', model: 'gpt-5.4', effort: 'high',
    });
    expect(receipt.route).toMatchObject({
      redistributed: { adapterId: 'claude', model: 'claude-opus-5-5', reason: 'pin-sem-pedido-do-operador' },
      ignored: { model: 'claude-opus-5-5' },
    });
  });

  it('pin com a CLI digitada pelo operador na sessão é honrado literalmente', async () => {
    vi.mocked(operatorRecentlyNamedCli).mockImplementation(
      (_sessionId, adapterId) => adapterId === 'codex',
    );
    const resolver = vi.fn(async () => ({ adapterId: 'kimi' }));
    setOperatorRouteResolver(resolver);
    await expect(
      paneSpawnTool.handler({ adapterId: 'codex', model: 'gpt-5.4', task: 'olha o repo' }, ctx),
    ).rejects.toThrow(/route_reservation_required/);
    expect(operatorRecentlyNamedCli).toHaveBeenCalledWith('orch-session', 'codex');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('pin com resume é honrado literalmente, sem rotear', async () => {
    h.resumeSpec = { ...resumeSpec(), adapterId: 'claude' };
    h.mission = {
      ...h.mission,
      squadId: undefined,
      intentContract: {
        ...(h.mission.intentContract as object),
        freeAgentChoice: true,
        workspaceBinding: { version: 1, adoptedPaneId: 'pane-operador' },
      },
    };
    const resolver = vi.fn(async () => ({ adapterId: 'kimi' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler({ adapterId: 'claude', resume: 'pane-old', task: 'olha o repo' }, ctx);
    expect(resolver).not.toHaveBeenCalled();
    expect(h.spawn.mock.calls[0][0]).toMatchObject({
      adapterId: 'claude', resume: true, resumeFromPaneId: 'pane-old',
    });
  });

  it('pin com routeReservationId consome a reserva sem rotear', async () => {
    const resolver = vi.fn(async () => ({ adapterId: 'kimi' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler(
      { adapterId: 'codex', routeReservationId: 'rr-1', task: 'olha o repo', prompt: 'olhe' },
      ctx,
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(h.consumeRouteReservation).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'rr-1', adapterId: 'codex' }),
      'orch-session',
    );
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ adapterId: 'codex' });
  });

  it('pane do "+ Pane" na missão da aba só roteia helper para CLI com MCP do Nexus (F-658)', async () => {
    // Campo 28/09: a missão sob demanda levou os helpers do operador à rota de
    // missão, que aceitava AGY — três panes mudos no `--print`. F-697: o AGY
    // ganhou o MCP do Nexus (ponte no perfil nativo) e volta à rota; quem
    // continua sem MCP (Devin) segue fora.
    const resolver = vi.fn(async () => ({
      adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-tab',
    }));
    setOperatorRouteResolver(resolver);
    const operatorTab = { ...ctx, promotedFromUserSession: true as const };
    await paneSpawnTool.handler({ task: 'mapear as telas', prompt: 'mapeie' }, operatorTab);
    expect(resolver).toHaveBeenCalledWith('mapear as telas', operatorTab, {
      classificationPrompt: 'mapeie',
      excludeAdapterIds: ['devin'],
    });
  });

  it('sem task nem prompt pede a tarefa', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex' })));
    await expect(paneSpawnTool.handler({}, ctx)).rejects.toThrow(/descreva a tarefa/);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe('pin de adapterId sem pedido do operador vira preferência (F-674 ampliado)', () => {
  const tabMission = () => ({
    ...h.mission,
    squadId: undefined,
    intentContract: {
      ...(h.mission.intentContract as object),
      freeAgentChoice: true,
      workspaceBinding: { version: 1, adoptedPaneId: 'pane-operador' },
    },
  });
  const userCtx: AgentGateContext = {
    ...ctx, role: 'user', missionId: undefined, sessionId: 'user-session',
  };

  it('orquestrador da missão da aba fixa claude sem menção: roteado com a CLI como preferência', async () => {
    h.mission = tabMission();
    const resolver = vi.fn(async () => ({ adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-div' }));
    setOperatorRouteResolver(resolver);
    const receipt = await paneSpawnTool.handler(
      { adapterId: 'claude', model: 'claude-opus-5-5', task: 'revisar o kanban', prompt: 'revise' }, ctx,
    ) as Record<string, any>;
    expect(resolver).toHaveBeenCalledWith('revisar o kanban', ctx, {
      classificationPrompt: 'revise',
      preferAdapterIds: ['claude'],
    });
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ adapterId: 'codex', model: 'gpt-5.4' });
    expect(receipt.route.redistributed).toEqual({
      adapterId: 'claude',
      model: 'claude-opus-5-5',
      reason: 'pin-sem-pedido-do-operador',
      hint: 'Passe operatorChoice:true quando o operador pedir esta CLI.',
    });
  });

  it('operatorChoice:true respeita a CLI que o operador pediu (com a prova do pedido)', async () => {
    h.mission = tabMission();
    // O operador nomeou a CLI no pane ou pelo Quadro dentro da retenção.
    vi.mocked(operatorRecentlyNamedCli).mockImplementation(
      (_session, adapterId, _now, windowMs) => adapterId === 'claude' && windowMs === 30 * 60_000,
    );
    const resolver = vi.fn(async () => ({ adapterId: 'codex' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler(
      { adapterId: 'claude', model: 'claude-opus-5-5', operatorChoice: true, task: 'revisar', prompt: 'revise' }, ctx,
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ adapterId: 'claude' });
  });

  it('F-1418: "usa devin e muse" aceito no meio do turno (só no transcript) honra o pin do Devin', async () => {
    h.mission = tabMission();
    // Campo 12/10: o tap não viu o texto (sugestão aceita); o prompt humano
    // registrado pela CLI, casado com o Enter humano, prova o pedido.
    vi.mocked(operatorNamedCliInSubmittedPrompts).mockImplementation(
      async (session, adapterId, _now, windowMs) =>
        session === 'orch-session' && (adapterId === 'devin' || adapterId === 'muse') && windowMs === 30 * 60_000,
    );
    const resolver = vi.fn(async () => ({ adapterId: 'kimi', model: 'kimi-code/k3' }));
    setOperatorRouteResolver(resolver);
    const receipt = await paneSpawnTool.handler(
      { adapterId: 'devin', operatorChoice: true, task: 'escrever testes de roteamento', prompt: 'escreva' }, ctx,
    ) as Record<string, any>;
    expect(resolver).not.toHaveBeenCalled();
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ adapterId: 'devin' });
    expect(receipt.route?.redistributed).toBeUndefined();
    vi.mocked(operatorNamedCliInSubmittedPrompts).mockReset();
    vi.mocked(operatorNamedCliInSubmittedPrompts).mockResolvedValue(false);
  });

  it('F-682: operatorChoice marcado pelo Maestro sem o operador pedir é ignorado e roteado', async () => {
    // Campo 29/09 (RU-261): 4 de 4 helpers Claude com operatorChoice:true e
    // nenhuma menção do operador — a flag é afirmação do agente, não prova.
    h.mission = tabMission();
    const resolver = vi.fn(async () => ({ adapterId: 'mimo-code', model: 'xiaomi/mimo-v2.6-pro', routeReservationId: 'rr-oc' }));
    setOperatorRouteResolver(resolver);
    const receipt = await paneSpawnTool.handler(
      { adapterId: 'claude', model: 'claude-opus-5-5', operatorChoice: true, task: 'melhorar o visual do pipeline', prompt: 'melhore' }, ctx,
    ) as Record<string, any>;
    expect(resolver).toHaveBeenCalledWith('melhorar o visual do pipeline', ctx, {
      classificationPrompt: 'melhore',
      preferAdapterIds: ['claude'],
    });
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ adapterId: 'mimo-code' });
    expect(receipt.route.redistributed).toMatchObject({
      adapterId: 'claude',
      reason: 'operatorChoice-sem-pedido-do-operador',
    });
  });

  it('mão do operador com pin explícito sem menção é roteada com preferência', async () => {
    const resolver = vi.fn(async () => ({ adapterId: 'codex', model: 'gpt-5.4' }));
    setOperatorRouteResolver(resolver);
    const receipt = await paneSpawnTool.handler(
      { adapterId: 'claude', task: 'olha o repo', prompt: 'olhe' }, userCtx,
    ) as Record<string, any>;
    expect(resolver).toHaveBeenCalledWith('olha o repo', userCtx, {
      classificationPrompt: 'olhe',
      tieBreakUseCounts: expect.anything(),
      excludeAdapterIds: [],
      preferAdapterIds: ['claude'],
    });
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ adapterId: 'codex' });
    expect(receipt.harness.source).toBe('auto-route');
    expect(receipt.route.redistributed).toMatchObject({
      adapterId: 'claude', reason: 'pin-sem-pedido-do-operador',
    });
  });

  it('agentName fora do roster sem adapterId nem task segue recusado', async () => {
    const resolver = vi.fn(async () => ({ adapterId: 'codex' }));
    setOperatorRouteResolver(resolver);
    await expect(paneSpawnTool.handler({ agentName: 'Worker' }, ctx))
      .rejects.toThrow(/unknown squad agent/);
    expect(resolver).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('agentName livre com task é só o rótulo do worker: o spawn segue roteado', async () => {
    // Campo 15/10: "Builder-Unshackle-Fences" + task caía em unknown squad agent.
    const resolver = vi.fn(async () => ({ adapterId: 'codex', routeReservationId: 'rr-label' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler(
      { agentName: 'Builder-Unshackle-Fences', task: 'remover cercas do handoff' }, ctx,
    );
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.spawn.mock.calls[0][0]).toMatchObject({
      adapterId: 'codex', title: 'Builder-Unshackle-Fences', missionId: 'mission-a',
    });
    expect(h.spawn.mock.calls[0][0].agentName).toBeUndefined();
  });

  it.each([
    ['desconhecido', 'unknown squad agent: Fantasma — nenhum squad salvo tem esse agente', {}],
    ['ambíguo mesmo com task', 'agente ambíguo: Fantasma existe em mais de um squad salvo', { task: 'x' }],
  ])('F-1388: recusa do catálogo (%s) é pré-efeito', async (_label, message, extra) => {
    // F-1334: nenhum efeito pode ter sido cometido — nada foi reservado/gravado.
    h.mission = { ...h.mission, squadId: undefined };
    h.catalogAgent.mockImplementation(() => {
      throw new Error(message);
    });
    const resolver = vi.fn(async () => ({ adapterId: 'codex' }));
    setOperatorRouteResolver(resolver);
    await expect(paneSpawnTool.handler({ agentName: 'Fantasma', ...extra }, ctx))
      .rejects.toBeInstanceOf(PreEffectRefusalError);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('F-1314: missão de agente livre usa o agente do catálogo com a CLI selada dele', async () => {
    // Campo 12/10: `agentName` numa missão Autopilot sem squad recusava com
    // "squad agent spawn requires a mission bound to a squad".
    h.mission = {
      ...h.mission,
      squadId: undefined,
      intentContract: { ...(h.mission.intentContract as object), freeAgentChoice: true },
    };
    h.catalogAgent.mockReturnValue({
      squad: { id: 'kimi-squad', agents: [] },
      agent: { id: 'kimi-writer', agentName: 'Kimi Writer', category: 'executor', cli: 'kimi', allowedTools: [] },
    });
    const resolver = vi.fn(async () => ({ adapterId: 'codex' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler({ agentName: 'Kimi Writer', task: 'implementar a interface' }, ctx);
    expect(h.catalogAgent).toHaveBeenCalledWith('Kimi Writer');
    expect(resolver).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ adapterId: 'kimi', agentName: 'Kimi Writer', missionId: 'mission-a' });
  });

  it('mão do operador que digitou a CLI no próprio pane tem o pin honrado', async () => {
    vi.mocked(operatorRecentlyNamedCli).mockImplementation(
      (sessionId, adapterId) => sessionId === 'user-session' && adapterId === 'claude',
    );
    const resolver = vi.fn(async () => ({ adapterId: 'codex' }));
    setOperatorRouteResolver(resolver);
    const receipt = await paneSpawnTool.handler(
      { adapterId: 'claude', task: 'olha o repo', prompt: 'olhe' }, userCtx,
    ) as Record<string, any>;
    expect(resolver).not.toHaveBeenCalled();
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ adapterId: 'claude' });
    expect(receipt.harness.source).toBe('explicit');
    expect(receipt.route).toBeUndefined();
  });
});

describe('reuso de helper ocioso (helperReuse)', () => {
  const tabMission = () => ({
    ...h.mission,
    squadId: undefined,
    intentContract: {
      ...(h.mission.intentContract as object),
      freeAgentChoice: true,
      workspaceBinding: { version: 1, adoptedPaneId: 'pane-operador' },
    },
  });
  const helperIdle = (over: Record<string, unknown> = {}) => ({
    paneId: 'pane-h1', sessionId: 'sess-h1', kind: 'cli-agent',
    title: 'Auxiliar', adapterId: 'codex', state: 'idle', ...over,
  });
  const idleSemantic = (sessionId: string, updatedAt = Date.now() - 60_000) =>
    ({ status: 'idle', sessionId, paneId: 'pane-h1', updatedAt }) as never;
  const judgePick = (choice: string, confidence: number) =>
    h.judge.mockResolvedValue({
      model: 'jev-m',
      answers: { pick: { type: 'choice', choice, probabilities: {}, confidence } },
      usage: { input_tokens: 12, output_tokens: 3 },
    } as never);

  it('missão da aba: helper ocioso da mesma CLI com contexto recebe a tarefa (sem spawn)', async () => {
    h.mission = tabMission();
    h.jevKey.value = true;
    setOperatorRouteResolver(vi.fn(async () => ({
      adapterId: 'codex', routeReservationId: 'rr-reuse',
    })));
    h.panes = [helperIdle({ missionId: 'mission-a', role: 'worker' })];
    h.semantic.mockImplementation((sid) => (sid === 'sess-h1' ? idleSemantic(sid) : null));
    h.authority.mockImplementation((sid) =>
      sid === 'sess-h1' ? ({ role: 'worker', missionId: 'mission-a' } as never) : null);
    judgePick('h1', 0.8);
    const receipt = await paneSpawnTool.handler(
      { task: 'continuar a refatoração do parser', prompt: 'siga com o parser' }, ctx,
    ) as Record<string, any>;
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.injectPrompt).toHaveBeenCalledWith(
      'sess-h1',
      expect.stringContaining('nexus_handoff_submit'),
      undefined,
    );
    expect(h.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'helperReuse', decision: 'reuse:h1' }),
    );
    expect(receipt).toMatchObject({
      paneId: 'pane-h1', sessionId: 'sess-h1', reused: true,
      reusedReason: 'helper ocioso com contexto relacionado (Jev 0.8)',
      harness: { source: 'reuse' },
    });
  });

  it('resposta none do Jev cai no spawn normal', async () => {
    h.mission = tabMission();
    h.jevKey.value = true;
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex' })));
    h.panes = [helperIdle({ missionId: 'mission-a', role: 'worker' })];
    h.semantic.mockImplementation((sid) => (sid === 'sess-h1' ? idleSemantic(sid) : null));
    judgePick('none', 0.9);
    await paneSpawnTool.handler({ task: 'nova feature', prompt: 'faça' }, ctx);
    expect(h.injectPrompt).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('confiança abaixo de 0.7 cai no spawn normal', async () => {
    h.mission = tabMission();
    h.jevKey.value = true;
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex' })));
    h.panes = [helperIdle({ missionId: 'mission-a', role: 'worker' })];
    h.semantic.mockImplementation((sid) => (sid === 'sess-h1' ? idleSemantic(sid) : null));
    judgePick('h1', 0.55);
    await paneSpawnTool.handler({ task: 'nova feature', prompt: 'faça' }, ctx);
    expect(h.injectPrompt).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('fresh:true sempre spawna, sem consultar o Jev', async () => {
    h.mission = tabMission();
    h.jevKey.value = true;
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex' })));
    h.panes = [helperIdle({ missionId: 'mission-a', role: 'worker' })];
    h.semantic.mockImplementation((sid) => (sid === 'sess-h1' ? idleSemantic(sid) : null));
    await paneSpawnTool.handler(
      { task: 'nova feature', prompt: 'faça', fresh: true }, ctx,
    );
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.injectPrompt).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('helper ocupado ou de outra CLI não é candidato', async () => {
    h.mission = tabMission();
    h.jevKey.value = true;
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex' })));
    h.panes = [
      helperIdle({ paneId: 'pane-b', sessionId: 'sess-b', state: 'busy', missionId: 'mission-a', role: 'worker' }),
      helperIdle({ paneId: 'pane-c', sessionId: 'sess-c', adapterId: 'claude', missionId: 'mission-a', role: 'worker' }),
    ];
    h.semantic.mockImplementation((sid) => (sid ? idleSemantic(sid) : null));
    await paneSpawnTool.handler({ task: 'nova feature', prompt: 'faça' }, ctx);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('tarefa de revisão nunca reutiliza helper writer', async () => {
    h.mission = tabMission();
    h.jevKey.value = true;
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex' })));
    h.panes = [helperIdle({ missionId: 'mission-a', role: 'worker', readOnly: false })];
    h.semantic.mockImplementation((sid) => (sid === 'sess-h1' ? idleSemantic(sid) : null));
    await paneSpawnTool.handler(
      { task: 'revise a entrega do parser', prompt: 'revise' }, ctx,
    );
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('missão com squad nunca reutiliza', async () => {
    h.jevKey.value = true;
    setOperatorRouteResolver(vi.fn(async () => ({
      adapterId: 'codex', routeReservationId: 'rr-squad',
    })));
    h.panes = [helperIdle({ missionId: 'mission-a', role: 'worker' })];
    h.semantic.mockImplementation((sid) => (sid === 'sess-h1' ? idleSemantic(sid) : null));
    await paneSpawnTool.handler({ task: 'nova feature', prompt: 'faça' }, ctx);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('falha na entrega do prompt cai no spawn normal', async () => {
    h.mission = tabMission();
    h.jevKey.value = true;
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex' })));
    h.panes = [helperIdle({ missionId: 'mission-a', role: 'worker' })];
    h.semantic.mockImplementation((sid) => (sid === 'sess-h1' ? idleSemantic(sid) : null));
    judgePick('h1', 0.8);
    h.injectPrompt.mockRejectedValueOnce(new Error('sessão morta'));
    await paneSpawnTool.handler({ task: 'nova feature', prompt: 'faça' }, ctx);
    expect(h.injectPrompt).toHaveBeenCalledTimes(1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('mão do operador sem missão: filho ocioso da mesma CLI recebe a tarefa', async () => {
    h.jevKey.value = true;
    const userCtx = {
      ...ctx, role: 'user' as const, missionId: undefined, sessionId: 'op-session',
    };
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex', model: 'gpt-5.4' })));
    h.panes = [helperIdle()];
    h.semantic.mockImplementation((sid) => (sid === 'sess-h1' ? idleSemantic(sid) : null));
    h.authority.mockImplementation((sid) =>
      sid === 'sess-h1' ? ({ operatorParentSessionId: 'op-session' } as never) : null);
    h.gateContext.mockReturnValue({ ...userCtx, token: 'helper-token', sessionId: 'sess-h1' });
    judgePick('h1', 0.9);
    const receipt = await paneSpawnTool.handler(
      { task: 'ajeitar o rodapé', prompt: 'arrume o rodapé' }, userCtx,
    ) as Record<string, any>;
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.injectPrompt).toHaveBeenCalledWith(
      'sess-h1', expect.stringContaining('arrume o rodapé'), undefined,
    );
    expect(receipt).toMatchObject({
      paneId: 'pane-h1', sessionId: 'sess-h1', reused: true,
      harness: { source: 'reuse' },
    });
  });
});

/**
 * F-797: o worker de missão que o orquestrador abre sem roster nem allowlist
 * explícita nascia com `[]` e nunca enxergava o navegador do Nexus — os 30
 * workers da missão Terminais. Agora leva as tools de página por padrão;
 * a exposição não abre aba (aba só nasce em nexus_browser_open).
 */
describe('F-797: worker de missão nasce com as tools de página do navegador do Nexus', () => {
  const route = () =>
    setOperatorRouteResolver(vi.fn(async () => ({
      adapterId: 'codex', model: 'gpt-5.4', effort: 'high', routeReservationId: 'rr-797',
    })));

  it('spawn padrão (sem allowedTools): só leitura e extração, e nenhuma aba abre', async () => {
    route();
    await paneSpawnTool.handler({ task: 'ler a documentação da API', prompt: 'leia' }, ctx);
    const options = h.spawn.mock.calls[0][0] as { allowedTools?: unknown; role?: string; readOnly?: boolean };
    expect(options).toMatchObject({ role: 'worker', missionId: 'mission-a' });
    expect(options.allowedTools).toEqual([...NEXUS_BROWSER_WORKER_TOOLS]);
    expect(options.allowedTools).not.toContain('nexus_browser_click');
    expect(options.allowedTools).not.toContain('nexus_browser_fill');
    expect(h.requestBrowserPane).not.toHaveBeenCalled();
  });

  it('analista somente leitura continua sem o navegador (não pode abrir aba)', async () => {
    route();
    await paneSpawnTool.handler({ task: 'revisar o código', prompt: 'revise', readOnly: true }, ctx);
    const options = h.spawn.mock.calls[0][0] as { allowedTools?: unknown; readOnly?: boolean };
    expect(options.readOnly).toBe(true);
    expect(options.allowedTools).toEqual([]);
  });

  it('allowedTools explícita só estreita o padrão (F-247)', async () => {
    route();
    await paneSpawnTool.handler(
      { task: 'ler a página', prompt: 'leia', allowedTools: ['nexus_browser_read', 'nexus_browser_click'] },
      ctx,
    );
    const options = h.spawn.mock.calls[0][0] as { allowedTools?: unknown };
    expect(options.allowedTools).toEqual(['nexus_browser_read']);
  });

  it('orquestrador com allowlist restrita não escala: o worker fica sem o navegador', async () => {
    route();
    await paneSpawnTool.handler(
      { task: 'ler a página', prompt: 'leia' },
      { ...ctx, allowedTools: ['nexus_pane_spawn', 'nexus_pane_read'] },
    );
    const options = h.spawn.mock.calls[0][0] as { allowedTools?: unknown };
    expect(options.allowedTools).toEqual([]);
  });
});
