/**
 * F-723: o `nexus_pane_spawn` com ACK pendente registra a ficha do watchdog de
 * início, e o "mandar para outro" reabre o MESMO pedido pelo handler inteiro
 * — rota da missão com a CLI que falhou fora, reserva nova consumida, pin e
 * reserva antiga descartados — com a autoridade atual de quem pediu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { compileIntentContract } from '../../shared/mission-intent';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  nextPending: null as Record<string, unknown> | null,
  assertRouteReservation: vi.fn(),
  consumeRouteReservation: vi.fn(),
  mission: {} as Record<string, unknown>,
  liveCtx: null as unknown,
  current: true,
  mentionedCli: null as string | null,
  resumeWorktree: vi.fn((..._args: unknown[]) => null),
}));
vi.mock('./tool-util', async (original) => ({
  ...(await original<typeof import('./tool-util')>()),
  spawnPaneAndMaybePrompt: h.spawn,
}));
vi.mock('./pane-registry', async (original) => ({
  ...(await original<typeof import('./pane-registry')>()),
  listPaneSnapshots: () => [],
  takePendingPaneSpawnResult: () => {
    const pending = h.nextPending;
    h.nextPending = null;
    return pending;
  },
  getPaneRuntimeAuthorityBySession: () => null,
}));
vi.mock('./gate', async (original) => ({
  ...(await original<typeof import('./gate')>()),
  assertCurrentMissionOrchestratorSession: vi.fn(),
  getContextBySession: () => h.liveCtx,
  isCurrentGateContext: () => h.current,
  gateContextAbortSignal: () => undefined,
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => h.mission,
      assertRouteReservation: h.assertRouteReservation,
      consumeRouteReservation: h.consumeRouteReservation,
    },
    missionPanes: { list: () => [] },
  }),
}));
vi.mock('./task-dispatch-authority', () => ({ isTaskQueueManagedMission: () => false }));
vi.mock('../adapters/adapter-registry', async (original) => ({
  ...(await original<typeof import('../adapters/adapter-registry')>()),
  listAdapters: () => [
    { id: 'qwen', kind: 'cli-pty', bin: 'qwen', quirks: { nexusMcp: 'qwen' } },
    { id: 'codex', kind: 'cli-pty', bin: 'codex', quirks: { nexusMcp: 'codex' } },
    { id: 'devin', kind: 'cli-pty', bin: 'devin', quirks: { nexusMcp: 'none' } },
  ],
  isAdapterInstalled: (id: string) => id !== 'devin',
}));
vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: () => ({ getMissionWorkflow: () => ({ contract: null }) }),
}));
vi.mock('./squad-store', async (original) => ({
  ...(await original<typeof import('./squad-store')>()),
  findAgentInAnySquad: () => null,
  getSquad: () => null,
  squadRoutableCliIds: () => new Set(['qwen', 'codex']),
}));
vi.mock('./operator-cli-mentions', () => ({
  OPERATOR_CHOICE_PROOF_WINDOW_MS: 30 * 60_000,
  operatorRecentlyNamedCli: (_session: string, adapterId: string) =>
    adapterId === h.mentionedCli,
}));
vi.mock('./isolated-writer-worktree', async (original) => ({
  ...(await original<typeof import('./isolated-writer-worktree')>()),
  resumeIsolatedWriterWorktree: h.resumeWorktree,
}));
vi.mock('../adapters/cli-model-discovery', async (original) => ({
  ...(await original<typeof import('../adapters/cli-model-discovery')>()),
  discoverCliModels: () => new Map(),
}));
vi.mock('../persistence/settings-store', async (original) => {
  const actual = await original<typeof import('../persistence/settings-store')>();
  return {
    ...actual,
    getOrchSettings: () => ({ ...actual.getOrchSettings(), squadCliPolicy: 'operator-choice' }),
  };
});

import { paneSpawnTool, setOperatorRouteResolver } from './tools-panes';
import {
  getPaneStartWatch,
  listPaneStartWatches,
  resetPaneStartWatchdogForTests,
} from './pane-start-watchdog';
import { adapterCircuitBreakers } from './circuit-breaker';
import {
  getPaneTaskReroute,
  resetPaneTaskReroutesForTests,
  resolveNextCli,
} from './pane-task-reroute';

const orchestrator: AgentGateContext = {
  token: 'orch', label: 'Maestro', role: 'orchestrator', sessionId: 'orch-session',
  missionId: 'mission-a', scope: testProjectScope(),
  allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false,
};
const operator: AgentGateContext = {
  ...orchestrator, token: 'user', label: 'operador', role: 'user',
  sessionId: 'user-session', missionId: undefined,
};

/** Spawn real até o ACK pendente: o tool-util chama o gancho e lança. */
function pendingSpawns(): void {
  h.spawn.mockImplementation(async (options: Record<string, unknown>, hooks?: {
    onPendingSpawn?: (attempt: Record<string, unknown>) => void;
  }) => {
    const n = h.spawn.mock.calls.length;
    hooks?.onPendingSpawn?.({
      requestId: `orchspawn-${n}`,
      paneId: `pane-${n}`,
      adapterId: options.adapterId,
      turnProof: false,
      redeliver: async () => false,
    });
    h.nextPending = {
      requestId: `orchspawn-${n}`, ok: true, paneId: `pane-${n}`, sessionId: null, pending: true,
    };
    throw new Error('pane spawn pending');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPaneStartWatchdogForTests();
  resetPaneTaskReroutesForTests();
  adapterCircuitBreakers.reset();
  h.nextPending = null;
  h.current = true;
  h.mentionedCli = null;
  h.liveCtx = orchestrator;
  h.mission = {
    id: 'mission-a', title: 'Feature', description: '', status: 'running', squadId: 'squad',
    intentContract: { ...compileIntentContract({ goal: 'Feature', intentVersion: 1 }), maxWorkers: 8 },
  };
  pendingSpawns();
});
afterEach(() => resetPaneStartWatchdogForTests());

describe('F-723: ficha de início e reenvio pela rota do spawn', () => {
  it('worker com ACK pendente ganha a ficha; o reenvio exclui a CLI que falhou e consome reserva nova', async () => {
    const resolver = vi.fn(async (_task: string, _ctx: AgentGateContext, internal: { excludeAdapterIds?: readonly string[] }) =>
      internal.excludeAdapterIds?.includes('qwen')
        ? { adapterId: 'codex', model: 'gpt-5.4', routeReservationId: 'rr-2' }
        : { adapterId: 'qwen', model: 'qwen3.8-max', routeReservationId: 'rr-1' },
    );
    setOperatorRouteResolver(resolver);
    const receipt = await paneSpawnTool.handler(
      { task: 'implementar o login', prompt: 'faça o login', title: 'login' }, orchestrator,
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({ paneId: 'pane-1', pending: true });

    const watch = getPaneStartWatch('pane-1')!;
    expect(watch).toMatchObject({
      requestId: 'orchspawn-1',
      adapterId: 'qwen',
      missionId: 'mission-a',
      role: 'worker',
      callerSessionId: 'orch-session',
      rerouted: false,
      pinnedRuntime: false,
    });
    expect(watch.hasAlternative?.()).toBe(true);

    const next = await watch.reroute!(['qwen']);
    expect(next).toEqual({ paneId: 'pane-2', adapterId: 'codex', model: 'gpt-5.4' });
    // F-1316: o reenvio classifica pelo mesmo brief da rota original.
    expect(resolver.mock.calls[0]![2]).toMatchObject({ classificationPrompt: 'faça o login' });
    expect(resolver).toHaveBeenLastCalledWith('implementar o login', orchestrator, {
      classificationPrompt: 'faça o login',
      excludeAdapterIds: ['qwen'],
    });
    // A reserva gasta pelo spawn que falhou não é reaproveitada: a rota nova
    // cria a sua e o reenvio a consome.
    expect(h.consumeRouteReservation).toHaveBeenLastCalledWith(
      expect.objectContaining({ reservationId: 'rr-2', adapterId: 'codex' }),
      'orch-session',
    );
    expect(h.spawn.mock.calls[1]![0]).toMatchObject({
      adapterId: 'codex', role: 'worker', missionId: 'mission-a', title: 'login',
    });
    expect(String(h.spawn.mock.calls[1]![0].prompt)).toContain('faça o login');
    // A tentativa reenviada é vigiada também, marcada para não haver laço.
    expect(getPaneStartWatch('pane-2')).toMatchObject({ adapterId: 'codex', rerouted: true });
  });

  it('F-1414: a cadeia de reenvios mantém fora TODAS as CLIs que falharam e conta a geração até o teto', async () => {
    const resolver = vi.fn(async (_task: string, _ctx: AgentGateContext, internal: { excludeAdapterIds?: readonly string[] }) => {
      const out = internal.excludeAdapterIds ?? [];
      if (out.includes('codex')) return { adapterId: 'glm', routeReservationId: 'rr-3' };
      if (out.includes('qwen')) return { adapterId: 'codex', routeReservationId: 'rr-2' };
      return { adapterId: 'qwen', routeReservationId: 'rr-1' };
    });
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler({ task: 'implementar o login', prompt: 'faça o login' }, orchestrator);
    expect(getPaneStartWatch('pane-1')).toMatchObject({ generation: 0 });

    await getPaneStartWatch('pane-1')!.reroute!(['qwen']);
    expect(getPaneStartWatch('pane-2')).toMatchObject({ adapterId: 'codex', generation: 1 });

    // O 2º reenvio exclui a CLI que falhou agora E a que falhou antes (o
    // roster deste squad só tem qwen/codex, então a rota recusa o resto).
    await getPaneStartWatch('pane-2')!.reroute!(['codex']).catch(() => undefined);
    expect(resolver.mock.calls.at(-1)![2]).toMatchObject({ excludeAdapterIds: ['qwen', 'codex'] });
  });

  it('pin de CLI e reserva antiga não viajam no reenvio', async () => {
    const resolver = vi.fn(async () => ({ adapterId: 'codex', routeReservationId: 'rr-9' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler(
      { adapterId: 'qwen', routeReservationId: 'rr-velha', task: 'revisar', prompt: 'revise' },
      orchestrator,
    );
    expect(h.spawn.mock.calls[0]![0]).toMatchObject({ adapterId: 'qwen' });
    await getPaneStartWatch('pane-1')!.reroute!(['qwen']);
    expect(resolver).toHaveBeenCalledWith('revisar', orchestrator, {
      classificationPrompt: 'revise', excludeAdapterIds: ['qwen'],
    });
    expect(h.assertRouteReservation).toHaveBeenLastCalledWith(
      expect.objectContaining({ reservationId: 'rr-9', adapterId: 'codex' }),
    );
  });

  it('o reenvio usa a autoridade ATUAL de quem pediu; sem sessão viva, falha visível', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'qwen', routeReservationId: 'rr-1' })));
    await paneSpawnTool.handler({ task: 'revisar', prompt: 'revise' }, orchestrator);
    const watch = getPaneStartWatch('pane-1')!;
    h.current = false;
    await expect(watch.reroute!(['qwen'])).rejects.toThrow(/não tem mais sessão viva/);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('helper do operador: ficha de helper, alternativa só entre CLIs com MCP do Nexus', async () => {
    h.liveCtx = operator;
    const resolver = vi.fn(async (_task: string, _ctx: AgentGateContext, internal: { excludeAdapterIds?: readonly string[] }) =>
      ({ adapterId: internal.excludeAdapterIds?.includes('qwen') ? 'codex' : 'qwen' }),
    );
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler({ task: 'mapear as telas', prompt: 'mapeie' }, operator);
    const watch = getPaneStartWatch('pane-1')!;
    expect(watch).toMatchObject({ role: 'helper', callerSessionId: 'user-session' });
    expect(watch.missionId).toBeUndefined();
    expect(watch.hasAlternative?.()).toBe(true);
    // Codex aberto no disjuntor e Devin sem MCP/instalação: nenhuma saída.
    for (let i = 0; i < 3; i += 1) adapterCircuitBreakers.recordFailure('codex');
    expect(watch.hasAlternative?.()).toBe(false);
  });

  it('CLI nomeada pelo operador fica fixada: o watchdog não troca sozinho', async () => {
    h.liveCtx = operator;
    h.mentionedCli = 'qwen';
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex' })));
    await paneSpawnTool.handler(
      { adapterId: 'qwen', operatorChoice: true, task: 'revisar', prompt: 'revise' }, operator,
    );
    expect(h.spawn.mock.calls[0]![0]).toMatchObject({ adapterId: 'qwen' });
    expect(getPaneStartWatch('pane-1')).toMatchObject({ pinnedRuntime: true });
  });

  it('F-765/F-775: o pedido fica com o pane; a reabertura leva o pacote depois do brief, sem fixar a CLI', async () => {
    const resolver = vi.fn(async () => ({ adapterId: 'qwen', model: 'qwen3.8-max', routeReservationId: 'rr-1' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler(
      { task: 'implementar o login', prompt: 'faça o login', title: 'login' }, orchestrator,
    );
    const handle = getPaneTaskReroute('pane-1')!;
    expect(handle).toMatchObject({
      paneId: 'pane-1', adapterId: 'qwen', missionId: 'mission-a', role: 'worker',
      operatorOpened: false, pinnedRuntime: false, generation: 0,
    });
    expect(handle.hasAlternative([])).toBe(true);

    resolver.mockResolvedValueOnce({ adapterId: 'qwen', model: 'qwen3.7-max', routeReservationId: 'rr-2' });
    const pack = '[NEXUS FAILOVER HANDOFF]\nTouched files:\n- src/login.ts\nExecute the next concrete step now.';
    const next = await handle.reroute({
      excludeAdapterIds: [], preferAdapterIds: ['qwen'], appendPrompt: pack,
    });
    expect(next).toEqual({ paneId: 'pane-2', adapterId: 'qwen', model: 'qwen3.7-max' });
    // A rota segue a tarefa original; a mesma CLI entra só como preferência.
    // F-1316: o pacote (arquivos tocados, trecho do terminal) não entra na
    // classificação — só o brief original.
    expect(resolver).toHaveBeenLastCalledWith('implementar o login', orchestrator, {
      classificationPrompt: 'faça o login',
      preferAdapterIds: ['qwen'],
    });
    const prompt = String(h.spawn.mock.calls[1]![0].prompt);
    expect(prompt.indexOf('faça o login')).toBeLessThan(prompt.indexOf('[NEXUS FAILOVER HANDOFF]'));
    // A reabertura é marcada: o pedido novo conta como a 1ª reabertura.
    expect(getPaneTaskReroute('pane-2')).toMatchObject({ generation: 1 });
    expect(getPaneStartWatch('pane-2')).toMatchObject({ rerouted: true });
  });

  it('F-775: a próxima CLI vem do MESMO roteador, com a autoridade atual de quem pediu', async () => {
    const resolver = vi.fn(async () => ({ adapterId: 'codex', model: 'gpt-6-sol', effort: 'high' }));
    setOperatorRouteResolver(resolver);
    await expect(resolveNextCli({
      callerSessionId: 'orch-session', task: 'implementar o login', excludeAdapterIds: ['qwen'],
    })).resolves.toEqual({ adapterId: 'codex', model: 'gpt-6-sol', effort: 'high' });
    expect(resolver).toHaveBeenCalledWith('implementar o login', orchestrator, { excludeAdapterIds: ['qwen'] });
    // Quem pediu não tem mais sessão viva: nenhuma rota sai em nome dele.
    h.current = false;
    await expect(resolveNextCli({
      callerSessionId: 'orch-session', task: 'implementar o login', excludeAdapterIds: [],
    })).resolves.toBeNull();
  });

  it('F-775: reaberturas em cadeia são a MESMA tarefa (linhagem) e continuam na worktree do pane parado', async () => {
    const resolver = vi.fn(async () => ({ adapterId: 'qwen', routeReservationId: 'rr-1' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler({ task: 'implementar o login', prompt: 'faça o login' }, orchestrator);
    resolver.mockResolvedValue({ adapterId: 'codex', routeReservationId: 'rr-2' });
    await getPaneTaskReroute('pane-1')!.reroute({ excludeAdapterIds: ['qwen'], worktreeFromPaneId: 'pane-1' });
    expect(getPaneTaskReroute('pane-2')).toMatchObject({ lineageId: 'pane-1', generation: 1, adapterId: 'codex' });
    expect(h.resumeWorktree).toHaveBeenCalledWith(expect.anything(), 'mission-a', 'pane-1');
    await getPaneTaskReroute('pane-2')!.reroute({ excludeAdapterIds: ['codex'] });
    expect(getPaneTaskReroute('pane-3')).toMatchObject({ lineageId: 'pane-1', generation: 2 });
  });

  it('F-1471: troca de conta na MESMA CLI — a rota só pode devolver a mesma CLI, com o modelo anterior; a conta irmã fixa o spawn e a cadeia não avança', async () => {
    const resolver = vi.fn(async () => ({ adapterId: 'qwen', model: 'qwen3.8-max', routeReservationId: 'rr-1' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler(
      { task: 'implementar o login', prompt: 'faça o login', title: 'login' }, orchestrator,
    );
    // O spawn original não fixa conta: quem escolhe é o pool.
    expect(h.spawn.mock.calls[0]![0].accountId).toBeUndefined();
    // Writer segura o checkout: o sucessor só entra depois de ele sair.
    expect(getPaneTaskReroute('pane-1')).toMatchObject({ exclusiveCheckout: true });

    resolver.mockResolvedValueOnce({ adapterId: 'qwen', model: 'qwen3.8-max', routeReservationId: 'rr-2' });
    const pack = '[NEXUS FAILOVER HANDOFF]\nYou are now running on account "m•••m" in a NEW provider session.';
    const next = await getPaneTaskReroute('pane-1')!.reroute({
      excludeAdapterIds: [],
      sameAdapter: { adapterId: 'qwen', accountId: 'qwen-b', model: 'qwen3.8-max' },
      appendPrompt: pack,
      worktreeFromPaneId: 'pane-1',
    });
    // O modelo que nasceu volta no resultado (o recibo compara com o anterior).
    expect(next).toEqual({ paneId: 'pane-2', adapterId: 'qwen', model: 'qwen3.8-max' });
    // Toda outra CLI fica fora da rota; a mesma CLI nunca é excluída; o modelo
    // anterior vai como preferência da rota (a reserva nasce com ele).
    expect(resolver).toHaveBeenLastCalledWith('implementar o login', orchestrator, {
      classificationPrompt: 'faça o login',
      excludeAdapterIds: ['codex', 'devin'],
      preferAdapterIds: ['qwen'],
      preferModel: { adapterId: 'qwen', model: 'qwen3.8-max' },
    });
    expect(h.spawn.mock.calls[1]![0]).toMatchObject({
      adapterId: 'qwen', model: 'qwen3.8-max', accountId: 'qwen-b', role: 'worker', missionId: 'mission-a',
    });
    const prompt = String(h.spawn.mock.calls[1]![0].prompt);
    expect(prompt.indexOf('faça o login')).toBeLessThan(prompt.indexOf('[NEXUS FAILOVER HANDOFF]'));
    expect(h.resumeWorktree).toHaveBeenCalledWith(expect.anything(), 'mission-a', 'pane-1');
    // Trocar de conta não é reabrir noutra CLI: a geração do pedido fica.
    expect(getPaneTaskReroute('pane-2')).toMatchObject({ adapterId: 'qwen', lineageId: 'pane-1', generation: 0 });
  });

  it('F-1471: leitor não segura o checkout — o sucessor pode nascer antes de ele sair', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'qwen', routeReservationId: 'rr-1' })));
    await paneSpawnTool.handler({ task: 'revisar o login', prompt: 'revise', readOnly: true }, orchestrator);
    expect(getPaneTaskReroute('pane-1')).toMatchObject({ exclusiveCheckout: false });
  });

  it('F-1471: rota que devolve OUTRA CLI recusa a troca de conta — nada nasce com a conta de outro provedor', async () => {
    const resolver = vi.fn(async () => ({ adapterId: 'qwen', routeReservationId: 'rr-1' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler({ task: 'implementar o login', prompt: 'faça o login' }, orchestrator);
    resolver.mockResolvedValueOnce({ adapterId: 'codex', routeReservationId: 'rr-2' });
    await expect(getPaneTaskReroute('pane-1')!.reroute({
      excludeAdapterIds: [], sameAdapter: { adapterId: 'qwen', accountId: 'qwen-b' },
    })).rejects.toThrow(/mesma CLI/);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('F-765: CLI nomeada pelo operador fica guardada como fixa (o failover não a troca)', async () => {
    h.liveCtx = operator;
    h.mentionedCli = 'qwen';
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex' })));
    await paneSpawnTool.handler(
      { adapterId: 'qwen', operatorChoice: true, task: 'revisar', prompt: 'revise' }, operator,
    );
    expect(getPaneTaskReroute('pane-1')).toMatchObject({ pinnedRuntime: true, role: 'helper' });
  });

  it('spawn sem ACK pendente (erro devolvido ao chamador) não deixa ficha', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'qwen', routeReservationId: 'rr-1' })));
    h.spawn.mockImplementationOnce(async (options: Record<string, unknown>, hooks?: {
      onPendingSpawn?: (attempt: Record<string, unknown>) => void;
    }) => {
      hooks?.onPendingSpawn?.({
        requestId: 'orchspawn-x', paneId: 'pane-x', adapterId: options.adapterId,
        turnProof: false, redeliver: async () => false,
      });
      throw new Error('no renderer window available');
    });
    await expect(
      paneSpawnTool.handler({ task: 'revisar', prompt: 'revise' }, orchestrator),
    ).rejects.toThrow(/no renderer window/);
    expect(listPaneStartWatches()).toEqual([]);
    expect(getPaneTaskReroute('pane-x')).toBeNull();
  });
});
