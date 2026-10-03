import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mission, Squad } from '../../shared/orch-types';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import { hashMissionIntentAuthority } from './mission-pane-authority';
import fs from 'node:fs';
import { applyAttestedBusinessModel, createBarbershopRepo } from '../context/business-model/__fixtures__/barbershop';

/**
 * Kimi Code 2.1.1 não tem prompt posicional em modo interativo (`kimi --help`:
 * `Usage: kimi [options] [command]`, sem `[prompt]`) — o canal de entrega do
 * briefing é sempre colagem pós-boot (`initialPromptChannel` já resolve
 * 'paste' para o binário `kimi`). O Maestro (role orchestrator) já cola via
 * `deliverAgentPrompt` (ver `spawnAgentPane`); o worker da primeira onda da
 * Via Rápida nunca tinha o mesmo fallback — o pane abria e ficava mudo até o
 * operador digitar o briefing à mão (achado 2026-09-27).
 */

const deliverAgentPromptMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
const terminateMock = vi.hoisted(() => vi.fn(async (_sessionId: string) => true));

const state = vi.hoisted(() => ({
  squad: null as Squad | null,
  mission: null as Mission | null,
  physical: new Map<string, OwnedAgentSessionInfo>(),
  spawnPrompts: [] as Array<string | undefined>,
  tasks: [] as Array<{ title: string; status: string }>,
  adapters: new Map<string, unknown>(),
}));

// Registro vazio, como o harness sempre rodou (o boot é quem carrega os
// adapters); o caso do F-781 semeia o adapter builtin real do Kimi.
vi.mock('../adapters/adapter-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/adapter-registry')>()),
  getAdapter: (id: string) => state.adapters.get(id) ?? null,
}));

vi.mock('./squad-store', () => ({ getSquad: () => state.squad, listSquads: () => [] }));
vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: (id: string) => state.physical.get(id) ?? null,
  isPtySessionConnectedAndWritable: (id: string) => state.physical.has(id),
  getSessionState: () => 'idle',
  listAgentSessions: () => [],
  getSessionCwd: () => null,
  orchTerminateSession: terminateMock,
}));
vi.mock('../acp/acp-harness-driver', () => ({ getAcpDriverSession: () => null }));
vi.mock('../persistence/provider-config-store', () => ({
  hasRuntimeKey: () => true,
  providerAuthStrategy: () => 'api-key',
  listProviderSettings: () => [],
}));
vi.mock('../adapters/subscription-auth', () => ({ detectSubscriptionAuthReadiness: () => 'present' }));
vi.mock('./squad-runtime-inventory', () => ({ warmSquadRuntimeSubscriptionAuth: async () => undefined }));
vi.mock('../pty/warm-pool', () => ({ warmPool: { take: () => null } }));
vi.mock('../observability/main-trace', () => ({ trace: () => undefined }));
// Composição de contexto REAL (withProjectContextBlocks): só o transporte é dublê.
vi.mock('./tool-util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tool-util')>()),
  deliverAgentPrompt: deliverAgentPromptMock,
  proveNativeArgvBriefAccepted: async () => true,
}));
vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () =>
    [...state.physical.values()].map((info) => ({
      paneId: info.paneId!,
      sessionId: info.sessionId,
      missionId: info.missionId,
      agentName: info.agentName,
      title: info.agentName,
      role: info.role,
      state: 'idle',
    })),
  requestPaneSpawn: async (options: {
    initialPrompt?: string;
    agentName: string;
    missionId: string;
    adapterId: string;
    scope: OwnedAgentSessionInfo['scope'];
    executionScope?: OwnedAgentSessionInfo['scope'];
    readOnly: boolean;
  }) => {
    const mission = state.mission!;
    const sessionId = `session-${options.agentName}`;
    const paneId = `pane-${options.agentName}`;
    const issued: OwnedAgentSessionInfo = {
      sessionId,
      paneId,
      adapterId: options.adapterId,
      cwd: (options.executionScope ?? options.scope).rootRealPath,
      accountId: `main-selected-${options.agentName}`,
      scope: options.executionScope ?? options.scope,
      source: 'pending',
      role: 'worker',
      missionId: options.missionId,
      agentName: options.agentName,
      readOnly: options.readOnly,
      allowedTools: ['nexus_handoff_submit'],
      allowedSkills: [],
      workerIncarnationId: `main-minted-${options.agentName}`,
      authoritySeal: {
        intentVersion: 1,
        intentContractHash: hashMissionIntentAuthority(mission.intentContract!),
        contextRevision: 'original-workflow',
        contractHash: 'b'.repeat(64),
        squadRevisionHash: mission.intentContract!.squadRevisionHash!,
      },
    };
    state.physical.set(sessionId, issued);
    state.spawnPrompts.push(options.initialPrompt);
    return { ok: true, requestId: `spawn-${paneId}`, paneId, sessionId };
  },
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: { get: () => state.mission! },
    missionPanes: { record: () => {}, list: () => [] },
    tasks: { list: () => state.tasks },
  }),
}));

import { dispatchFastLaneFirstWave } from './mission-fast-lane';
import { NEXUS_BROWSER_BRIEF_RULE } from './nexus-browser-policy';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { adapterSchema } from '../../shared/adapter-types';

afterEach(() => {
  state.physical.clear();
  state.spawnPrompts.length = 0;
  state.tasks.length = 0;
  state.adapters.clear();
  deliverAgentPromptMock.mockClear();
  terminateMock.mockClear();
});

function prepare(scope = testProjectScope()) {
  const squad: Squad = {
    id: 'team',
    name: 'Team',
    createdAt: '1',
    builtin: false,
    orchestratorInstructions: '',
    agents: [
      { id: 'agent-Kimi', agentName: 'Kimi', category: 'executor', cli: 'kimi', instructions: '' },
    ],
  } as Squad;
  state.squad = squad;
  const mission: Mission = {
    id: 'mission-1',
    title: 'Pergunte aos panes quanto é 2 + 2.',
    description: 'Pergunte aos panes quanto é 2 + 2. Não altere arquivos.',
    status: 'running',
    intentState: 'executing',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    squadId: squad.id,
    milestones: [],
    intentContract: {
      version: 1,
      source: 'typed',
      goal: 'Pergunte aos panes quanto é 2 + 2.',
      acceptanceCriteria: ['Cada integrante responde'],
      risk: 'normal',
      executionMode: 'assisted',
      contextPolicy: 'minimal',
      intentVersion: 1,
      lane: 'standard',
      budgets: { planningTokens: 100, executionTokens: 100, maxWorkers: 1 },
      approvedAt: 10,
      dispatchedAt: 20,
      squadRevisionHash: snapshotSquadAuthority(squad).hash,
      routingAdvice: {
        source: 'router',
        kind: 'mission-question',
        question: 'Quanto é 2 + 2?',
        readOnlyWorkers: true,
      },
    },
  } as unknown as Mission;
  state.mission = mission;
  return { scope, mission };
}

describe('Via Rápida first-wave — entrega do briefing por colagem para o worker', () => {
  it('cola o briefing no worker Kimi (canal paste) depois do boot, igual ao Maestro', async () => {
    const { scope, mission } = prepare();
    expect(await dispatchFastLaneFirstWave(scope, mission.id)).toBe(1);
    expect(deliverAgentPromptMock).toHaveBeenCalledWith(
      'session-Kimi',
      expect.stringContaining('2 + 2'),
      undefined,
      { adapterId: 'kimi' },
    );
  });

  it('P2-8: worker da 1ª onda recebe o <business-model> atestado no briefing entregue (argv e colagem)', async () => {
    const root = createBarbershopRepo();
    try {
      const scope = testProjectScope({ rootRealPath: root });
      await applyAttestedBusinessModel(root, scope);
      const { mission } = prepare(scope);
      expect(await dispatchFastLaneFirstWave(scope, mission.id)).toBe(1);
      const pasted = (deliverAgentPromptMock.mock.calls as unknown as Array<[string, string]>)[0][1];
      for (const brief of [pasted, state.spawnPrompts[0] ?? '']) {
        expect(brief).toContain('<business-model fonte=');
        expect(brief).toContain('close_commanda#1');
        expect(brief.indexOf('</business-model>')).toBeLessThan(brief.indexOf('2 + 2'));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Fable P1-5: colagem recusada encerra o pane recém-nascido — não fica mudo e vinculado à missão', async () => {
    const { scope, mission } = prepare();
    deliverAgentPromptMock.mockResolvedValueOnce(false);
    await dispatchFastLaneFirstWave(scope, mission.id);
    expect(terminateMock).toHaveBeenCalledWith('session-Kimi', {
      origin: 'fast-lane:briefing-undelivered',
    });
  });

  it('Fable P1-5: colagem que lança também encerra o pane', async () => {
    const { scope, mission } = prepare();
    deliverAgentPromptMock.mockRejectedValueOnce(new Error('pty fechado'));
    await dispatchFastLaneFirstWave(scope, mission.id);
    expect(terminateMock).toHaveBeenCalledWith('session-Kimi', {
      origin: 'fast-lane:briefing-undelivered',
    });
  });
});

/**
 * F-781: o brief da Via Rápida não passa pelo withHandoffContract. Sem a regra
 * aqui, o writer da 1ª onda em CLI que não lê o settings do Claude (Kimi,
 * Codex, Grok…) nunca ouviria "página web → navegador do Nexus".
 */
describe('Via Rápida first-wave — regra do navegador do Nexus no briefing (F-781)', () => {
  function prepareWriterMission() {
    const prepared = prepare();
    const mission = prepared.mission as Mission & {
      intentContract: Record<string, unknown>;
    };
    mission.title = 'Corrigir o cliente da API';
    mission.description = 'Leia a documentação da API e corrija o cliente.';
    mission.intentContract.goal = mission.description;
    delete mission.intentContract.routingAdvice;
    state.tasks.push({ title: 'Corrigir o cliente da API', status: 'pending' });
    return prepared;
  }

  function seedBuiltinKimi(): void {
    const kimi = BUILTIN_ADAPTERS.find(
      (adapter) => (adapter as { id?: unknown }).id === 'kimi',
    );
    state.adapters.set('kimi', adapterSchema.parse(kimi));
  }

  it('writer da 1ª onda com o navegador ao alcance (Kimi, allowlist livre) recebe a regra', async () => {
    seedBuiltinKimi();
    const { scope, mission } = prepareWriterMission();
    expect(await dispatchFastLaneFirstWave(scope, mission.id)).toBeGreaterThan(0);
    expect(state.spawnPrompts[0] ?? '').toContain(NEXUS_BROWSER_BRIEF_RULE);
  });

  it('seat somente leitura da pergunta aos panes não recebe a regra (não abre aba)', async () => {
    seedBuiltinKimi();
    const { scope, mission } = prepare();
    expect(await dispatchFastLaneFirstWave(scope, mission.id)).toBe(1);
    expect(state.spawnPrompts[0] ?? '').not.toContain('nexus_browser_open');
  });
});
