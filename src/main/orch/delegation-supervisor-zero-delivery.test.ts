// @vitest-environment node
/**
 * F-986: scan real do supervisor com o watchdog de zero entrega VERDADEIRO.
 * Campo: missão de estudo com seis panes somente leitura vivos e ocupados
 * recebeu "[zero-delivery-escalate] Declare o worker anterior morto" após
 * 7 min. Aqui: pane ocupado nunca dispara, e pane parado só depois do prazo
 * de estudo, com mensagem que manda ler antes e nunca fechar pane busy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';

const h = vi.hoisted(() => ({
  onScope: null as null | ((scope: unknown, suite: unknown) => void),
  listPaneSnapshots: vi.fn((): unknown[] => []),
  getSemantic: vi.fn(
    (_sessionId: string): { status: string; updatedAt: number } | null => null,
  ),
  toolActivity: vi.fn((_sessionId: string) => 0),
  onHandoffSubmitted: vi.fn(),
  submit: vi.fn(),
}));

vi.mock('./project-domain-store-registry', () => ({
  requireProjectDomainStoreRegistry: () => ({
    onScope: (cb: (scope: unknown, suite: unknown) => void) => {
      h.onScope = cb;
      return () => {};
    },
  }),
}));
vi.mock('./pane-registry', () => ({
  listPaneSnapshots: h.listPaneSnapshots,
  tapPendingSpawnStartFailure: vi.fn(() => () => {}),
}));
vi.mock('./agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-status')>()),
  getAgentSemanticStatusBySession: h.getSemantic,
  getAgentToolActivityCount: h.toolActivity,
}));
vi.mock('./idle-delivery', () => ({
  onHandoffSubmitted: h.onHandoffSubmitted,
  redeliverPendingHandoffs: vi.fn(),
}));
vi.mock('./squad-store', () => ({ getSquad: vi.fn(() => null) }));
vi.mock('./mission-event-emit', () => ({
  emitChefIdleAwaitingWorkers: vi.fn(),
  emitMissionEvent: vi.fn(),
}));
vi.mock('./mission-intent-events', () => ({ emitMissionIntentEvent: vi.fn() }));
vi.mock('./mission-engine-registry', () => ({
  missionEngineForScope: () => ({ blockTechnical: vi.fn() }),
}));
vi.mock('./mission-momentum-watchdog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mission-momentum-watchdog')>()),
  decideMomentumNudge: vi.fn(() => ({ action: 'none' })),
}));
vi.mock('./nexus-task-fail-closed-recovery', () => ({
  flushAllNexusTaskFailClosedRetries: vi.fn(),
}));
vi.mock('../observability/main-trace', () => ({ trace: vi.fn() }));

import {
  prepareDelegationSupervisor,
  reconcileDelegationSupervisor,
  shutdownDelegationSupervisor,
} from './delegation-supervisor';

const NOW = 200_000_000;
const MIN = 60_000;
const SCOPE = { projectId: 'p', checkoutId: 'c' };

function studyMission(): Mission {
  return {
    id: 'mission-estudo',
    title: 'Estudo de repositório grande',
    description: 'Seis panes somente leitura analisando o código',
    status: 'running',
    squadId: 'squad-1',
    milestones: [],
    learnings: '',
    createdAt: NOW - MIN,
    updatedAt: NOW - MIN,
    orchestratorSessionId: 'session-orch',
    intentState: 'dispatched',
    intentVersion: 1,
    intentContract: { version: 1, lane: 'standard', dispatchedAt: NOW },
  } as unknown as Mission;
}

function suite(mission: Mission) {
  return {
    scope: SCOPE,
    missions: {
      list: () => [mission],
      listIdsBatch: (after?: string) => (after ? [] : [mission.id]),
      get: () => mission,
      setStatus: vi.fn(),
    },
    tasks: { list: () => [] },
    handoffs: {
      list: vi.fn(() => []),
      submit: h.submit.mockImplementation((input: Record<string, unknown>) => ({
        id: `handoff-${h.submit.mock.calls.length}`,
        createdAt: NOW,
        delivered: false,
        deliveryState: 'queued',
        ...input,
      })),
      markSubmitted: vi.fn(() => true),
    },
  };
}

function panes(mission: Mission, workerState: 'busy' | 'idle') {
  return [
    {
      paneId: 'pane-orch',
      sessionId: 'session-orch',
      title: 'Maestro',
      kind: 'cli-agent',
      role: 'orchestrator',
      state: 'idle',
      missionId: mission.id,
    },
    ...Array.from({ length: 6 }, (_, index) => ({
      paneId: `pane-estudo-${index}`,
      sessionId: `session-estudo-${index}`,
      title: `estudo ${index}`,
      kind: 'cli-agent',
      role: 'worker',
      state: workerState,
      readOnly: true,
      adapterId: 'claude',
      missionId: mission.id,
    })),
  ];
}

function zeroDeliverySummaries(): string[] {
  return h.submit.mock.calls
    .map((call) => String((call[0] as { summary?: unknown }).summary ?? ''))
    .filter((summary) => summary.includes('[zero-delivery'));
}

describe('F-986: vigia de zero entrega no scan real', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    h.getSemantic.mockReturnValue(null);
    h.toolActivity.mockReturnValue(0);
    await shutdownDelegationSupervisor();
    prepareDelegationSupervisor();
  });

  it('seis panes readOnly ocupados por uma hora: nenhum poke, nenhuma escalada', async () => {
    const mission = studyMission();
    h.onScope!(SCOPE, suite(mission));
    h.listPaneSnapshots.mockReturnValue(panes(mission, 'busy'));
    for (const minutes of [3, 4, 7, 8, 9, 15, 25, 40, 60]) {
      await reconcileDelegationSupervisor(NOW + minutes * MIN);
    }
    expect(zeroDeliverySummaries()).toEqual([]);
  });

  it('pane readOnly com PTY quieto mas ferramentas novas a cada varredura segue vivo', async () => {
    const mission = studyMission();
    h.onScope!(SCOPE, suite(mission));
    h.listPaneSnapshots.mockReturnValue(panes(mission, 'idle'));
    let tools = 0;
    h.toolActivity.mockImplementation(() => tools);
    for (let minutes = 1; minutes <= 40; minutes += 1) {
      tools += 1;
      await reconcileDelegationSupervisor(NOW + minutes * MIN);
    }
    expect(zeroDeliverySummaries()).toEqual([]);
  });

  it('readOnly parado de fato: poke só após 10 min de silêncio e escalada sem mandar matar pane ocupado', async () => {
    const mission = studyMission();
    h.onScope!(SCOPE, suite(mission));
    // Ocupados nos primeiros 5 min; depois silêncio total.
    h.listPaneSnapshots.mockReturnValue(panes(mission, 'busy'));
    await reconcileDelegationSupervisor(NOW + 5 * MIN);
    h.listPaneSnapshots.mockReturnValue(panes(mission, 'idle'));
    await reconcileDelegationSupervisor(NOW + 8 * MIN);
    await reconcileDelegationSupervisor(NOW + 14 * MIN);
    expect(zeroDeliverySummaries()).toEqual([]);

    await reconcileDelegationSupervisor(NOW + 15 * MIN);
    let summaries = zeroDeliverySummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('[zero-delivery:mission-estudo]');
    expect(summaries[0]).toContain('disco vazio não é sinal');

    await reconcileDelegationSupervisor(NOW + 24 * MIN);
    expect(zeroDeliverySummaries()).toHaveLength(1);

    await reconcileDelegationSupervisor(NOW + 25 * MIN);
    summaries = zeroDeliverySummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries[1]).toContain('[zero-delivery-escalate:mission-estudo]');
    expect(summaries[1]).toContain('nunca feche pane busy');
    expect(summaries[1]).not.toContain('Declare o worker anterior morto');
  });
});
