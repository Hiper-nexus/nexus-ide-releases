import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { compileIntentContract } from '../../shared/mission-intent';
import { testProjectScope } from './__tests__/scope-fixture';

/**
 * F-218 (regra do operador 29/09, repetida hoje): "Sol 6.1 saiu; nunca use o
 * Sol normal". F-217 cobria a tabela de roteamento e o default do pane — mas
 * um modelo que chega EXPLÍCITO (args.model, template de squad, menção no
 * texto) rodava a versão velha. A regra da linha agora vale também aí: o
 * pedido sobe para o mais novo da mesma linha entre os elegíveis da CLI.
 * Selos de roster, reserva de rota, resume e o "+ Pane" do renderer ficam
 * fora — contrato ou clique literal do operador.
 */
const h = vi.hoisted(() => ({
  spawn: vi.fn(async (_options: Record<string, unknown>) => ({
    paneId: 'pane-1',
    sessionId: 'sess-1',
  })),
  pending: vi.fn((): unknown => null),
  /** O que a CLI anuncia além da lista builtin (cache oficial dela). */
  cliModels: new Map<string, string[]>(),
  panes: [] as Array<Record<string, unknown>>,
  panesByRef: {} as Record<string, { paneId: string; adapterId?: string }>,
  agents: {} as Record<
    string,
    { squad: Record<string, unknown>; agent: Record<string, unknown> }
  >,
  namedCli: false,
  settings: { squadCliPolicy: 'operator-choice' as 'operator-choice' | 'governed' },
  mission: null as Record<string, unknown> | null,
  consumeRouteReservation: vi.fn(),
}));

vi.mock('./tool-util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tool-util')>()),
  spawnPaneAndMaybePrompt: h.spawn,
}));
vi.mock('./pane-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pane-registry')>()),
  listPaneSnapshots: () => h.panes,
  takePendingPaneSpawnResult: h.pending,
  getPaneRuntimeAuthorityBySession: () => null,
  findPane: (ref: string) => h.panesByRef[ref] ?? null,
}));
vi.mock('./pane-close-scopes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pane-close-scopes')>()),
  armAutoCloseOnHandoff: vi.fn(),
  armAutoCloseOnHandoffForPane: vi.fn(),
}));
vi.mock('../adapters/cli-model-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/cli-model-discovery')>()),
  discoverCliModels: () => h.cliModels,
}));
vi.mock('./squad-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./squad-store')>()),
  findAgentInAnySquad: (ref: string) => h.agents[ref] ?? null,
  findAgentInSquad: (_squadId: string, ref: string) => h.agents[ref] ?? null,
  getSquad: () => null,
}));
vi.mock('../persistence/settings-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../persistence/settings-store')>()),
  getOrchSettings: () => ({ squadCliPolicy: h.settings.squadCliPolicy }),
}));
vi.mock('./operator-cli-mentions', () => ({
  OPERATOR_CHOICE_PROOF_WINDOW_MS: 30 * 60_000,
  operatorRecentlyNamedCli: () => h.namedCli,
}));
vi.mock('../observability/main-trace', () => ({ trace: () => {} }));
vi.mock('./isolated-writer-worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./isolated-writer-worktree')>()),
  resumeIsolatedWriterWorktree: () => null,
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => h.mission,
      assertRouteReservation: vi.fn(),
      consumeRouteReservation: h.consumeRouteReservation,
    },
    missionPanes: { list: () => [] },
  }),
}));
vi.mock('./task-dispatch-authority', () => ({
  isTaskQueueManagedMission: () => false,
}));
vi.mock('./gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gate')>()),
  assertCurrentMissionOrchestratorSession: vi.fn(),
}));
vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: () => ({
    getMissionWorkflow: () => ({ contract: null }),
  }),
}));

import { paneSpawnTool, setOperatorRouteResolver } from './tools-panes';
import {
  quarantineRejectedModel,
  resetModelAccessQuarantineForTests,
} from './model-access-quarantine';

function userPane(overrides: Partial<AgentGateContext> = {}): AgentGateContext {
  return {
    token: 'token',
    label: 'pane do operador',
    role: 'user',
    sessionId: 'session-user',
    scope: testProjectScope(),
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

function orchestratorPane(
  overrides: Partial<AgentGateContext> = {},
): AgentGateContext {
  return userPane({
    role: 'orchestrator',
    label: 'orch',
    sessionId: 'session-orch',
    ...overrides,
  });
}

function spawnedModel(): unknown {
  return (h.spawn.mock.calls[0]?.[0] as { model?: unknown } | undefined)?.model;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cliModels = new Map();
  h.panes = [];
  h.panesByRef = {};
  h.agents = {};
  h.namedCli = false;
  h.settings.squadCliPolicy = 'operator-choice';
  h.mission = {
    id: 'mission-a',
    title: 'Feature',
    description: '',
    status: 'running',
    intentContract: {
      ...compileIntentContract({ goal: 'Feature', intentVersion: 1 }),
      freeAgentChoice: true,
      maxWorkers: 8,
    },
  };
});

afterEach(() => {
  setOperatorRouteResolver(null);
  resetModelAccessQuarantineForTests();
});

describe('F-218 — modelo explícito sobe para o mais novo da linha', () => {
  it('mão do operador com adapterId+model: gpt-6-sol spawna gpt-6.1-sol e o recibo mostra', async () => {
    const receipt = (await paneSpawnTool.handler(
      { adapterId: 'codex', model: 'gpt-6-sol' },
      userPane(),
    )) as Record<string, unknown>;
    expect(spawnedModel()).toBe('gpt-6.1-sol');
    expect(receipt.modelUpgrade).toEqual({
      requested: 'gpt-6-sol',
      used: 'gpt-6.1-sol',
    });
  });

  it('orquestrador sem missão pede adapterId+model ad-hoc: sobe para o anunciado pela CLI', async () => {
    // gpt-6.2-sol não está no catálogo nem no builtin — a CLI anunciou no cache.
    h.cliModels = new Map([['codex', ['gpt-6.2-sol']]]);
    const receipt = (await paneSpawnTool.handler(
      { adapterId: 'codex', model: 'gpt-6-sol', prompt: 'faça X' },
      orchestratorPane(),
    )) as Record<string, unknown>;
    expect(spawnedModel()).toBe('gpt-6.2-sol');
    expect(receipt.modelUpgrade).toEqual({
      requested: 'gpt-6-sol',
      used: 'gpt-6.2-sol',
    });
  });

  it('modelo do template de squad para a CLI sobe junto', async () => {
    h.agents['codex'] = {
      squad: { id: 'squad-t', name: 'T', agents: [] },
      agent: {
        id: 'codex-persona',
        agentName: 'Codex',
        category: 'executor',
        cli: 'codex',
        model: 'gpt-6-sol',
      },
    };
    const receipt = (await paneSpawnTool.handler(
      { adapterId: 'codex' },
      userPane(),
    )) as Record<string, unknown>;
    expect(spawnedModel()).toBe('gpt-6.1-sol');
    expect(receipt.modelUpgrade).toEqual({
      requested: 'gpt-6-sol',
      used: 'gpt-6.1-sol',
    });
  });

  it('roster: o model pedido vence o selo de outra CLI e ainda sobe de linha', async () => {
    h.agents['Executor'] = {
      squad: { id: 'squad-t', name: 'T', agents: [] },
      agent: {
        id: 'executor',
        agentName: 'Executor',
        category: 'executor',
        cli: 'agy',
        model: 'gemini-sealed',
      },
    };
    const receipt = (await paneSpawnTool.handler(
      { agentName: 'Executor', adapterId: 'codex', model: 'gpt-6-sol' },
      userPane(),
    )) as Record<string, unknown>;
    expect(h.spawn.mock.calls[0]?.[0]).toMatchObject({
      adapterId: 'codex',
      model: 'gpt-6.1-sol',
    });
    expect(receipt.modelUpgrade).toEqual({
      requested: 'gpt-6-sol',
      used: 'gpt-6.1-sol',
    });
  });

  it('roster selado que vence NÃO sobe: o selo é contrato', async () => {
    // A CLI do selo anuncia uma versão mais nova — mesmo assim fica o selado.
    h.cliModels = new Map([['kimi', ['kimi-code/k3-512k', 'kimi-code/k3']]]);
    h.agents['Kimi'] = {
      squad: { id: 'squad-t', name: 'T', agents: [] },
      agent: {
        id: 'kimi-persona',
        agentName: 'Kimi',
        category: 'executor',
        cli: 'kimi',
        model: 'kimi-code/k3',
        effort: 'high',
      },
    };
    const receipt = (await paneSpawnTool.handler(
      { agentName: 'Kimi' },
      userPane(),
    )) as Record<string, unknown>;
    expect(h.spawn.mock.calls[0]?.[0]).toMatchObject({
      adapterId: 'kimi',
      model: 'kimi-code/k3',
    });
    expect(receipt.modelUpgrade).toBeUndefined();
  });

  it('o mais novo em quarentena (provider recusou) não é usado — pega o anterior elegível', async () => {
    h.cliModels = new Map([['codex', ['gpt-6.2-sol']]]);
    quarantineRejectedModel('codex', 'gpt-6.2-sol', 'Model access is disabled');
    const receipt = (await paneSpawnTool.handler(
      { adapterId: 'codex', model: 'gpt-6-sol' },
      userPane(),
    )) as Record<string, unknown>;
    expect(spawnedModel()).toBe('gpt-6.1-sol');
    expect(receipt.modelUpgrade).toEqual({
      requested: 'gpt-6-sol',
      used: 'gpt-6.1-sol',
    });
  });

  it('resume mantém o runtime do pane — nada de upgrade nem de recibo', async () => {
    h.cliModels = new Map([['codex', ['gpt-6.2-sol']]]);
    h.panesByRef['pane-old'] = { paneId: 'pane-old', adapterId: 'codex' };
    const receipt = (await paneSpawnTool.handler(
      { adapterId: 'codex', model: 'gpt-6-sol', resume: 'pane-old' },
      userPane(),
    )) as Record<string, unknown>;
    expect(h.spawn.mock.calls[0]?.[0]).toMatchObject({
      adapterId: 'codex',
      model: 'gpt-6-sol',
      resume: true,
    });
    expect(receipt.modelUpgrade).toBeUndefined();
  });

  it('modelo sem irmão mais novo na linha passa intacto e sem recibo', async () => {
    const receipt = (await paneSpawnTool.handler(
      { adapterId: 'codex', model: 'gpt-6-astra' },
      userPane(),
    )) as Record<string, unknown>;
    expect(spawnedModel()).toBe('gpt-6-astra');
    expect(receipt.modelUpgrade).toBeUndefined();
  });

  it('pin redistribuído: o model do pin reflete a linha mais nova da CLI pedida', async () => {
    const resolver = vi.fn(async () => ({
      adapterId: 'codex',
      model: 'gpt-6.1-sol',
      routeReservationId: 'rr-pin',
    }));
    setOperatorRouteResolver(resolver);
    const receipt = (await paneSpawnTool.handler(
      {
        adapterId: 'claude',
        model: 'claude-opus-5',
        task: 'revisar o diff',
        prompt: 'revise',
      },
      orchestratorPane({ missionId: 'mission-a' }),
    )) as Record<string, any>;
    expect(receipt.route.redistributed).toMatchObject({
      adapterId: 'claude',
      model: 'claude-opus-5-5',
    });
    expect(receipt.modelUpgrade).toEqual({
      requested: 'claude-opus-5',
      used: 'claude-opus-5-5',
    });
  });
});
