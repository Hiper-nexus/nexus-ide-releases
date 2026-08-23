/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  missionSnapshotSchema,
  type MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import type {
  Mission,
  MissionOperatorCompleteResult,
  MissionRuntimeCloseResult,
} from '../../../shared/orch-types';
import { MISSION_OPERATOR_APPROVED_MARKER } from '../../../shared/mission-recovery-policy';
import { MISSION_RUNTIME_CLOSED_MARKER } from '../../../shared/mission-recovery-policy';
import { buildGridTree } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { useMissionInspectorStore } from '../../state/mission-inspector-store';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useToastStore } from '../../state/toast-store';
import { useWorkspaceStore } from '../../state/workspace-store';

const capabilityMocks = vi.hoisted(() => ({
  askConfirm: vi.fn(),
  closeRuntime: vi.fn(),
}));

vi.mock('../../state/confirm-store', () => ({
  askConfirm: capabilityMocks.askConfirm,
}));

vi.mock('../../orch/close-mission-runtime', () => ({
  closeMissionRuntimeAndPanes: capabilityMocks.closeRuntime,
  closeMissionNote: (count: number) =>
    count === 1 ? '1 processo encerrado.' : `${count} processos encerrados.`,
}));


vi.mock('./MissionGraph', () => ({
  MissionGraph: () => <div aria-label="Grafo da missão" />,
}));

import { MissionBoard } from './MissionBoard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ResizeObserverStub implements ResizeObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds = [];
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
}

const roots = new Set<Root>();
let snapshotForBoard: MissionSnapshot;

const api = {
  snapshot: vi.fn<Window['nexus']['mission']['snapshot']>(),
  command: vi.fn<Window['nexus']['mission']['command']>(),
  onChanged: vi.fn<Window['nexus']['mission']['onChanged']>(),
  missionEventsRecent:
    vi.fn<Window['nexus']['orch']['missionEventsRecent']>(),
  removeMission: vi.fn<Window['nexus']['orch']['removeMission']>(),
  completeMissionByOperator:
    vi.fn<Window['nexus']['orch']['completeMissionByOperator']>(),
};

function mission(patch: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-capability',
    title: 'Publicar plano aprovado',
    description: '',
    status: 'pending',
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

function approvedContract(
  lane: 'plan' | 'standard' = 'standard',
): NonNullable<Mission['intentContract']> {
  return {
    goal: 'Publicar o plano aprovado',
    intentVersion: 1,
    approvedAt: 1,
    lane,
  } as NonNullable<Mission['intentContract']>;
}

function snapshot(
  patch: Partial<MissionSnapshot> = {},
): MissionSnapshot {
  return missionSnapshotSchema.parse({
    id: 'mission-capability',
    title: 'Publicar plano aprovado',
    objective: 'Executar a entrega revisada.',
    workspaceLabel: 'nexus (/workspace/nexus)',
    state: 'review_ready',
    progress: { completed: 0, total: 2 },
    agents: [
      {
        id: 'coordinator',
        agentName: 'Coordenador',
        category: 'orchestrator',
        cli: 'codex',
        model: 'gpt-5.6-sol',
        allowedSkills: [],
        allowedTools: null,
        state: 'waiting',
      },
    ],
    edges: [],
    units: [],
    allowedActions: [],
    version: 1,
    updatedAt: 2,
    ...patch,
  });
}

function mount(node: ReactNode): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.add(root);
  act(() => root.render(node));
  return host;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

function accessibleName(button: HTMLButtonElement): string {
  return `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`;
}

function buttonByName(
  host: ParentNode,
  name: RegExp,
): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      name.test(accessibleName(button)),
    ) ?? null
  );
}

function requiredButton(host: ParentNode, name: RegExp): HTMLButtonElement {
  const button = buttonByName(host, name);
  expect(button, `Expected button matching ${String(name)}`).not.toBeNull();
  return button!;
}

function announcementText(host: ParentNode): string {
  return [
    ...host.querySelectorAll<HTMLElement>(
      '[role="alert"], [role="status"], [aria-live]',
    ),
  ]
    .map((node) => node.textContent ?? '')
    .join(' ');
}

function renderMissionBoard(
  currentMission: Mission,
  state: MissionSnapshot['state'],
): HTMLDivElement {
  snapshotForBoard = snapshot({
    id: currentMission.id,
    title: currentMission.title,
    state,
  });
  useOrchStore.setState({
    missions: [currentMission],
    handoffs: [],
    paneMissions: {},
  });
  useProductNavigationStore.setState({
    destination: {
      kind: 'mission',
      missionId: currentMission.id,
      surface: 'board',
    },
    settingsReturnDestination: null,
  });
  return mount(
    <MissionBoard missionId={currentMission.id} onOpenTerminals={vi.fn()} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  snapshotForBoard = snapshot();
  api.snapshot.mockImplementation(async () => snapshotForBoard);
  api.command.mockImplementation(async () => snapshotForBoard);
  api.onChanged.mockImplementation(() => vi.fn());
  api.missionEventsRecent.mockResolvedValue({
    enabled: true,
    events: [],
  });
  api.removeMission.mockResolvedValue({ removed: true });
  api.completeMissionByOperator.mockResolvedValue({
    ok: true,
    mission: mission({ status: 'done', intentState: 'done' }),
  } satisfies MissionOperatorCompleteResult);
  capabilityMocks.askConfirm.mockResolvedValue(true);
  capabilityMocks.closeRuntime.mockResolvedValue({
    ok: true,
    terminatedSessionIds: ['session-capability'],
  } satisfies MissionRuntimeCloseResult);

  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      mission: {
        snapshot: api.snapshot,
        command: api.command,
        onChanged: api.onChanged,
      },
      orch: {
        missionEventsRecent: api.missionEventsRecent,
        removeMission: api.removeMission,
        completeMissionByOperator: api.completeMissionByOperator,
      },
    } as unknown as Window['nexus'],
  });

  useMissionInspectorStore.setState({
    missionId: null,
    tab: 'plan',
    selectedAgentId: null,
  });
  useOrchStore.setState({ missions: [], handoffs: [], paneMissions: {} });
  useToastStore.setState({ toasts: [] });
  useWorkspaceStore.setState({
    current: {
      path: '/workspace/nexus',
      name: 'nexus',
      lastOpenedAt: 1,
    },
    recents: [],
    hydrated: true,
  });
  useProductNavigationStore.setState({
    destination: { kind: 'launcher' },
    settingsReturnDestination: null,
  });
});

afterEach(() => {
  for (const root of [...roots].reverse()) {
    act(() => root.unmount());
    roots.delete(root);
  }
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'nexus');
  useLayoutStore.setState({ root: buildGridTree([]) });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('state-aware mission actions in the canonical mission board', () => {
  it.each([
    {
      label: 'running runtime',
      current: mission({
        status: 'running',
        intentState: 'executing',
        orchestratorSessionId: 'session-running',
      }),
      snapshotState: 'running' as const,
      expected: /Encerrar/i,
      forbidden: /Descartar|Parar|concluída/i,
    },
    {
      label: 'automatic recovery',
      current: mission({
        status: 'blocked',
        intentState: 'blocked_technical',
        intentVersion: 1,
        intentContract: approvedContract(),
        // Recovery viva é dona-deste-processo: updatedAt fresco, senão a
        // linha é leftover de boot anterior e nada está recuperando.
        updatedAt: Date.now(),
      }),
      snapshotState: 'recovering' as const,
      expected: /Parar/i,
      forbidden: /Descartar|Encerrar|concluída/i,
    },
    {
      label: 'eligible draft',
      current: mission({ status: 'pending', intentState: 'draft' }),
      snapshotState: 'draft' as const,
      expected: /Descartar/i,
      forbidden: /Encerrar|Parar|concluída/i,
    },
    {
      // O motor concluir não encerra a missão: falta a aprovação de quem
      // pediu. Só depois do carimbo humano a ação vira Remover.
      label: 'concluída pelo motor, aguardando revisão humana',
      current: mission({ status: 'done', intentState: 'done' }),
      snapshotState: 'completed' as const,
      expected: /Marcar como feito/i,
      forbidden: /Descartar|Encerrar|Parar/i,
    },
    {
      label: 'terminal history já aprovada pelo humano',
      current: mission({
        status: 'done',
        intentState: 'done',
        description: `entrega\n\n${MISSION_OPERATOR_APPROVED_MARKER}`,
      }),
      snapshotState: 'completed' as const,
      expected: /Remover/i,
      forbidden: /Descartar|Encerrar|Parar/i,
    },
    {
      label: 'completed mission with leftover transcript panes',
      current: mission({
        status: 'done',
        intentState: 'done',
        orchestratorSessionId: 'pty-stale',
        description: `entrega\n\n${MISSION_OPERATOR_APPROVED_MARKER}`,
      }),
      snapshotState: 'completed' as const,
      expected: /Remover/i,
      forbidden: /Descartar|Encerrar|Parar/i,
      seedTranscriptPanes: true,
    },
    {
      label: 'completed snapshot with stale orch runtime',
      current: mission({
        status: 'running',
        intentState: 'executing',
        orchestratorSessionId: 'pty-stale',
      }),
      snapshotState: 'completed' as const,
      expected: /Remover/i,
      forbidden: /Descartar|Encerrar|Parar|concluída/i,
      seedTranscriptPanes: true,
    },
    {
      label: 'parked after Encerrar',
      current: mission({
        status: 'blocked',
        intentState: 'blocked_user',
        description: `${MISSION_RUNTIME_CLOSED_MARKER}\nEncerrada.`,
      }),
      snapshotState: 'blocked_user' as const,
      expected: /Marcar como feito/i,
      forbidden: /Descartar|Encerrar|Parar/i,
    },
  ])('offers only the safe $label action', async (testCase) => {
    if ('seedTranscriptPanes' in testCase && testCase.seedTranscriptPanes) {
      useLayoutStore.setState({
        root: buildGridTree([
          {
            id: 'pane-transcript',
            kind: 'cli-agent',
            title: 'claude',
            adapterId: 'claude',
            missionId: testCase.current.id,
          },
        ]),
      });
    }
    const host = renderMissionBoard(testCase.current, testCase.snapshotState);
    await settle();

    expect(buttonByName(host, testCase.expected)).not.toBeNull();
    expect(buttonByName(host, testCase.forbidden)).toBeNull();
    // Ordem do operador (20/08): Remover é SEMPRE oferecido — o main encerra
    // o runtime antes de apagar; a escada Encerrar→Concluir→Remover caiu.
    expect(buttonByName(host, /Remover/i)).not.toBeNull();
  });

  it('offers Remover for a completed board even when the orch row is missing', async () => {
    snapshotForBoard = snapshot({
      id: 'mission-capability',
      title: 'Publicar plano aprovado',
      state: 'completed',
    });
    useOrchStore.setState({ missions: [], handoffs: [], paneMissions: {} });
    useProductNavigationStore.setState({
      destination: {
        kind: 'mission',
        missionId: 'mission-capability',
        surface: 'board',
      },
      settingsReturnDestination: null,
    });
    const host = mount(
      <MissionBoard
        missionId="mission-capability"
        onOpenTerminals={vi.fn()}
      />,
    );
    await settle();

    expect(buttonByName(host, /Remover/i)).not.toBeNull();
    expect(buttonByName(host, /Encerrar/i)).toBeNull();
  });

  it('esconde Terminais em missão terminal sem panes vivos (nunca shell órfão)', async () => {
    useLayoutStore.setState({ root: buildGridTree([]) });
    useOrchStore.setState({
      missions: [mission({ status: 'done', intentState: 'done' })],
      handoffs: [],
      paneMissions: {},
    });
    const host = renderMissionBoard(
      mission({ status: 'done', intentState: 'done' }),
      'completed',
    );
    await settle();

    expect(buttonByName(host, /Terminais/i)).toBeNull();
    expect(buttonByName(host, /Remover/i)).not.toBeNull();
  });

  it('esconde Terminais em missão DORMINDO/bloqueada sem panes vivos', async () => {
    // Caso real 22/08: leftover parked (Dormindo) — o clique abria shell órfão.
    useLayoutStore.setState({ root: buildGridTree([]) });
    useOrchStore.setState({
      missions: [
        mission({ status: 'blocked', intentState: 'blocked_user' }),
      ],
      handoffs: [],
      paneMissions: {},
    });
    const host = renderMissionBoard(
      mission({ status: 'blocked', intentState: 'blocked_user' }),
      'blocked_user',
    );
    await settle();

    expect(buttonByName(host, /Terminais/i)).toBeNull();
  });

  it('mantém Terminais em missão viva mesmo antes do primeiro pane', async () => {
    useLayoutStore.setState({ root: buildGridTree([]) });
    useOrchStore.setState({
      missions: [mission({ status: 'running', intentState: 'executing' })],
      handoffs: [],
      paneMissions: {},
    });
    const host = renderMissionBoard(
      mission({ status: 'running', intentState: 'executing' }),
      'running',
    );
    await settle();

    expect(buttonByName(host, /Terminais/i)).not.toBeNull();
  });

  it('mostra e foca o pane vivo da missão terminal ao abrir Terminais', async () => {
    const focus = vi.fn();
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-transcript',
          kind: 'cli-agent',
          title: 'claude',
          adapterId: 'claude',
          missionId: 'mission-capability',
        },
      ]),
      focus,
    });
    const onOpenTerminals = vi.fn();
    const host = mount(
      <MissionBoard
        missionId="mission-capability"
        onOpenTerminals={onOpenTerminals}
      />,
    );
    useOrchStore.setState({
      missions: [mission({ status: 'done', intentState: 'done' })],
      handoffs: [],
      paneMissions: { 'pane-transcript': 'mission-capability' },
    });
    await settle();

    const button = buttonByName(host, /Terminais/i);
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(onOpenTerminals).toHaveBeenCalledWith('mission-capability');
    expect(focus).toHaveBeenCalledWith('pane-transcript');
  });

  it('deletes a completed snapshot instead of calling Encerrar on a stale orch row', async () => {
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-transcript',
          kind: 'cli-agent',
          title: 'claude',
          adapterId: 'claude',
          missionId: 'mission-capability',
        },
      ]),
    });
    const stale = mission({
      status: 'running',
      intentState: 'executing',
      orchestratorSessionId: 'pty-stale',
    });
    const host = renderMissionBoard(stale, 'completed');
    await settle();

    act(() => requiredButton(host, /Remover/i).click());
    await settle();

    expect(api.removeMission).toHaveBeenCalledTimes(1);
    expect(api.removeMission).toHaveBeenCalledWith(stale.id);
    expect(capabilityMocks.closeRuntime).not.toHaveBeenCalled();
  });

  it('offers no destructive control for an active user-blocked mission with no runtime to close', async () => {
    const unsafeActive = mission({
      status: 'blocked',
      intentState: 'blocked_user',
      intentVersion: 1,
      intentContract: approvedContract(),
    });
    const host = renderMissionBoard(unsafeActive, 'blocked_user');
    await settle();

    expect(
      buttonByName(host, /Descartar|Encerrar|Parar|concluída/i),
    ).toBeNull();
    // Remover continua disponível mesmo aqui (ordem do operador, 20/08):
    // o confirm de perigo é a proteção, não a ausência do botão.
    expect(buttonByName(host, /Remover/i)).not.toBeNull();
  });

  it('marca concluída a missão estacionada pelo Encerrar sem remover o histórico', async () => {
    const parked = mission({
      status: 'blocked',
      intentState: 'blocked_user',
      description: `${MISSION_RUNTIME_CLOSED_MARKER}\nEncerrada.`,
    });
    const host = renderMissionBoard(parked, 'blocked_user');
    await settle();

    act(() => requiredButton(host, /Marcar como feito/i).click());
    await settle();

    expect(api.completeMissionByOperator).toHaveBeenCalledTimes(1);
    expect(api.completeMissionByOperator).toHaveBeenCalledWith(parked.id);
    expect(api.removeMission).not.toHaveBeenCalled();
    expect(capabilityMocks.closeRuntime).not.toHaveBeenCalled();
  });

  it('guards runtime close against double submit, announces failure, restores focus, and stays on the mission', async () => {
    const pending = deferred<MissionRuntimeCloseResult>();
    capabilityMocks.closeRuntime.mockReturnValueOnce(pending.promise);
    const running = mission({
      status: 'running',
      intentState: 'executing',
      orchestratorSessionId: 'session-running',
    });
    const host = renderMissionBoard(running, 'running');
    await settle();

    const close = requiredButton(host, /Encerrar/i);
    close.focus();
    act(() => {
      close.click();
      close.click();
    });

    expect(capabilityMocks.closeRuntime).toHaveBeenCalledTimes(1);
    expect(close.disabled).toBe(true);
    expect(close.getAttribute('aria-busy')).toBe('true');

    pending.resolve({
      ok: false,
      terminatedSessionIds: [],
      error: 'Ainda existe um processo protegido.',
    });
    await settle();

    expect(announcementText(host)).toMatch(/processo protegido/i);
    expect(document.activeElement).toBe(close);
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: running.id,
      surface: 'board',
    });
  });

  it('danger-confirms draft discard once, announces cancellation, and restores the invoking focus', async () => {
    const confirmation = deferred<boolean>();
    capabilityMocks.askConfirm.mockReturnValueOnce(confirmation.promise);
    const draft = mission({ status: 'pending', intentState: 'draft' });
    const host = renderMissionBoard(draft, 'draft');
    await settle();

    const discard = requiredButton(host, /Descartar/i);
    discard.focus();
    act(() => {
      discard.click();
      discard.click();
    });

    expect(capabilityMocks.askConfirm).toHaveBeenCalledTimes(1);
    expect(capabilityMocks.askConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true }),
    );
    expect(discard.disabled).toBe(true);
    expect(api.removeMission).not.toHaveBeenCalled();

    confirmation.resolve(false);
    await settle();

    expect(api.removeMission).not.toHaveBeenCalled();
    expect(announcementText(host)).toMatch(/cancelad/i);
    expect(document.activeElement).toBe(discard);
  });

  it.each([
    {
      workspace: {
        path: '/workspace/nexus',
        name: 'nexus',
        lastOpenedAt: 1,
      },
      destination: { kind: 'terminal' as const },
      label: 'Terminal when the workspace remains',
    },
    {
      workspace: null,
      destination: { kind: 'launcher' as const },
      label: 'Launcher when no workspace remains',
    },
  ])('routes successful terminal-history removal to $label', async (testCase) => {
    useWorkspaceStore.setState({ current: testCase.workspace });
    capabilityMocks.askConfirm.mockResolvedValueOnce(true);
    api.removeMission.mockResolvedValueOnce({ removed: true });
    const completed = mission({ status: 'done', intentState: 'done' });
    const host = renderMissionBoard(completed, 'completed');
    await settle();

    act(() => requiredButton(host, /Remover/i).click());
    await settle();

    expect(api.removeMission).toHaveBeenCalledTimes(1);
    expect(announcementText(host)).toMatch(/missão.+removid/i);
    expect(useProductNavigationStore.getState().destination).toEqual(
      testCase.destination,
    );
  });
});
