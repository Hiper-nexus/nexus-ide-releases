// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildIntentDispatchKickoffPrompt,
  initialGoalForArmedMission,
  launchSquadMission,
  materializeSquadMission,
  orientationForKickoff,
  squadLaunchDedupeKey,
} from './mission-launcher';
import { AUTO_DERIVED_CRITERION_PREFIX } from '../../shared/mission-intent';
import type { Squad } from '../../shared/orch-types';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const squad = {
  id: 'navalha',
  name: 'NavalhaGO',
  orchestratorInstructions: 'Aplique o padrão de engenharia do NavalhaGO.',
  agents: [
    {
      id: 'orch',
      agentName: 'Orch',
      category: 'orchestrator' as const,
      cli: 'claude',
    },
    {
      id: 'qa',
      agentName: 'QA sênior',
      category: 'reviewer' as const,
      cli: 'codex',
    },
  ],
  createdAt: '1',
  builtin: false,
} satisfies Squad;

const verifiedClaudeAdapter = {
  id: 'claude',
  kind: 'cli-pty' as const,
  label: 'Claude',
  icon: 'C',
  models: { list: ['default'], default: 'default' },
  installed: true,
  installCommand: '',
  idleTimeoutMs: 800,
  orchestratorCapable: true,
  missionControlCapable: true,
  orchestrationEvidence: 'verified' as const,
  capabilities: {
    launchable: true,
    promptInjectable: true,
    statusObservable: true,
    resumable: true,
    autonomousReadOnly: true,
    governedWriter: false,
    verifiedMaestro: true,
  },
};

describe('intent-first kickoff packing', () => {
  it('keeps the goal scoped while preserving the Nexus autopilot protocol', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-1',
      goal: 'Corrigir o formulário de login',
      acceptanceCriteria: ['Login funciona'],
      risk: 'sensitive',
      maxWorkers: 2,
    });
    expect(prompt).toContain('Corrigir o formulário de login');
    expect(prompt).toContain('id=mission-1');
    expect(prompt).toContain('Aplique o padrão de engenharia do NavalhaGO.');
    expect(prompt).toContain('QA sênior (reviewer');
    expect(prompt).toContain('## Condução');
    expect(prompt).toMatch(/PREVC paralelo/i);
    expect(prompt).toMatch(/n[aã]o pare a miss[aã]o para rodar Doctor\/freeze/i);
    expect(prompt).toMatch(/plano desta inten[cç][aã]o j[aá] [ée] selado pelo Main/i);
    expect(prompt).toMatch(/lista vazia [ée] recupera[cç][aã]o transit[oó]ria do Main/i);
    expect(prompt).not.toContain('nexus_task plan');
    expect(prompt).toMatch(/main [ée] o dispatcher f[ií]sico/i);
    expect(prompt).toMatch(/Merge\/refreeze s[aã]o do Main/i);
    expect(prompt).not.toContain('nexus_merge_task');
    expect(prompt).toContain('PREVC');
    // PREVC trabalha em paralelo e só barra a promoção final.
    expect(prompt).toMatch(/garantias completas somente na promoção final/i);
    expect(prompt).toMatch(/status=done somente após o main produzir PREVC completo/i);
    // Escalonamento novo: bloquear exige causa E tentativa registrada.
    expect(prompt).toMatch(/status=blocked exige a causa E o que você já tentou/);
    expect(prompt).toMatch(/status=failed se a execução começou e falhou/);
    expect(prompt).toMatch(/revis[aã]o independente/i);
    expect(prompt).toMatch(/nexus_mission_get.*handoffs.*learnings/i);
    expect(prompt).not.toContain('nexus_mission_freeze_contract');
  });
  it('keeps short-mission kickoffs lean without asking the Maestro to replan', () => {
    const goal = 'Corrigir o botão de salvar no formulário de perfil';
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-2',
      goal,
      // What compileIntentContract synthesizes when the user gives no criteria.
      acceptanceCriteria: [`${AUTO_DERIVED_CRITERION_PREFIX} ${goal}`],
      risk: 'normal',
      maxWorkers: 3,
    });
    // The goal appears once (its own section), not restated in the criteria.
    expect(prompt.split(goal).length - 1).toBe(1);
    expect(prompt).not.toContain(AUTO_DERIVED_CRITERION_PREFIX);
    expect(prompt).toContain('validado pelo PREVC');
    expect(prompt).toMatch(/plano desta inten[cç][aã]o j[aá] [ée] selado pelo Main/i);
    expect(prompt).not.toContain('nexus_task plan');
  });

  it('keeps a prepared guided PREVC contract as a promotion gate without blocking workers', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-guided-prevc',
      goal: 'Entregar a missão guiada',
      acceptanceCriteria: ['Entrega validada'],
      risk: 'sensitive',
      maxWorkers: 2,
      guidedPrevcRequired: true,
    });

    expect(prompt).toMatch(/PREVC já congelado/i);
    expect(prompt).toMatch(/sem bloquear o início dos workers/i);
    expect(prompt).toMatch(/Comece a execução/i);
    expect(prompt).toMatch(/fronteira de promoção/i);
    expect(prompt).not.toContain('nexus_workflow_prepare_execution');
    expect(prompt).not.toMatch(/n[aã]o inicie worker/i);
  });

  it('keeps user-provided criteria verbatim', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-3',
      goal: 'Corrigir o formulário de login',
      acceptanceCriteria: ['Login funciona', 'Sessão persiste'],
      risk: 'sensitive',
      maxWorkers: 2,
    });
    expect(prompt).toContain('- Login funciona');
    expect(prompt).toContain('- Sessão persiste');
  });

  it('omits the compact memory block when null (fresh dispatch)', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-4',
      goal: 'Corrigir o formulário de login',
      acceptanceCriteria: ['Login funciona'],
      risk: 'normal',
      maxWorkers: 3,
      compactMemoryMarkdown: null,
    });
    expect(prompt).not.toContain('Memória compacta');
  });
});

describe('orientationForKickoff', () => {
  it('returns the map markdown when the warm resolves in time', async () => {
    await expect(
      orientationForKickoff(async () => ({ orientationMarkdown: '# mapa' }), 50),
    ).resolves.toBe('# mapa');
  });

  it('falls back to null instead of holding the kickoff paste hostage', async () => {
    const neverResolves = () => new Promise<never>(() => {});
    await expect(orientationForKickoff(neverResolves, 20)).resolves.toBeNull();
  });

  it('swallows warm failures (kickoff has its own fallback copy)', async () => {
    await expect(
      orientationForKickoff(async () => {
        throw new Error('cold cache');
      }, 50),
    ).resolves.toBeNull();
  });
  it('uses a read-only consult contract when lane=consult', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-consult',
      goal: 'Checar logs da Vercel',
      acceptanceCriteria: ['Resumo dos erros'],
      risk: 'normal',
      maxWorkers: 0,
      lane: 'consult',
    });
    expect(prompt).toContain('lane=consult');
    expect(prompt).toContain('somente leitura');
    expect(prompt).not.toContain('nexus_mission_freeze_contract');
    expect(prompt).not.toContain('nexus_merge_task');
    expect(prompt).toMatch(/status=blocked/);
  });

  it('uses plan-mode contract when lane=plan', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-plan',
      goal: 'Desenhar a migração de auth',
      acceptanceCriteria: ['plan.md com riscos'],
      risk: 'normal',
      maxWorkers: 0,
      lane: 'plan',
    });
    expect(prompt).toContain('lane=plan');
    expect(prompt).toContain('nexus_plan_write');
    expect(prompt).toContain('plan.md');
    expect(prompt).toContain('PRD/plano completo e exato');
    expect(prompt).toContain('não pedirá redelivery');
    expect(prompt).toContain('Executar plano');
    expect(prompt).not.toContain('nexus_merge_task');
    expect(prompt).not.toContain('nexus_mission_freeze_contract');
  });

  it('standard kickoff keeps long-running execution with Main-owned workers', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'mission-std',
      goal: 'Corrigir o login',
      acceptanceCriteria: ['testes verdes'],
      risk: 'normal',
      maxWorkers: 2,
      lane: 'standard',
    });
    expect(prompt).toContain('O main é o dispatcher físico');
    expect(prompt).toMatch(/Implementa[cç][aã]o no worktree da task/i);
    expect(prompt).not.toContain('nexus_bg_run');
  });
});

describe('intent-first launch continuity', () => {
  it('keeps the designed objective when an agentic squad becomes armed', () => {
    expect(
      initialGoalForArmedMission({
        isAgentic: true,
        designedIntent: '  Corrigir o login  ',
      }),
    ).toBe('Corrigir o login');
    expect(
      initialGoalForArmedMission({
        isAgentic: false,
        designedIntent: 'Corrigir o login',
      }),
    ).toBe('');
  });

  it('does not deduplicate different approved missions for the same squad', () => {
    expect(squadLaunchDedupeKey('/repo', 'navalha', 'mission-1')).not.toBe(
      squadLaunchDedupeKey('/repo', 'navalha', 'mission-2'),
    );
    expect(squadLaunchDedupeKey('/repo', 'navalha')).toBe(
      squadLaunchDedupeKey('/repo', 'navalha'),
    );
  });
});

describe('materializeSquadMission with existingMissionId', () => {
  const input = {
    paneId: 'pane-orch',
    title: 'NavalhaGO',
    squadId: 'navalha',
    existingMissionId: 'mission-armed',
    orchestratorPane: {
      paneId: 'pane-orch',
      adapterId: 'claude',
      agentName: 'Maestro',
    },
  };

  it('binds the armed mission instead of creating a new one', async () => {
    const mission = {
      id: 'mission-armed',
      title: 'NavalhaGO',
      description: 'goal',
      status: 'running' as const,
      milestones: [],
      learnings: '',
      intentState: 'dispatched' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const createMission = vi.fn();
    const updateMission = vi.fn();
    const bindMission = vi.fn(async () => mission);
    const result = await materializeSquadMission(input, {
      waitForSession: async () => 'session-1',
      createMission,
      bindMission,
      updateMission,
    });
    expect(result).toEqual({ sessionId: 'session-1', mission });
    expect(bindMission).toHaveBeenCalledWith({
      missionId: 'mission-armed',
      title: 'NavalhaGO',
      squadId: 'navalha',
      orchestratorPane: input.orchestratorPane,
    });
    expect(createMission).not.toHaveBeenCalled();
    expect(updateMission).not.toHaveBeenCalled();
  });
});

describe('legacy mission materialization compensation', () => {
  it('não publica status pelo renderer porque main já devolve missão running', async () => {
    const mission = {
      id: 'mission-legacy',
      title: 'Legacy',
      description: 'Legacy',
      status: 'running' as const,
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 1,
    };
    const removeMission = vi.fn(async () => ({ removed: true }));

    await expect(
      materializeSquadMission(
        {
          paneId: 'pane-legacy',
          title: 'Legacy',
          squadId: 'legacy-squad',
          orchestratorPane: {
            paneId: 'pane-legacy',
            adapterId: 'claude',
          },
        },
        {
          waitForSession: async () => 'session-legacy',
          createMission: async () => mission,
          updateMission: async () => {
            throw new Error('status store unavailable');
          },
          removeMission,
        },
      ),
    ).resolves.toEqual({ sessionId: 'session-legacy', mission });
    expect(removeMission).not.toHaveBeenCalled();
  });
});

vi.mock('../state/home-store', () => ({
  useHomeStore: {
    getState: () => ({ hide: vi.fn() }),
  },
}));

describe('intent-first arming dependencies', () => {
  it('falha fechado antes de qualquer efeito quando o squad não tem Maestro', async () => {
    vi.stubGlobal('window', { nexus: {} });
    const workerOnly: Squad = {
      ...squad,
      agents: [
        {
          ...squad.agents[1]!,
          category: 'reviewer',
        },
      ],
    };

    await expect(
      launchSquadMission(workerOnly, [verifiedClaudeAdapter]),
    ).resolves.toEqual({
      ok: false,
      error: 'Este squad não tem Maestro.',
    });
  });

  it('arms without loading accounts or quota providers', async () => {
    const accountsList = vi.fn(async () => {
      throw new Error('accounts unavailable');
    });
    const quotaSnapshot = vi.fn(async () => {
      throw new Error('quota unavailable');
    });
    const armMission = vi.fn(async () => ({ id: 'mission-armed' }));
    vi.stubGlobal('window', {
      nexus: {
        settings: {
          orchGet: vi.fn(async () => ({ intentFirstMissionRuntimeV1: true })),
        },
        accounts: { list: accountsList },
        quota: { snapshot: quotaSnapshot },
        orch: { armMission },
      },
    });
    await expect(
      launchSquadMission(squad, [verifiedClaudeAdapter]),
    ).resolves.toMatchObject({
      ok: true,
      armed: true,
      missionId: 'mission-armed',
    });
    expect(armMission).toHaveBeenCalledOnce();
    expect(accountsList).not.toHaveBeenCalled();
    expect(quotaSnapshot).not.toHaveBeenCalled();
  });

  it('prefers the reviewed Maestro over a stale global default when arming', async () => {
    const armMission = vi.fn(async () => ({ id: 'mission-codex-roster' }));
    vi.stubGlobal('window', {
      nexus: {
        settings: {
          orchGet: vi.fn(async () => ({
            intentFirstMissionRuntimeV1: true,
            defaultAdapterId: 'claude',
          })),
        },
        orch: { armMission },
      },
    });
    const codexSquad: Squad = {
      ...squad,
      agents: squad.agents.map((agent) =>
        agent.category === 'orchestrator'
          ? { ...agent, cli: 'codex', model: 'gpt-5.6-sol' }
          : { ...agent },
      ),
    };
    const verifiedCodexAdapter = {
      ...verifiedClaudeAdapter,
      id: 'codex',
      label: 'Codex',
      models: { list: ['gpt-5.6-sol'], default: 'gpt-5.6-sol' },
    };

    await expect(
      launchSquadMission(codexSquad, [verifiedCodexAdapter]),
    ).resolves.toMatchObject({
      ok: true,
      armed: true,
      missionId: 'mission-codex-roster',
    });
    expect(armMission).toHaveBeenCalledWith({
      title: codexSquad.name,
      squadId: codexSquad.id,
    });
  });

  it('arms an experimental Maestro inertly and defers consent to native approval', async () => {
    const armMission = vi.fn(async () => ({ id: 'mission-experimental' }));
    vi.stubGlobal('window', {
      nexus: {
        settings: {
          orchGet: vi.fn(async () => ({ intentFirstMissionRuntimeV1: true })),
        },
        orch: { armMission },
      },
    });

    await expect(
      launchSquadMission(squad, [
        {
          ...verifiedClaudeAdapter,
          orchestrationEvidence: 'experimental',
        },
      ]),
    ).resolves.toMatchObject({
      ok: true,
      armed: true,
      missionId: 'mission-experimental',
    });
    expect(armMission).toHaveBeenCalledOnce();
  });

  it('arms a Kimi/custom PTY handoff Maestro in operator-choice without an MCP evidence gate', async () => {
    const armMission = vi.fn(async () => ({ id: 'mission-kimi' }));
    vi.stubGlobal('window', {
      nexus: {
        settings: {
          orchGet: vi.fn(async () => ({
            intentFirstMissionRuntimeV1: true,
            squadCliPolicy: 'operator-choice',
          })),
        },
        orch: { armMission },
      },
    });
    const kimiSquad: Squad = {
      ...squad,
      agents: squad.agents.map((agent) =>
        agent.category === 'orchestrator'
          ? { ...agent, cli: 'kimi', model: 'kimi-k2.5' }
          : agent,
      ),
    };

    await expect(
      launchSquadMission(kimiSquad, [
        {
          ...verifiedClaudeAdapter,
          id: 'kimi',
          label: 'Kimi',
          orchestratorCapable: false,
          orchestrationEvidence: 'unsupported',
          taskHandoffCapable: true,
          missionControlCapable: true,
          capabilities: {
            launchable: true,
            promptInjectable: true,
            statusObservable: true,
            resumable: true,
            autonomousReadOnly: false,
            governedWriter: false,
            verifiedMaestro: false,
          },
        },
      ]),
    ).resolves.toMatchObject({
      ok: true,
      armed: true,
      missionId: 'mission-kimi',
    });
    expect(armMission).toHaveBeenCalledOnce();
  });

  it('keeps the MCP evidence gate for a Kimi/custom Maestro in Hardened', async () => {
    const armMission = vi.fn();
    vi.stubGlobal('window', {
      nexus: {
        settings: {
          orchGet: vi.fn(async () => ({
            intentFirstMissionRuntimeV1: true,
            squadCliPolicy: 'governed',
          })),
        },
        orch: { armMission },
      },
    });
    const kimiSquad: Squad = {
      ...squad,
      agents: squad.agents.map((agent) =>
        agent.category === 'orchestrator'
          ? { ...agent, cli: 'kimi', model: 'kimi-k2.5' }
          : agent,
      ),
    };

    await expect(
      launchSquadMission(kimiSquad, [
        {
          ...verifiedClaudeAdapter,
          id: 'kimi',
          label: 'Kimi',
          orchestratorCapable: false,
          orchestrationEvidence: 'unsupported',
          taskHandoffCapable: true,
          capabilities: {
            launchable: true,
            promptInjectable: true,
            statusObservable: true,
            resumable: true,
            autonomousReadOnly: false,
            governedWriter: false,
            verifiedMaestro: false,
          },
        },
      ]),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/rota Nexus MCP/i),
    });
    expect(armMission).not.toHaveBeenCalled();
  });

  it('preflights the provider before authorizing dispatch', async () => {
    const authorizeDispatch = vi.fn(async () => undefined);
    vi.stubGlobal('window', {
      nexus: {
        settings: {
          orchGet: vi.fn(async () => ({
            intentFirstMissionRuntimeV1: true,
            defaultAdapterId: 'missing-provider',
          })),
        },
        accounts: { list: vi.fn(async () => []) },
        quota: { snapshot: vi.fn(async () => null) },
        orch: { bindMissionOrchestrator: vi.fn() },
      },
    });

    await expect(
      launchSquadMission(squad, [], {
        existingMissionId: 'mission-approved-later',
        goalPrompt: 'goal',
        authorizeDispatch,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(authorizeDispatch).not.toHaveBeenCalled();
  });

  it('mantém rota experimental bloqueada fora do fluxo de aprovação nativa', async () => {
    const bootstrapMissionOrchestrator = vi.fn();
    vi.stubGlobal('window', {
      nexus: {
        settings: {
          orchGet: vi.fn(async () => ({
            intentFirstMissionRuntimeV1: true,
            defaultAdapterId: 'claude',
            squadCliPolicy: 'governed',
          })),
        },
        accounts: { list: vi.fn(async () => []) },
        quota: { snapshot: vi.fn(async () => null) },
        orch: { bootstrapMissionOrchestrator },
      },
    });

    await expect(
      launchSquadMission(
        squad,
        [
          {
            id: 'claude',
            kind: 'cli-pty',
            label: 'Claude experimental',
            icon: 'C',
            models: { list: ['default'], default: 'default' },
            installed: true,
            installCommand: '',
            idleTimeoutMs: 800,
            orchestratorCapable: true,
            missionControlCapable: true,
            orchestrationEvidence: 'experimental',
            capabilities: {
              launchable: true,
              promptInjectable: true,
              statusObservable: true,
              resumable: true,
              autonomousReadOnly: true,
              governedWriter: false,
              verifiedMaestro: false,
            },
          },
        ],
        {
          existingMissionId: 'mission-approved-later',
          goalPrompt: 'goal',
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/experimental.*aprovação nativa/i),
    });
    expect(bootstrapMissionOrchestrator).not.toHaveBeenCalled();
  });

  it('fails closed when approved dispatch has no goal-scoped kickoff', async () => {
    vi.stubGlobal('window', { nexus: {} });

    await expect(
      launchSquadMission(squad, [], { existingMissionId: 'mission-approved' }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/kickoff.*objetivo atual/i),
    });
  });

  it('does not let the renderer force legacy launch while main intent-first is enabled', async () => {
    const accountsList = vi.fn();
    vi.stubGlobal('window', {
      nexus: {
        settings: {
          orchGet: vi.fn(async () => ({ intentFirstMissionRuntimeV1: true })),
        },
        accounts: { list: accountsList },
      },
    });

    await expect(
      launchSquadMission(squad, [], { forceLegacyLaunch: true }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/lan[cç]amento legado.*intent-first/i),
    });
    expect(accountsList).not.toHaveBeenCalled();
  });
});
