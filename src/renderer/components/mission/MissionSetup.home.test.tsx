/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORCH_SETTINGS } from '../../../shared/settings-types';
import type { AdapterInfo } from '../../../shared/adapter-types';
import type { MissionReview, MissionSnapshot } from '../../../shared/mission-engine-contract';
import {
  createEmptyMissionSetupDraft,
  type MissionSetupDraft,
  useMissionSetupStore,
} from '../../state/mission-setup-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useProviderStore } from '../../state/provider-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { MissionSetup } from './MissionSetup';

vi.mock('./ExpressMissionStart', () => ({
  ExpressMissionStart: ({ draft, error, onStart, onAdvanced, onConnectProvider, onPickWorkspace }: {
    draft: MissionSetupDraft;
    error: string | null;
    onStart(): void;
    onAdvanced(): void;
    onConnectProvider(): void;
    onPickWorkspace(): void;
  }) => (
    <section aria-label="Criar com IA">
      <output>{draft.objective}</output>
      {error ? <p role="alert">{error}</p> : null}
      <button onClick={onStart}>Iniciar criação</button>
      <button onClick={onAdvanced}>Configuração avançada</button>
      <button onClick={onConnectProvider}>Conectar IA</button>
      <button onClick={onPickWorkspace}>Escolher pasta</button>
    </section>
  ),
}));

const workspace = { path: '/projects/home-draft', name: 'Meu projeto', lastOpenedAt: 1 };
const roots: Root[] = [];
const prepare = vi.fn<Window['nexus']['mission']['prepare']>();
const start = vi.fn<Window['nexus']['mission']['start']>();
const removeMission = vi.fn().mockResolvedValue({ removed: true });
const readyCodex: AdapterInfo = {
  id: 'codex', kind: 'cli-pty', label: 'Codex', icon: 'X',
  models: { list: ['gpt-5.6-sol'], default: 'gpt-5.6-sol' },
  installed: true, installCommand: '', idleTimeoutMs: 1_000,
  orchestratorCapable: true, missionControlCapable: true,
};
const review: MissionReview = {
  missionId: 'created-from-home', title: 'Agendamento',
  objective: 'Criar página de agendamento para clientes',
  workspaceLabel: workspace.name, contextPaths: [], roster: [],
  permissions: [], warnings: [], reviewSha256: 'a'.repeat(64), createdAt: 1,
};
const snapshot: MissionSnapshot = {
  id: review.missionId, title: review.title, objective: review.objective,
  workspaceLabel: workspace.name, state: 'running',
  progress: { completed: 0, total: 2 }, agents: [], edges: [], units: [],
  allowedActions: ['direct', 'stop'], version: 1, updatedAt: 2,
};
const originalNexus = Object.getOwnPropertyDescriptor(window, 'nexus');
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function CreationRoute() {
  const destination = useProductNavigationStore((state) => state.destination);
  if (destination.kind === 'settings') {
    return <button onClick={() => useProductNavigationStore.getState().backFromSettings()}>Voltar</button>;
  }
  if (destination.kind === 'mission') {
    return <section aria-label="Missão iniciada">{destination.missionId}</section>;
  }
  return <MissionSetup home={destination.kind === 'launcher'} />;
}

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<CreationRoute />));
  return host;
}

function click(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  expect(button).toBeDefined();
  act(() => button!.click());
}

function storedDraft(step: 'team' | 'review' = 'team'): MissionSetupDraft {
  return {
    ...createEmptyMissionSetupDraft(7),
    objective: 'Criar página de agendamento para clientes',
    acceptance: 'O cliente consegue marcar seu horário.',
    title: 'Agendamento',
    contextPaths: ['brief.md'],
    roster: [
      { id: 'coordinator', agentName: 'Coordenar', category: 'orchestrator', cli: 'codex' },
      { id: 'builder', agentName: 'Construir', category: 'executor', cli: 'codex' },
    ],
    advanced: { lane: 'consult', freeAgentChoice: true },
    step,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  prepare.mockReset().mockResolvedValue(review);
  start.mockReset().mockResolvedValue(snapshot);
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      adapters: { list: vi.fn().mockResolvedValue([]) },
      providers: { list: vi.fn().mockResolvedValue([]) },
      accounts: { list: vi.fn().mockResolvedValue([]) },
      settings: { orchGet: vi.fn().mockResolvedValue(DEFAULT_ORCH_SETTINGS) },
      mission: { prepare, start },
      orch: { removeMission },
    },
  });
  useWorkspaceStore.setState({ current: workspace, recents: [], hydrated: true });
  useProviderStore.setState({ providers: [] });
  useMissionSetupStore.setState({
    workspacePath: null,
    draft: createEmptyMissionSetupDraft(),
    persistence: { status: 'idle' },
    workspaceDrafts: {},
    entryContext: null,
  });
  useProductNavigationStore.setState({ destination: { kind: 'launcher' }, settingsReturnDestination: null });
});

async function readyHome(): Promise<HTMLElement> {
  vi.mocked(window.nexus.adapters.list).mockResolvedValue([readyCodex]);
  const draft = storedDraft();
  useMissionSetupStore.setState({
    workspacePath: workspace.path,
    draft: {
      ...draft,
      roster: [...draft.roster, {
        id: 'reviewer', agentName: 'Revisar', category: 'reviewer', cli: 'codex',
      }],
    },
  });
  const host = mount();
  await act(async () => undefined);
  return host;
}

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  if (originalNexus) Object.defineProperty(window, 'nexus', originalNexus);
  else Reflect.deleteProperty(window, 'nexus');
});

describe('Creation home', () => {
  it('starts exactly once from home and opens the created mission with a cleared draft', async () => {
    const host = await readyHome();

    await act(async () => {
      click(host, 'Iniciar criação');
      click(host, 'Iniciar criação');
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ missionId: review.missionId, reviewSha256: review.reviewSha256 });
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission', missionId: snapshot.id, surface: 'board',
    });
    expect(useMissionSetupStore.getState().draft.objective).toBe('');
  });

  it.each(['prepare', 'start'] as const)('shows a %s failure on the home form and preserves the draft', async (stage) => {
    (stage === 'prepare' ? prepare : start).mockRejectedValueOnce(new Error('Não foi possível iniciar a missão.'));
    const host = await readyHome();

    await act(async () => click(host, 'Iniciar criação'));

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Não foi possível');
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'launcher' });
    expect(useMissionSetupStore.getState().draft.objective).toBe(storedDraft().objective);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(stage === 'start' ? 1 : 0);
  });

  it.each([false, true])('does not start a late preparation after leaving home (returned: %s)', async (returnHome) => {
    const pending = Promise.withResolvers<MissionReview>();
    prepare.mockReturnValueOnce(pending.promise);
    const host = await readyHome();
    await act(async () => click(host, 'Iniciar criação'));
    expect(prepare).toHaveBeenCalledTimes(1);
    act(() => useProductNavigationStore.getState().openSettings('providers'));
    if (returnHome) {
      act(() => useProductNavigationStore.getState().backFromSettings());
    }

    await act(async () => pending.resolve(review));

    expect(start).not.toHaveBeenCalled();
    expect(removeMission).toHaveBeenCalledWith(review.missionId);
    expect(useProductNavigationStore.getState().destination.kind).toBe(returnHome ? 'launcher' : 'settings');
    expect(useMissionSetupStore.getState().draft.objective).toBe(storedDraft().objective);
  });

  it('does not steal Settings navigation when an already requested start completes', async () => {
    const pending = Promise.withResolvers<MissionSnapshot>();
    start.mockReturnValueOnce(pending.promise);
    const host = await readyHome();
    await act(async () => click(host, 'Iniciar criação'));
    expect(start).toHaveBeenCalledTimes(1);
    act(() => useProductNavigationStore.getState().openSettings('providers'));

    await act(async () => pending.resolve(snapshot));

    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'settings', section: 'providers' });
    expect(useMissionSetupStore.getState().draft.objective).toBe(storedDraft().objective);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each(['team', 'review'] as const)(
    'hydrates a saved %s draft into Express without losing any authored fields',
    async (step) => {
      const saved = storedDraft(step);
      useMissionSetupStore.setState({
        workspaceDrafts: { [workspace.path]: { draft: saved, persistence: { status: 'saved' } } },
      });

      const host = mount();
      await act(async () => undefined);

      expect(host.querySelector('.mission-setup')?.getAttribute('data-step')).toBe('express');
      expect(useMissionSetupStore.getState().draft).toEqual({ ...saved, step: 'express' });
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it('does not prepare a review draft that was already loaded before opening home', async () => {
    const saved = storedDraft('review');
    useMissionSetupStore.setState({ workspacePath: workspace.path, draft: saved });

    mount();
    await act(async () => undefined);

    expect(useMissionSetupStore.getState().draft).toEqual({ ...saved, step: 'express' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('keeps advanced setup and its draft when returning from Settings', async () => {
    const saved = storedDraft();
    useMissionSetupStore.setState({ workspacePath: workspace.path, draft: saved });
    const host = mount();
    await act(async () => undefined);

    click(host, 'Configuração avançada');
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'mission-setup' });
    expect(host.querySelector('.mission-setup')?.getAttribute('data-step')).toBe('team');
    act(() => useProductNavigationStore.getState().openSettings('providers'));
    click(host, 'Voltar');
    await act(async () => undefined);

    expect(host.querySelector('.mission-setup')?.getAttribute('data-step')).toBe('team');
    expect(useMissionSetupStore.getState().draft).toEqual(saved);
  });

  it('keeps the same objective when provider settings returns to the home form', async () => {
    const saved = storedDraft();
    useMissionSetupStore.setState({ workspacePath: workspace.path, draft: saved });
    const host = mount();
    await act(async () => undefined);

    click(host, 'Conectar IA');
    click(host, 'Voltar');
    await act(async () => undefined);

    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'launcher' });
    expect(useMissionSetupStore.getState().draft).toEqual({ ...saved, step: 'express' });
    expect(host.querySelector('output')?.textContent).toBe(saved.objective);
  });
});
