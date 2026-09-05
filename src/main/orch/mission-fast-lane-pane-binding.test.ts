import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handoff, Mission, Squad } from '../../shared/orch-types';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedMissionPaneStore } from './mission-pane-store';
import { createScopedMissionStore } from './mission-store';
import { testProjectScope } from './__tests__/scope-fixture';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import { hashMissionIntentAuthority } from './mission-pane-authority';
import { inspectTeamQuestionCompletion } from './mission-team-question-completion';

const state = vi.hoisted(() => ({
  stores: null as ProjectDomainStoreSuite | null,
  squad: null as Squad | null,
  physical: new Map<string, OwnedAgentSessionInfo>(),
  transport: 'pty',
  corrupt: null as ((info: OwnedAgentSessionInfo) => OwnedAgentSessionInfo) | null,
}));

vi.mock('./project-domain-store-registry', () => ({ getProjectDomainStores: () => state.stores }));
vi.mock('./squad-store', () => ({ getSquad: () => state.squad, listSquads: () => [] }));
vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: (id: string) => state.transport === 'pty' ? state.physical.get(id) ?? null : null,
  isPtySessionConnectedAndWritable: (id: string) => state.physical.has(id),
  getSessionState: () => 'idle', listAgentSessions: () => [], getSessionCwd: () => null,
}));
vi.mock('../acp/acp-harness-driver', () => ({
  getAcpDriverSession: (id: string) => state.transport === 'acp' && state.physical.has(id)
    ? { agent: state.physical.get(id) } : null,
}));
vi.mock('../persistence/provider-config-store', () => ({
  hasRuntimeKey: () => true, providerAuthStrategy: () => 'api-key', listProviderSettings: () => [],
}));
vi.mock('../adapters/subscription-auth', () => ({ detectSubscriptionAuthReadiness: () => 'present' }));
vi.mock('./squad-runtime-inventory', () => ({ warmSquadRuntimeSubscriptionAuth: async () => undefined }));
vi.mock('../pty/warm-pool', () => ({ warmPool: { take: () => null } }));
vi.mock('../observability/main-trace', () => ({ trace: () => undefined }));
vi.mock('./tool-util', () => ({ deliverAgentPrompt: async () => true }));
vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => [...state.physical.values()].map((info) => ({
    paneId: info.paneId!, sessionId: info.sessionId, missionId: info.missionId,
    agentName: info.agentName, title: info.agentName, role: info.role, state: 'idle',
  })),
  requestPaneSpawn: async (options: {
    agentName: string; missionId: string; adapterId: string; scope: OwnedAgentSessionInfo['scope']; readOnly: boolean;
  }) => {
    const mission = state.stores!.missions.get(options.missionId)!;
    const sessionId = `session-${options.agentName}`;
    const paneId = `pane-${options.agentName}`;
    const issued: OwnedAgentSessionInfo = {
      sessionId, paneId, adapterId: options.adapterId, cwd: options.scope.rootRealPath,
      scope: options.scope, source: 'pending', role: 'worker', missionId: options.missionId,
      agentName: options.agentName, readOnly: options.readOnly, allowedTools: ['nexus_handoff_submit'], allowedSkills: [],
      workerIncarnationId: `main-minted-${options.agentName}`,
      authoritySeal: {
        intentVersion: 1, intentContractHash: hashMissionIntentAuthority(mission.intentContract!),
        contextRevision: 'original-workflow', contractHash: 'b'.repeat(64),
        squadRevisionHash: mission.intentContract!.squadRevisionHash!,
      },
    };
    state.physical.set(sessionId, state.corrupt ? state.corrupt(issued) : issued);
    return { ok: true, requestId: `spawn-${paneId}`, paneId, sessionId };
  },
}));

import { dispatchFastLaneFirstWave } from './mission-fast-lane';

const managers: ProjectRuntimeManager[] = [];
const roots: string[] = [];
afterEach(() => {
  managers.splice(0).forEach((manager) => manager.closeAll());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  state.physical.clear();
  state.corrupt = null;
  state.transport = 'pty';
});

function prepare() {
  const root = mkdtempSync(join(tmpdir(), 'nexus-first-wave-binding-'));
  roots.push(root);
  const manager = new ProjectRuntimeManager({ baseDir: root, appVersion: 'test' });
  managers.push(manager);
  const scope = testProjectScope();
  const stored = createScopedMissionStore(manager, scope).create({ title: 'Pergunte aos panes quanto é 2 + 2.' });
  const squad = {
    id: 'team', name: 'Team', createdAt: '1', builtin: false, orchestratorInstructions: '',
    agents: ['Codex', 'Cursor', 'DeepSeek'].map((agentName) => ({
      id: `agent-${agentName}`, agentName, category: 'executor' as const, cli: 'codex', instructions: '',
    })),
  } as Squad;
  state.squad = squad;
  const mission: Mission = {
    ...stored, squadId: squad.id, status: 'running', intentState: 'executing', intentVersion: 1,
    description: 'Pergunte aos panes quanto é 2 + 2. Não altere arquivos.',
    intentContract: {
      version: 1, source: 'typed', goal: stored.title, acceptanceCriteria: ['Cada integrante responde'],
      risk: 'normal', executionMode: 'assisted', contextPolicy: 'minimal', intentVersion: 1,
      lane: 'standard', budgets: { planningTokens: 100, executionTokens: 100, maxWorkers: 3 },
      approvedAt: 10, dispatchedAt: 20, squadRevisionHash: snapshotSquadAuthority(squad).hash,
      routingAdvice: { source: 'router', kind: 'mission-question', question: 'Quanto é 2 + 2?', readOnlyWorkers: true },
    },
  };
  const panes = createScopedMissionPaneStore(manager, scope, { now: () => 80 });
  state.stores = {
    missions: { get: () => mission }, missionPanes: panes,
    tasks: { list: () => [{ title: mission.title, status: 'pending' }] },
  } as unknown as ProjectDomainStoreSuite;
  return { manager, scope, mission, squad, panes };
}

describe('first-wave physical pane binding', () => {
  it.each([
    ['missing nonce', (info: OwnedAgentSessionInfo) => ({ ...info, workerIncarnationId: undefined })],
    ['missing seal', (info: OwnedAgentSessionInfo) => ({ ...info, authoritySeal: undefined })],
    ['different session', (info: OwnedAgentSessionInfo) => ({ ...info, sessionId: 'another-session' })],
    ['different pane', (info: OwnedAgentSessionInfo) => ({ ...info, paneId: 'another-pane' })],
    ['different mission', (info: OwnedAgentSessionInfo) => ({ ...info, missionId: 'another-mission' })],
    ['different agent', (info: OwnedAgentSessionInfo) => ({ ...info, agentName: 'another-agent' })],
    ['different checkout', (info: OwnedAgentSessionInfo) => ({ ...info, scope: { ...info.scope, checkoutId: 'another-checkout' } })],
    ['old intent hash', (info: OwnedAgentSessionInfo) => ({ ...info, authoritySeal: { ...info.authoritySeal!, intentContractHash: 'f'.repeat(64) } })],
  ])('does not persist a worker with %s', async (_name, corrupt) => {
    state.corrupt = corrupt;
    const { scope, mission, panes } = prepare();
    expect(await dispatchFastLaneFirstWave(scope, mission.id)).toBe(0);
    expect(panes.list(mission.id)).toEqual([]);
  });

  it.each(['pty', 'acp'])('persists the original %s spawn authority and makes its later physical responses eligible', async (transport) => {
    state.transport = transport;
    const { manager, scope, mission, squad } = prepare();
    expect(await dispatchFastLaneFirstWave(scope, mission.id)).toBe(3);
    manager.close(scope);
    const persisted = createScopedMissionPaneStore(manager, scope).list(mission.id);
    const physical = [...state.physical.values()];
    for (const info of physical) {
      expect(persisted.find((pane) => pane.paneId === info.paneId)).toMatchObject({
        workerIncarnationId: info.workerIncarnationId, authoritySeal: info.authoritySeal,
        readOnly: true, allowedTools: ['nexus_handoff_submit'], allowedSkills: [],
      });
    }
    const handoffs = physical.map((info): Handoff => ({
      id: `handoff-${info.sessionId}`, missionId: mission.id, sessionId: info.sessionId,
      workerIncarnationId: info.workerIncarnationId, fromAgent: info.agentName, authorityOrigin: 'agent',
      status: 'success', claimTrust: 'untrusted', summary: '4', artifacts: [], evidenceIds: [],
      evidenceTrust: 'unverified', delivered: true, deliveryState: 'acknowledged', createdAt: 90,
      mcpProvenance: {
        receiptId: `receipt-${info.sessionId}`, toolCallId: `receipt-${info.sessionId}`, toolName: 'nexus_handoff_submit',
        source: 'pty-stream', missionId: mission.id, sessionId: info.sessionId,
        workerIncarnationId: info.workerIncarnationId, authoritySha256: 'a'.repeat(64), issuedAt: 89,
      },
    }));
    expect(inspectTeamQuestionCompletion({ mission, squad, panes: persisted, runtimePanes: [], handoffs }).ready).toBe(true);
  });
});
