import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mission, Squad } from '../../shared/orch-types';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import { hashMissionIntentAuthority } from './mission-pane-authority';

/**
 * Kimi Code 2.1.1 não tem prompt posicional em modo interativo (`kimi --help`:
 * `Usage: kimi [options] [command]`, sem `[prompt]`) — o canal de entrega do
 * briefing é sempre colagem pós-boot (`initialPromptChannel` já resolve
 * 'paste' para o binário `kimi`). O Maestro (role orchestrator) já cola via
 * `deliverAgentPrompt` (ver `spawnAgentPane`); o worker da primeira onda da
 * Via Rápida nunca tinha o mesmo fallback — o pane abria e ficava mudo até o
 * operador digitar o briefing à mão (achado 2026-09-27).
 */

const deliverAgentPromptMock = vi.hoisted(() => vi.fn(async () => true));

const state = vi.hoisted(() => ({
  squad: null as Squad | null,
  mission: null as Mission | null,
  physical: new Map<string, OwnedAgentSessionInfo>(),
}));

vi.mock('./squad-store', () => ({ getSquad: () => state.squad, listSquads: () => [] }));
vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: (id: string) => state.physical.get(id) ?? null,
  isPtySessionConnectedAndWritable: (id: string) => state.physical.has(id),
  getSessionState: () => 'idle',
  listAgentSessions: () => [],
  getSessionCwd: () => null,
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
vi.mock('./tool-util', () => ({
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
    return { ok: true, requestId: `spawn-${paneId}`, paneId, sessionId };
  },
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: { get: () => state.mission! },
    missionPanes: { record: () => {}, list: () => [] },
    tasks: { list: () => [] },
  }),
}));

import { dispatchFastLaneFirstWave } from './mission-fast-lane';

afterEach(() => {
  state.physical.clear();
  deliverAgentPromptMock.mockClear();
});

function prepare() {
  const scope = testProjectScope();
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
});
