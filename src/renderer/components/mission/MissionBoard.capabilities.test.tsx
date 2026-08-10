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
  MissionRuntimeCloseResult,
} from '../../../shared/orch-types';
import { useMissionInspectorStore } from '../../state/mission-inspector-store';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useToastStore } from '../../state/toast-store';
import { useWorkspaceStore } from '../../state/workspace-store';

const capabilityMocks = vi.hoisted(() => ({
  askConfirm: vi.fn(),
  closeRuntime: vi.fn(),
  promotePlan: vi.fn(),
}));

vi.mock('../../state/confirm-store', () => ({
  askConfirm: capabilityMocks.askConfirm,
}));

vi.mock('../../orch/close-mission-runtime', () => ({
  closeMissionRuntimeAndPanes: capabilityMocks.closeRuntime,
  closeMissionNote: (count: number) =>
    count === 1 ? '1 processo encerrado.' : `${count} processos encerrados.`,
}));

vi.mock('../../orch/plan-promote-flow', () => ({
  promotePlanMissionToExecution: capabilityMocks.promotePlan,
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
  capabilityMocks.askConfirm.mockResolvedValue(true);
  capabilityMocks.closeRuntime.mockResolvedValue({
    ok: true,
    terminatedSessionIds: ['session-capability'],
  } satisfies MissionRuntimeCloseResult);
  capabilityMocks.promotePlan.mockResolvedValue({ ok: true });

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('durable plan promotion from the canonical mission board', () => {
  it('restores Executar plano from rehydrated mission state after the deduped shortcut toast expires', async () => {
    const planMission = mission({
      intentState: 'ready_to_start',
      intentVersion: 1,
      intentContract: approvedContract('plan'),
    });
    snapshotForBoard = snapshot({ id: planMission.id, title: planMission.title });

    act(() => {
      useToastStore.getState().push('success', 'Plano pronto', {
        dedupeKey: `plan-ready:${planMission.id}`,
        action: { label: 'Executar plano', onClick: vi.fn() },
      });
      useToastStore.getState().push('success', 'Plano pronto novamente', {
        dedupeKey: `plan-ready:${planMission.id}`,
        action: { label: 'Executar plano', onClick: vi.fn() },
      });
    });
    expect(useToastStore.getState().toasts).toHaveLength(1);

    const host = mount(
      <MissionBoard missionId={planMission.id} onOpenTerminals={vi.fn()} />,
    );
    await settle();
    expect(buttonByName(host, /Executar plano/i)).toBeNull();

    act(() => {
      const [toast] = useToastStore.getState().toasts;
      if (toast) useToastStore.getState().dismiss(toast.id);
      useOrchStore.setState({ missions: [planMission] });
    });
    await settle();

    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(buttonByName(host, /Executar plano/i)).not.toBeNull();
  });

  it('disables promotion immediately and rejects a double submit while native review is pending', async () => {
    const pending = deferred<{ ok: boolean; cancelled?: boolean; error?: string }>();
    capabilityMocks.promotePlan.mockReturnValueOnce(pending.promise);
    const planMission = mission({
      intentState: 'ready_to_start',
      intentVersion: 1,
      intentContract: approvedContract('plan'),
    });
    const host = renderMissionBoard(planMission, 'review_ready');
    await settle();

    const promote = buttonByName(host, /Executar plano/i);
    expect(promote).not.toBeNull();
    act(() => {
      promote!.click();
      promote!.click();
    });

    expect(capabilityMocks.promotePlan).toHaveBeenCalledTimes(1);
    expect(promote!.disabled).toBe(true);
    expect(promote!.getAttribute('aria-busy')).toBe('true');

    pending.resolve({ ok: true });
    await settle();
    expect(promote!.disabled).toBe(false);
    expect(announcementText(host)).toMatch(/plano.+(promovido|execução)/i);
  });

  it('treats mode-picker cancellation as a focus-safe cancellation, not an error', async () => {
    capabilityMocks.promotePlan.mockResolvedValueOnce({
      ok: false,
      cancelled: true,
    });
    const planMission = mission({
      intentState: 'ready_to_start',
      intentVersion: 1,
      intentContract: approvedContract('plan'),
    });
    const host = renderMissionBoard(planMission, 'review_ready');
    await settle();

    const promote = requiredButton(host, /Executar plano/i);
    promote.focus();
    act(() => promote.click());
    await settle();

    expect(promote.disabled).toBe(false);
    expect(document.activeElement).toBe(promote);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(useProductNavigationStore.getState().destination).toMatchObject({
      kind: 'mission',
      missionId: planMission.id,
    });
  });

  it('announces promotion failure, restores focus, and keeps the current mission open', async () => {
    capabilityMocks.promotePlan.mockResolvedValueOnce({
      ok: false,
      error: 'A revisão nativa não pôde ser aberta.',
    });
    const planMission = mission({
      intentState: 'ready_to_start',
      intentVersion: 1,
      intentContract: approvedContract('plan'),
    });
    const host = renderMissionBoard(planMission, 'review_ready');
    await settle();

    const promote = requiredButton(host, /Executar plano/i);
    promote.focus();
    act(() => promote.click());
    await settle();

    expect(announcementText(host)).toMatch(/revisão nativa não pôde ser aberta/i);
    expect(document.activeElement).toBe(promote);
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: planMission.id,
      surface: 'board',
    });
  });
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
      forbidden: /Descartar|Remover|Parar/i,
    },
    {
      label: 'automatic recovery',
      current: mission({
        status: 'blocked',
        intentState: 'blocked_technical',
        intentVersion: 1,
        intentContract: approvedContract(),
      }),
      snapshotState: 'recovering' as const,
      expected: /Parar/i,
      forbidden: /Descartar|Remover|Encerrar/i,
    },
    {
      label: 'eligible draft',
      current: mission({ status: 'pending', intentState: 'draft' }),
      snapshotState: 'draft' as const,
      expected: /Descartar/i,
      forbidden: /Remover|Encerrar|Parar/i,
    },
    {
      label: 'terminal history',
      current: mission({ status: 'done', intentState: 'done' }),
      snapshotState: 'completed' as const,
      expected: /Remover/i,
      forbidden: /Descartar|Encerrar|Parar/i,
    },
  ])('offers only the safe $label action', async (testCase) => {
    const host = renderMissionBoard(testCase.current, testCase.snapshotState);
    await settle();

    expect(buttonByName(host, testCase.expected)).not.toBeNull();
    expect(buttonByName(host, testCase.forbidden)).toBeNull();
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
      buttonByName(host, /Descartar|Remover|Encerrar|Parar/i),
    ).toBeNull();
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
