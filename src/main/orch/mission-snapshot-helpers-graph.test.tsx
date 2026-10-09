/** @vitest-environment jsdom */
/**
 * F-777 (print 03/10): a missão tinha dez helpers vivos (nexus_pane_spawn com
 * ACK pendente, sem linha em missionPanes) e o grafo animado desenhava só o
 * Orquestrador. Aqui a cadeia inteira — view de produção → snapshot → grafo
 * renderizado — prova que cada helper vira card, com cabo de Delegação, e
 * que quem já entregou e fechou o pane sai do grafo. O helper ainda aberto
 * que já entregou continua, como Concluído.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Handoff,
  Mission,
  MissionPaneSpec,
} from '../../shared/orch-types';
import type { MissionAgentSnapshot } from '../../shared/mission-engine-contract';
import type { ProjectExecutionScope } from '../../shared/types';
import { testProjectScope } from './__tests__/scope-fixture';
import type { MissionLeader } from './mission-leadership';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';

const harness = vi.hoisted(() => ({
  sessionStates: new Map<string, string | null>(),
  semanticBySession: new Map<string, 'awaiting-input' | 'error'>(),
  resolveMissionLeader: vi.fn<(scope: ProjectExecutionScope, missionId: string) => MissionLeader | null>(),
  paneSnapshots: [] as Array<Record<string, unknown>>,
  squads: new Map<string, { id: string; agents: Array<Record<string, unknown>> }>(),
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: (sessionId: string) => harness.sessionStates.get(sessionId) ?? null,
  listAgentSessionsForPane: () => [],
}));

vi.mock('./agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-status')>()),
  getAgentSemanticStatus: () => null,
  getAgentSemanticStatusBySession: (sessionId: string) => {
    const status = harness.semanticBySession.get(sessionId);
    return status ? { status, sessionId, source: 'hook', updatedAt: Date.now() } : null;
  },
}));

vi.mock('./squad-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./squad-store')>()),
  getSquad: (id: string) => harness.squads.get(id) ?? null,
}));

vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => harness.paneSnapshots,
  getPaneRuntimeAuthorityBySession: () => null,
  readSessionOutput: () => '',
}));

vi.mock('./mission-leadership-runtime', () => ({
  getMissionLeadership: () => ({ resolveMissionLeader: harness.resolveMissionLeader }),
}));

import { projectMissionEngineSnapshotView } from './mission-engine-production';
import { projectMissionSnapshot } from './mission-snapshot';
import { qualitativeProgress } from '../../renderer/lib/mission-progress-line';
import {
  layoutMissionGraph,
  MissionGraph,
} from '../../renderer/components/mission/MissionGraph';
import {
  CORE_HEIGHT,
  CORE_WIDTH,
  RACK_HEIGHT,
  RACK_WIDTH,
} from '../../renderer/components/mission/mission-graph-cabling';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const scope = testProjectScope();
const missionId = 'mission-terminais';

/** Os helpers do print: analistas read-only e writers em worktree isolado. */
const HELPERS = [
  { adapterId: 'codex', model: 'gpt-5.5', title: 'Análise do grafo', readOnly: true },
  { adapterId: 'claude', model: 'claude-opus-5-5', title: 'Writer F-777' },
  { adapterId: 'kimi', title: 'Análise do snapshot', readOnly: true },
  { adapterId: 'glm', model: 'glm-5', title: 'Writer layout' },
  { adapterId: 'mimo-code', title: 'Writer contrato' },
  { adapterId: 'muse', title: 'Revisão independente' },
  { adapterId: 'devin', title: 'Writer testes' },
  { adapterId: 'grok', model: 'grok-4.7', title: 'Análise de riscos', readOnly: true },
] as const;

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: missionId,
    title: 'Missão · Terminais',
    description: 'Melhoria robusta',
    status: 'running',
    intentState: 'dispatched',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: Date.now(),
    milestones: [],
    learnings: '',
    ...overrides,
  } as Mission;
}

const orchestratorRow = {
  id: 'row-orch',
  missionId,
  paneId: 'pane-orch',
  role: 'orchestrator',
  adapterId: 'claude',
  model: 'claude-opus-5-5',
  title: 'Orquestrador',
  agentName: 'Orquestrador',
  createdAt: 1,
} as MissionPaneSpec;

function stores(input: {
  mission: Mission;
  panes: readonly MissionPaneSpec[];
  handoffs?: readonly Partial<Handoff>[];
  dispatches?: readonly { paneId: string; sessionId: string; agentRef?: string }[];
}): ProjectDomainStoreSuite {
  return {
    missions: {
      get: (id: string) => (id === input.mission.id ? input.mission : null),
      hasCurrentKickoffAcceptance: () => true,
    },
    missionPanes: { list: () => input.panes },
    tasks: { list: () => [], listPlannedTasks: () => [] },
    taskDispatches: { list: () => input.dispatches ?? [] },
    handoffs: { list: () => input.handoffs ?? [] },
  } as unknown as ProjectDomainStoreSuite;
}

/** Orquestrador provado e vivo + os helpers vivos só no registry de panes. */
function liveTeam(count: number = HELPERS.length): void {
  harness.resolveMissionLeader.mockReturnValue({
    sessionId: 's-orch', paneId: 'pane-orch', source: 'durable', proven: true,
  });
  harness.sessionStates.set('s-orch', 'busy');
  harness.paneSnapshots = [
    { paneId: 'pane-orch', sessionId: 's-orch', kind: 'cli-agent', title: 'Orquestrador', adapterId: 'claude', missionId, role: 'orchestrator', state: 'busy' },
    ...Array.from({ length: count }, (_, index) => {
      const helper = HELPERS[index % HELPERS.length]!;
      const sessionId = `s-helper-${index}`;
      harness.sessionStates.set(sessionId, index % 3 === 2 ? 'idle' : 'busy');
      return {
        paneId: `pane-helper-${index}`,
        sessionId,
        kind: 'cli-agent',
        missionId,
        role: 'worker',
        state: 'busy',
        ...helper,
        ...(index >= HELPERS.length ? { title: `${helper.title} ${index + 1}` } : {}),
      };
    }),
  ];
}

const mountedRoots = new Set<Root>();

function renderSnapshot(snapshot: ReturnType<typeof projectMissionSnapshot>): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.add(root);
  act(() => {
    root.render(
      <MissionGraph
        snapshot={snapshot}
        selectedAgentId={null}
        onSelectAgent={() => {}}
        onRetry={() => {}}
      />,
    );
  });
  return host;
}

/** Evidência visual (output/ é ignorado pelo git): `F777_DUMP=1`. */
function dumpForScreenshot(name: string, host: HTMLElement): void {
  if (!process.env.F777_DUMP) return;
  const dir = join(process.cwd(), 'output', 'f777');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.html`), host.innerHTML);
}

beforeEach(() => {
  harness.sessionStates = new Map();
  harness.semanticBySession = new Map();
  harness.resolveMissionLeader.mockReset();
  harness.paneSnapshots = [];
  harness.squads = new Map();
});

afterEach(() => {
  for (const root of mountedRoots) act(() => root.unmount());
  mountedRoots.clear();
  document.body.replaceChildren();
});

describe('F-777: o grafo da missão desenha o orquestrador, todos os helpers e os cabos', () => {
  it.each([
    ['awaiting-input', 'busy', 'waiting'],
    ['awaiting-input', 'spawning', 'waiting'],
    ['error', 'busy', 'failed'],
    ['error', 'spawning', 'failed'],
  ] as const)('F-951: live %s with %s transport keeps helper cables inactive', (semantic, transport, expected) => {
    liveTeam(1);
    harness.sessionStates.set('s-helper-0', transport);
    harness.semanticBySession.set('s-helper-0', semantic);
    const view = projectMissionEngineSnapshotView(scope,
      stores({ mission: mission(), panes: [orchestratorRow] }), missionId);
    expect(view.panes.find((pane) => pane.paneId === 'pane-helper-0')?.state).toBe(expected);
    const snapshot = projectMissionSnapshot(view);
    expect(snapshot.agents.find((agent) => agent.id === 'pane:pane-helper-0')?.state).toBe(expected);
    const host = renderSnapshot(snapshot);
    expect(host.querySelectorAll(`.mission-agent-card[data-state="${expected}"]`)).toHaveLength(1);
    expect(host.querySelectorAll('.mission-graph__cable-group[data-edge-live="true"]')).toHaveLength(0);
    expect(host.querySelectorAll('.mission-graph__packets')).toHaveLength(0);
  });

  it('missão da aba com 8 helpers vivos sem linha em missionPanes → 9 cards e 8 cabos de Delegação', () => {
    liveTeam();
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({ mission: mission(), panes: [orchestratorRow] }),
      missionId,
    );
    const snapshot = projectMissionSnapshot(view);
    const host = renderSnapshot(snapshot);
    dumpForScreenshot('graph-8-helpers', host);

    const cards = host.querySelectorAll('.mission-agent-card');
    expect(cards).toHaveLength(9);
    expect(
      host.querySelectorAll('.mission-agent-card[data-category="orchestrator"]'),
    ).toHaveLength(1);
    const delegation = host.querySelectorAll(
      '.mission-graph__edges .mission-graph__edge[data-edge-kind="delegation"]',
    );
    expect(delegation).toHaveLength(8);
    // Cada helper, com a CLI e o modelo do pane, aparece pelo nome do pane.
    for (const helper of HELPERS) {
      expect(host.textContent).toContain(helper.title);
      expect(host.textContent).toContain(
        'model' in helper ? `${helper.adapterId} · ${helper.model}` : helper.adapterId,
      );
    }
    // Pacotes correm no cabo de quem trabalha agora (busy), não no ocioso.
    const working = snapshot.agents.filter(
      (agent) => agent.category !== 'orchestrator' && agent.state === 'working',
    );
    expect(working.length).toBeGreaterThan(0);
    expect(
      host.querySelectorAll(
        '.mission-graph__cable-group[data-edge-kind="delegation"][data-edge-live="true"]',
      ),
    ).toHaveLength(working.length);
  });

  it('20 helpers vivos → 21 cards e 20 cabos de Delegação', () => {
    liveTeam(20);
    const snapshot = projectMissionSnapshot(
      projectMissionEngineSnapshotView(
        scope,
        stores({ mission: mission(), panes: [orchestratorRow] }),
        missionId,
      ),
    );
    const host = renderSnapshot(snapshot);
    dumpForScreenshot('graph-20-helpers', host);

    expect(host.querySelectorAll('.mission-agent-card')).toHaveLength(21);
    expect(
      host.querySelectorAll('.mission-graph__edges .mission-graph__edge[data-edge-kind="delegation"]'),
    ).toHaveLength(20);
  });

  it('papel pelo que o helper faz: análise read-only é Pesquisa, writer é Execução, revisão é Revisão', () => {
    liveTeam();
    const snapshot = projectMissionSnapshot(
      projectMissionEngineSnapshotView(
        scope,
        stores({ mission: mission(), panes: [orchestratorRow] }),
        missionId,
      ),
    );
    const byName = new Map(snapshot.agents.map((agent) => [agent.agentName, agent] as const));
    expect(byName.get('Análise do grafo')).toMatchObject({
      id: 'pane:pane-helper-0',
      category: 'scout',
      cli: 'codex',
      model: 'gpt-5.5',
      paneId: 'pane-helper-0',
    });
    expect(byName.get('Writer F-777')?.category).toBe('executor');
    expect(byName.get('Revisão independente')?.category).toBe('reviewer');
  });

  it('helper que entregou e fechou o pane sai do grafo; o que ficou aberto continua Concluído', () => {
    liveTeam();
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({
        mission: mission(),
        panes: [orchestratorRow],
        handoffs: [
          // Pane fechado no handoff success: só o handoff sobra.
          { id: 'h-1', missionId, sessionId: 's-closed', fromAgent: 'Antigravity (agy)', status: 'success', createdAt: 10 },
          // Helper vivo que já entregou e ficou ocioso: Concluído, não Na fila.
          { id: 'h-2', missionId, sessionId: 's-helper-2', fromAgent: 'Kimi', status: 'success', createdAt: 11 },
          // Os sintéticos do supervisor não são entrega.
          { id: 'h-3', missionId, sessionId: 's-stalled', fromAgent: 'Devin', status: 'stalled', createdAt: 12 },
        ],
      }),
      missionId,
    );
    const snapshot = projectMissionSnapshot(view);
    const host = renderSnapshot(snapshot);
    dumpForScreenshot('graph-entregas', host);

    expect(snapshot.agents).toHaveLength(9);
    expect(snapshot.agents.find((agent) => agent.id === 'session:s-closed')).toBeUndefined();
    expect(snapshot.agents.find((agent) => agent.id === 'pane:pane-helper-2')?.state).toBe('done');
    expect(snapshot.agents.some((agent) => agent.id === 'session:s-stalled')).toBe(false);
    expect(
      host.querySelectorAll('.mission-agent-card[data-state="done"]'),
    ).toHaveLength(1);
    expect(
      host.querySelectorAll('.mission-graph__edges .mission-graph__edge[data-edge-kind="handoff"]'),
    ).toHaveLength(1);
    expect(
      host.querySelectorAll('.mission-graph__edges .mission-graph__edge[data-edge-kind="delegation"]'),
    ).toHaveLength(8);
  });

  it('missão com squad: helper aberto fora do roster ganha card próprio em vez de sumir', () => {
    harness.squads.set('fullstack', {
      id: 'fullstack',
      agents: [
        { id: 'maestro', agentName: 'Maestro', category: 'orchestrator', cli: 'claude' },
        { id: 'frontend', agentName: 'Frontend', category: 'executor', cli: 'codex' },
      ],
    });
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 's-orch', paneId: 'pane-orch', source: 'durable', proven: true,
    });
    harness.sessionStates.set('s-orch', 'busy');
    harness.sessionStates.set('s-extra', 'busy');
    harness.paneSnapshots = [
      { paneId: 'pane-orch', sessionId: 's-orch', kind: 'cli-agent', missionId, title: 'Maestro' },
      { paneId: 'pane-extra', sessionId: 's-extra', kind: 'cli-agent', missionId, title: 'Ajudante GLM' },
    ];
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({
        mission: mission({ squadId: 'fullstack', intentContract: undefined, intentVersion: 0 }),
        panes: [
          orchestratorRow,
          { id: 'row-extra', missionId, paneId: 'pane-extra', role: 'worker', adapterId: 'glm', title: 'Ajudante GLM', agentName: 'Ajudante GLM', createdAt: 2 } as MissionPaneSpec,
        ],
      }),
      missionId,
    );
    const snapshot = projectMissionSnapshot(view);

    expect(snapshot.agents.map((agent) => agent.id)).toEqual(['maestro', 'pane:pane-extra']);
    expect(snapshot.agents[1]).toMatchObject({ agentName: 'Ajudante GLM', cli: 'glm', state: 'working' });
    expect(snapshot.edges).toEqual([
      expect.objectContaining({ kind: 'delegation', sourceAgentId: 'maestro', targetAgentId: 'pane:pane-extra' }),
    ]);
  });

  it('histórico morto não conta: a equipe e os cards são só os panes abertos agora', () => {
    harness.resolveMissionLeader.mockReturnValue({
      sessionId: 's-orch', paneId: 'pane-orch', source: 'durable', proven: true,
    });
    harness.sessionStates.set('s-orch', 'idle');
    harness.sessionStates.set('s-live-a', 'busy');
    harness.sessionStates.set('s-live-b', 'idle');
    const dead = Array.from({ length: 70 }, (_, index) => ({
      id: `row-dead-${index}`,
      missionId,
      paneId: `pane-dead-${index}`,
      role: 'worker' as const,
      adapterId: 'codex',
      title: `Morto ${index}`,
      agentName: `Morto ${index}`,
      createdAt: 100 + index,
    }));
    for (const row of dead) harness.sessionStates.set(`s-${row.paneId}`, 'exited');
    harness.paneSnapshots = [
      { paneId: 'pane-orch', sessionId: 's-orch', kind: 'cli-agent', missionId, role: 'orchestrator', state: 'idle', adapterId: 'claude' },
      { paneId: 'pane-live-a', sessionId: 's-live-a', kind: 'cli-agent', missionId, role: 'worker', state: 'busy', adapterId: 'glm', title: 'Vivo A' },
      { paneId: 'pane-live-b', sessionId: 's-live-b', kind: 'cli-agent', missionId, role: 'worker', state: 'idle', adapterId: 'kimi', title: 'Vivo B' },
      ...dead.map((row) => ({
        paneId: row.paneId,
        sessionId: `s-${row.paneId}`,
        kind: 'cli-agent',
        missionId,
        role: 'worker',
        state: 'exited',
        adapterId: 'codex',
      })),
    ];
    const view = projectMissionEngineSnapshotView(
      scope,
      stores({
        mission: mission(),
        panes: [
          orchestratorRow,
          { id: 'row-a', missionId, paneId: 'pane-live-a', role: 'worker', adapterId: 'glm', title: 'Vivo A', agentName: 'Vivo A', createdAt: 2 } as MissionPaneSpec,
          { id: 'row-b', missionId, paneId: 'pane-live-b', role: 'worker', adapterId: 'kimi', title: 'Vivo B', agentName: 'Vivo B', createdAt: 3 } as MissionPaneSpec,
          ...dead,
        ] as MissionPaneSpec[],
      }),
      missionId,
    );
    const snapshot = projectMissionSnapshot(view);
    expect(snapshot.agents.map((agent) => agent.id).sort()).toEqual([
      'orchestrator',
      'pane:pane-live-a',
      'pane:pane-live-b',
    ]);
    expect(snapshot.agents.find((agent) => agent.id === 'orchestrator')).toMatchObject({
      paneId: 'pane-orch',
      terminalLive: true,
    });
    const host = renderSnapshot(snapshot);
    expect(host.querySelectorAll('.mission-agent-card')).toHaveLength(3);
    const progress = qualitativeProgress(snapshot.agents);
    expect(progress?.total).toBe(2);
    expect(progress?.line).not.toContain('(20)');
    expect(progress?.line).not.toContain('(70)');
  });

  it('pane de outro projeto, de outra missão e solto sem missão não entram na equipe', () => {
    liveTeam(1);
    harness.sessionStates.set('s-foreign', 'busy');
    harness.sessionStates.set('s-other', 'busy');
    harness.sessionStates.set('s-loose', 'busy');
    harness.paneSnapshots.push(
      {
        paneId: 'pane-foreign',
        sessionId: 's-foreign',
        kind: 'cli-agent',
        missionId,
        role: 'worker',
        state: 'busy',
        adapterId: 'codex',
        title: 'Outro projeto',
        scope: { ...scope, projectId: 'outro-projeto', checkoutId: 'outro-checkout' },
      },
      {
        paneId: 'pane-other-mission',
        sessionId: 's-other',
        kind: 'cli-agent',
        missionId: 'mission-outra-aba',
        role: 'worker',
        state: 'busy',
        adapterId: 'glm',
        title: 'Outra aba',
      },
      {
        paneId: 'pane-loose',
        sessionId: 's-loose',
        kind: 'cli-agent',
        role: 'worker',
        state: 'busy',
        adapterId: 'kimi',
        title: 'Solto',
      },
    );
    const snapshot = projectMissionSnapshot(
      projectMissionEngineSnapshotView(
        scope,
        stores({ mission: mission(), panes: [orchestratorRow] }),
        missionId,
      ),
    );
    const ids = snapshot.agents.map((agent) => agent.id);
    expect(ids).toEqual(expect.arrayContaining(['orchestrator', 'pane:pane-helper-0']));
    expect(ids).not.toContain('pane:pane-foreign');
    expect(ids).not.toContain('pane:pane-other-mission');
    expect(ids).not.toContain('pane:pane-loose');
    expect(snapshot.agents).toHaveLength(2);
  });
});

describe('F-1059: durable sessions do not prove current board membership', () => {
  const rejected = [
    ['foreign-checkout', { scope: { ...scope, checkoutId: 'foreign-checkout' } }],
    ['foreign-mission', { missionId: 'foreign-mission' }],
    ['shell', { kind: 'shell' }],
    ['browser', { kind: 'browser' }],
    ['loose', { missionId: undefined }],
    ['absent', null],
    ['no-current-session', { sessionId: undefined }],
  ] as const;

  describe.each([
    ['squadless', undefined],
    ['squad', 'membership-squad'],
  ] as const)('%s', (_name, squadId) => {
    beforeEach(() => {
      harness.squads.set('membership-squad', {
        id: 'membership-squad', agents: [
          { id: 'maestro', agentName: 'Orquestrador', category: 'orchestrator', cli: 'claude' },
          { id: 'worker', agentName: 'Worker', category: 'executor', cli: 'codex' },
        ],
      });
    });

    it.each(rejected)('recorded worker + busy historical dispatch excludes %s snapshot', (_, override) => {
      liveTeam(0);
      harness.sessionStates.set('historical-worker', 'busy');
      if (override) harness.paneSnapshots.push({
        paneId: 'recorded-worker', sessionId: 'historical-worker', kind: 'cli-agent',
        missionId, role: 'worker', adapterId: 'codex', scope, ...override,
      });
      const view = projectMissionEngineSnapshotView(scope, stores({
        mission: mission({ squadId }), panes: [orchestratorRow, {
          id: 'row-worker', missionId, paneId: 'recorded-worker', role: 'worker',
          adapterId: 'codex', agentName: 'Worker', createdAt: 2,
        } as MissionPaneSpec],
        dispatches: [{ paneId: 'recorded-worker', sessionId: 'historical-worker', agentRef: 'worker' }],
      }), missionId);
      expect(view.roster.map(agent => agent.id)).toEqual([squadId ? 'maestro' : 'orchestrator']);
      const snapshot = projectMissionSnapshot(view);
      expect(snapshot.agents.some(agent => agent.paneId === 'recorded-worker')).toBe(false);
      expect(renderSnapshot(snapshot).querySelectorAll('.mission-agent-card')).toHaveLength(1);
    });

    it.each(rejected)('persisted leader + physically idle session excludes %s board snapshot', (_, override) => {
      liveTeam(0);
      harness.sessionStates.set('s-orch', 'idle');
      harness.paneSnapshots = override ? [{
        paneId: 'pane-orch', sessionId: 's-orch', kind: 'cli-agent', missionId,
        role: 'orchestrator', adapterId: 'claude', scope, ...override,
      }] : [];
      const view = projectMissionEngineSnapshotView(scope, stores({
        mission: mission({ squadId }), panes: [orchestratorRow],
      }), missionId);
      expect(view.roster).toEqual([]);
      expect(projectMissionSnapshot(view).agents).toEqual([]);
      // Board proof does not rewrite physical mission leadership/liveness.
      expect(view.orchestratorLive).toBe(true);
      expect(view.orchestratorIdle).toBe(true);
    });
  });

  it.each(['spawning', 'busy', 'idle'])('pending-ACK helper with a current %s session remains a member without a durable row', (sessionState) => {
    liveTeam(1);
    harness.sessionStates.set('s-helper-0', sessionState);
    harness.paneSnapshots[1] = {
      ...harness.paneSnapshots[1], scope,
      executionScope: { ...scope, rootRealPath: '/pending-ack-writer' },
    };
    const view = projectMissionEngineSnapshotView(scope, stores({
      mission: mission(), panes: [orchestratorRow],
    }), missionId);
    expect(projectMissionSnapshot(view).agents.find(agent => agent.id === 'pane:pane-helper-0')).toMatchObject({
      paneId: 'pane-helper-0', terminalLive: true,
    });
  });

  it('a rejected newer historical dispatch cannot claim the live older squad worker identity', () => {
    liveTeam(0);
    harness.squads.set('identity-squad', { id: 'identity-squad', agents: [
      { id: 'maestro', agentName: 'Orquestrador', category: 'orchestrator', cli: 'claude' },
      { id: 'worker', agentName: 'Worker', category: 'executor', cli: 'codex' },
    ] });
    harness.sessionStates.set('live-worker', 'idle');
    harness.sessionStates.set('historical-worker', 'busy');
    harness.paneSnapshots.push({
      paneId: 'older-worker', sessionId: 'live-worker', kind: 'cli-agent',
      missionId, role: 'worker', adapterId: 'codex', scope,
      executionScope: { ...scope, rootRealPath: '/isolated-writer' },
    });
    const view = projectMissionEngineSnapshotView(scope, stores({
      mission: mission({ squadId: 'identity-squad' }),
      panes: [orchestratorRow, ...['older-worker', 'newer-worker'].map((paneId, i) => ({
        id: `row-${paneId}`, paneId, missionId, role: 'worker', adapterId: 'codex', agentName: 'Worker', createdAt: i + 2,
      } as MissionPaneSpec))],
      dispatches: [{ paneId: 'newer-worker', sessionId: 'historical-worker', agentRef: 'worker' }],
    }), missionId);
    expect(projectMissionSnapshot(view).agents.find(agent => agent.id === 'worker')).toMatchObject({
      paneId: 'older-worker', terminalLive: true,
    });
  });
});

describe('F-777: o layout por linhas cabe 10 a 20 helpers', () => {
  function team(helpers: number): MissionAgentSnapshot[] {
    return [
      { id: 'orch', agentName: 'Orquestrador', category: 'orchestrator', cli: 'claude', state: 'working' },
      ...Array.from({ length: helpers }, (_, index) => ({
        id: `helper-${index}`,
        agentName: `Helper ${index}`,
        category: 'executor' as const,
        cli: 'codex',
        state: 'working' as const,
      })),
    ];
  }

  it.each([10, 20])('%i helpers: nenhum rack sobrepõe outro e todos ficam dentro da largura', (helpers) => {
    const agents = team(helpers);
    const layout = layoutMissionGraph(agents);
    expect(layout).toHaveLength(helpers + 1);
    const boxes = layout.map((position, index) => {
      const width = index === 0 ? CORE_WIDTH : RACK_WIDTH;
      const height = index === 0 ? CORE_HEIGHT : RACK_HEIGHT;
      return {
        left: position.x - width / 2,
        right: position.x + width / 2,
        top: position.y - height / 2,
        bottom: position.y + height / 2,
      };
    });
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(960);
    }
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        const overlap =
          boxes[a]!.left < boxes[b]!.right &&
          boxes[b]!.left < boxes[a]!.right &&
          boxes[a]!.top < boxes[b]!.bottom &&
          boxes[b]!.top < boxes[a]!.bottom;
        expect(overlap, `${layout[a]!.agentId} × ${layout[b]!.agentId}`).toBe(false);
      }
    }
  });
});
