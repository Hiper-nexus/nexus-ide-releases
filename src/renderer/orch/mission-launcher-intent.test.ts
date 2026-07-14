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
    expect(prompt).toContain('missionId=mission-1');
    expect(prompt).toContain('Aplique o padrão de engenharia do NavalhaGO.');
    expect(prompt).toContain('QA sênior (reviewer');
    expect(prompt).toContain('PILOTO AUTOMÁTICO');
    expect(prompt).toContain('nexus_mission_freeze_contract');
    expect(prompt).toContain('nexus_merge_task');
    expect(prompt).toContain('PREVC');
    expect(prompt).toContain('NUNCA chame nexus_mission_set_status com done sem PREVC');
    expect(prompt).toMatch(/Use blocked/);
    expect(prompt).toMatch(/use failed/i);
    expect(prompt).toMatch(/revis[aã]o independente/i);
    expect(prompt).toMatch(/mem[oó]ria dur[aá]vel/i);
    expect(prompt).toMatch(/context_doctor.*sob demanda/i);
  });
  it('keeps short-mission kickoffs lean: no goal restated as criterion, plan proportional', () => {
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
    expect(prompt).toMatch(/proporcional ao objetivo/i);
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
  it('removes a newly created mission when running status publication fails', async () => {
    const mission = {
      id: 'mission-legacy',
      title: 'Legacy',
      description: 'Legacy',
      status: 'pending' as const,
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
    ).rejects.toThrow(/status store unavailable/i);
    expect(removeMission).toHaveBeenCalledWith('mission-legacy');
  });
});

vi.mock('../state/home-store', () => ({
  useHomeStore: {
    getState: () => ({ hide: vi.fn() }),
  },
}));

describe('intent-first arming dependencies', () => {
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
    await expect(launchSquadMission(squad, [])).resolves.toMatchObject({
      ok: true,
      armed: true,
      missionId: 'mission-armed',
    });
    expect(armMission).toHaveBeenCalledOnce();
    expect(accountsList).not.toHaveBeenCalled();
    expect(quotaSnapshot).not.toHaveBeenCalled();
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
