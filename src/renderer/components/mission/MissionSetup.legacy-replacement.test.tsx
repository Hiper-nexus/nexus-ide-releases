/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileIntentContract } from '../../../shared/mission-intent';
import type {
  MissionReview,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import type { Mission, Squad } from '../../../shared/orch-types';
import { DEFAULT_ORCH_SETTINGS } from '../../../shared/settings-types';
import { resumeIntentFirstMissionShell } from '../../orch/confirm-reopen-mission';
import { useMissionSetupStore } from '../../state/mission-setup-store';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { MissionSetup } from './MissionSetup';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

const workspace = {
  path: '/workspace',
  name: 'workspace',
  lastOpenedAt: 1,
};
const squad: Squad = {
  id: 'saved-squad',
  name: 'Equipe salva',
  createdAt: '1',
  builtin: false,
  orchestratorInstructions: 'Coordene a missão.',
  agents: [
    {
      id: 'coordinator',
      agentName: 'Coordenar',
      category: 'orchestrator',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      allowedTools: ['nexus_task'],
      allowedSkills: [],
    },
    {
      id: 'maker',
      agentName: 'Implementar',
      category: 'executor',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      allowedTools: ['Read', 'Edit'],
      allowedSkills: [],
    },
    {
      id: 'reviewer',
      agentName: 'Revisar',
      category: 'reviewer',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      allowedTools: ['Read'],
      allowedSkills: [],
    },
  ],
};
const legacyShell: Mission = {
  id: 'legacy-shell',
  title: 'Continuar o checkout',
  description: 'Descrição antiga.',
  status: 'pending',
  squadId: squad.id,
  milestones: [],
  learnings: '',
  intentState: 'ready_to_start',
  intentVersion: 3,
  intentContract: compileIntentContract({
    goal: 'Corrigir o total do checkout e provar o resultado.',
    source: 'typed',
    intentVersion: 3,
    lane: 'standard',
    contextPolicy: 'minimal',
    contextPaths: ['src/checkout.ts'],
  }),
  createdAt: 1,
  updatedAt: 2,
};
const review: MissionReview = {
  missionId: 'replacement-mission',
  title: legacyShell.title,
  objective: legacyShell.intentContract!.goal,
  workspaceLabel: workspace.name,
  contextPaths: ['src/checkout.ts'],
  roster: squad.agents,
  permissions: [],
  warnings: [],
  reviewSha256: 'f'.repeat(64),
  createdAt: 10,
};
const snapshot: MissionSnapshot = {
  id: 'replacement-running',
  title: review.title,
  objective: review.objective,
  workspaceLabel: review.workspaceLabel,
  state: 'running',
  progress: { completed: 0, total: 2 },
  agents: [],
  edges: [],
  units: [],
  allowedActions: ['direct', 'stop'],
  version: 1,
  updatedAt: review.createdAt + 1,
};
const api = {
  prepare: vi.fn(async () => review),
  start: vi.fn(async () => snapshot),
  removeMission: vi.fn(async () => ({ removed: true })),
};
const roots = new Set<Root>();
const initialWorkspaceState = useWorkspaceStore.getState();

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function renderReplacement(): HTMLElement {
  expect(resumeIntentFirstMissionShell(legacyShell)).toMatchObject({
    ok: true,
    intentShell: true,
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.add(root);
  act(() => root.render(<MissionSetup />));
  return host;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(host: HTMLElement, pattern: RegExp): HTMLButtonElement {
  const match = Array.from(host.querySelectorAll('button')).find((candidate) =>
    pattern.test(candidate.textContent ?? ''),
  );
  if (!match) throw new Error(`Button not found: ${String(pattern)}`);
  return match;
}

function replacementContext(): unknown {
  const state: unknown = useMissionSetupStore.getState();
  if (!state || typeof state !== 'object' || !('entryContext' in state)) {
    return null;
  }
  return state.entryContext;
}

beforeEach(() => {
  localStorage.clear();
  api.prepare.mockReset();
  api.prepare.mockResolvedValue(review);
  api.start.mockReset();
  api.start.mockResolvedValue(snapshot);
  api.removeMission.mockReset();
  api.removeMission.mockResolvedValue({ removed: true });
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      adapters: { list: vi.fn(async () => []) },
      providers: { list: vi.fn(async () => []) },
      accounts: { list: vi.fn(async () => []) },
      settings: { orchGet: vi.fn(async () => DEFAULT_ORCH_SETTINGS) },
      mission: { prepare: api.prepare, start: api.start },
      orch: { removeMission: api.removeMission },
    } as unknown as Window['nexus'],
  });
  useWorkspaceStore.setState({
    ...initialWorkspaceState,
    current: workspace,
    recents: [workspace],
    hydrated: true,
  });
  useOrchStore.setState({ squads: [squad], missions: [legacyShell] });
  useMissionSetupStore.setState({
    workspacePath: workspace.path,
    draft: {
      objective: '',
      title: '',
      contextPaths: [],
      roster: [],
      advanced: { lane: 'standard' },
      step: 'mission',
      revision: 0,
    },
    persistence: { status: 'idle' },
    workspaceDrafts: {},
    entryContext: null,
  } as never);
  useProductNavigationStore.setState({
    destination: { kind: 'terminal' },
    settingsReturnDestination: null,
  });
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  delete (window as { nexus?: unknown }).nexus;
});

describe('Mission Setup — legacy shell replacement', () => {
  it('keeps the old shell after replacement preparation fails', async () => {
    api.prepare.mockRejectedValueOnce(new Error('prepare failed'));
    const host = renderReplacement();
    await flush();

    expect(host.textContent).toContain('Não foi possível preparar a revisão');
    expect(api.removeMission).not.toHaveBeenCalled();
    expect(useOrchStore.getState().missions).toContainEqual(legacyShell);
    expect(replacementContext()).toEqual({
      kind: 'legacy-replacement',
      supersededMissionId: legacyShell.id,
      acceptanceCriteria: legacyShell.intentContract?.acceptanceCriteria,
    });
  });

  it('keeps the old shell when the operator backs out of replacement Review', async () => {
    const host = renderReplacement();
    await flush();

    expect(api.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptanceCriteria: legacyShell.intentContract?.acceptanceCriteria,
      }),
    );
    act(() => button(host, /voltar para equipe|cancelar/i).click());

    expect(api.removeMission).toHaveBeenCalledTimes(1);
    expect(api.removeMission).toHaveBeenCalledWith(review.missionId);
    expect(api.removeMission).not.toHaveBeenCalledWith(legacyShell.id);
    expect(useOrchStore.getState().missions).toContainEqual(legacyShell);
    expect(useMissionSetupStore.getState().draft.step).toBe('team');
  });

  it('removes the superseded shell only after the accepted replacement starts, then opens Board', async () => {
    const pendingStart = deferred<MissionSnapshot>();
    api.start.mockReturnValueOnce(pendingStart.promise);
    const host = renderReplacement();
    await flush();

    act(() => button(host, /iniciar missão/i).click());
    expect(api.start).toHaveBeenCalledWith({
      missionId: review.missionId,
      reviewSha256: review.reviewSha256,
    });
    expect(api.removeMission).not.toHaveBeenCalled();

    await act(async () => {
      pendingStart.resolve(snapshot);
      await pendingStart.promise;
    });
    await flush();
    expect(api.removeMission).not.toHaveBeenCalledWith(review.missionId);

    expect(api.removeMission).toHaveBeenCalledWith(legacyShell.id);
    expect(api.start.mock.invocationCallOrder[0]).toBeLessThan(
      api.removeMission.mock.invocationCallOrder[0]!,
    );
    expect(replacementContext()).toBeNull();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: snapshot.id,
      surface: 'board',
    });
  });

  it('finishes a deferred replacement without stealing navigation after authority leaves Setup', async () => {
    const pendingStart = deferred<MissionSnapshot>();
    api.start.mockReturnValueOnce(pendingStart.promise);
    const host = renderReplacement();
    await flush();

    act(() => button(host, /iniciar missão/i).click());
    act(() => useProductNavigationStore.getState().openTerminal());
    await flush();

    expect(api.removeMission).not.toHaveBeenCalled();
    pendingStart.resolve(snapshot);
    await pendingStart.promise;
    await flush();

    expect(api.removeMission).toHaveBeenCalledTimes(1);
    expect(api.removeMission).toHaveBeenCalledWith(legacyShell.id);
    expect(api.removeMission).not.toHaveBeenCalledWith(review.missionId);
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'terminal',
    });
  });

  it('releases a failed deferred start claim and discards only its prepared replacement', async () => {
    const pendingStart = deferred<MissionSnapshot>();
    api.start.mockReturnValueOnce(pendingStart.promise);
    const host = renderReplacement();
    await flush();

    act(() => button(host, /iniciar missão/i).click());
    act(() => useProductNavigationStore.getState().openTerminal());
    await flush();

    const failure = new Error('start failed');
    pendingStart.reject(failure);
    await pendingStart.promise.catch(() => undefined);
    await flush();

    expect(api.removeMission).toHaveBeenCalledTimes(1);
    expect(api.removeMission).toHaveBeenCalledWith(review.missionId);
    expect(api.removeMission).not.toHaveBeenCalledWith(legacyShell.id);
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'terminal',
    });
  });
});
