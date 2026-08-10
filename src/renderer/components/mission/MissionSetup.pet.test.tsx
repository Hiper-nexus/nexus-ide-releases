/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  MissionReview,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import { PET_STUDIO_SQUAD } from '../../../shared/pet-studio';
import { DEFAULT_ORCH_SETTINGS } from '../../../shared/settings-types';
import { useMissionSetupStore } from '../../state/mission-setup-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { MissionSetup } from './MissionSetup';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface PetEntryContext {
  kind: 'pet-studio';
  origin: 'settings-appearance';
  objective: string;
  title: string;
  roster: typeof PET_STUDIO_SQUAD.agents;
  profile: {
    kind: 'pet-studio';
    referenceImagePath: string;
  };
  step: 'review';
  revision: number;
}

const workspace = {
  path: '/workspace',
  name: 'workspace',
  lastOpenedAt: 1,
};
const otherWorkspace = {
  path: '/workspace-other',
  name: 'workspace-other',
  lastOpenedAt: 2,
};
const imagePath =
  '/workspace/.nexus/attachments/pet-studio/cat-source.png';
const imageSha256 = 'd'.repeat(64);
const petContext: PetEntryContext = {
  kind: 'pet-studio',
  origin: 'settings-appearance',
  objective: 'Carregue nexus-pet-studio e crie o pacote completo deste pet.',
  title: 'Criar pet cat-source',
  roster: PET_STUDIO_SQUAD.agents,
  profile: {
    kind: 'pet-studio',
    referenceImagePath: imagePath,
  },
  step: 'review',
  revision: 7,
};
const petReview = {
  missionId: 'mission-pet-reviewed',
  title: petContext.title,
  objective: petContext.objective,
  workspaceLabel: 'workspace',
  contextPaths: [],
  roster: PET_STUDIO_SQUAD.agents,
  attachments: [
    {
      path: imagePath,
      sha256: imageSha256,
      size: 4_096,
    },
  ],
  permissions: [
    {
      id: 'pet-image-generation',
      label: 'Gerar as imagens deste pet',
      detail: 'Somente na sessão Codex revisada.',
    },
  ],
  warnings: ['Sessão única, sem delegação ou workers.'],
  reviewSha256: 'e'.repeat(64),
  createdAt: 1_786_000_000_000,
} as unknown as MissionReview;
const snapshot: MissionSnapshot = {
  id: 'mission-pet-running',
  title: petReview.title,
  objective: petReview.objective,
  workspaceLabel: petReview.workspaceLabel,
  state: 'running',
  progress: { completed: 0, total: 1 },
  agents: [],
  edges: [],
  units: [],
  allowedActions: ['direct', 'stop'],
  version: 1,
  updatedAt: petReview.createdAt + 1,
};

const api = {
  prepare: vi.fn(async () => petReview),
  start: vi.fn(async () => snapshot),
};

const mountedRoots = new Set<Root>();
const initialWorkspaceState = useWorkspaceStore.getState();

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function renderMissionSetup(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.add(root);
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

function currentPetContext(): unknown {
  const state: unknown = useMissionSetupStore.getState();
  if (!state || typeof state !== 'object' || !('entryContext' in state)) {
    return null;
  }
  return state.entryContext;
}

function seedPetContext(): void {
  useMissionSetupStore.setState({
    workspacePath: workspace.path,
    draft: {
      objective: petContext.objective,
      title: petContext.title,
      contextPaths: [],
      roster: PET_STUDIO_SQUAD.agents.map((agent) => ({ ...agent })),
      advanced: { lane: 'standard' },
      step: 'review',
      revision: petContext.revision,
    },
    persistence: { status: 'idle' },
    workspaceDrafts: {},
    entryContext: structuredClone(petContext),
  } as never);
  useProductNavigationStore.setState({
    destination: { kind: 'mission-setup' },
    settingsReturnDestination: { kind: 'terminal' },
  });
}

beforeEach(() => {
  localStorage.clear();
  api.prepare.mockReset();
  api.prepare.mockResolvedValue(petReview);
  api.start.mockReset();
  api.start.mockResolvedValue(snapshot);
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      adapters: { list: vi.fn(async () => []) },
      providers: { list: vi.fn(async () => []) },
      accounts: { list: vi.fn(async () => []) },
      settings: { orchGet: vi.fn(async () => DEFAULT_ORCH_SETTINGS) },
      mission: { prepare: api.prepare, start: api.start },
    } as unknown as Window['nexus'],
  });
  useWorkspaceStore.setState({
    ...initialWorkspaceState,
    current: workspace,
    recents: [workspace],
    hydrated: true,
  });
  seedPetContext();
});

afterEach(() => {
  for (const root of mountedRoots) {
    act(() => root.unmount());
  }
  mountedRoots.clear();
  document.body.replaceChildren();
  delete (window as { nexus?: unknown }).nexus;
});

describe('Mission Setup — ephemeral Pet Review', () => {
  it('prepares the exact profile and renders the governed image before any start', async () => {
    const host = renderMissionSetup();
    await flush();

    expect(api.prepare).toHaveBeenCalledWith({
      objective: petContext.objective,
      title: petContext.title,
      contextPaths: [],
      roster: PET_STUDIO_SQUAD.agents,
      advanced: { lane: 'standard' },
      profile: petContext.profile,
    });
    expect(api.start).not.toHaveBeenCalled();
    expect(host.textContent).toContain('cat-source.png');
    expect(host.textContent).toContain(imageSha256);
    expect(host.textContent).toContain('4096');
    expect(host.textContent).toContain('Pet Maker');
    expect(host.textContent).toContain('nexus-pet-studio');
    expect(host.textContent).not.toContain('Voltar para equipe');
    expect(button(host, /iniciar missão/i).disabled).toBe(false);
  });

  it('cancels to Appearance, clears Pet authority, and retains Terminal for Settings Back', async () => {
    const host = renderMissionSetup();
    await flush();

    act(() => button(host, /cancelar|voltar para aparência/i).click());

    expect(api.start).not.toHaveBeenCalled();
    expect(currentPetContext()).toBeNull();
    expect(useProductNavigationStore.getState()).toMatchObject({
      destination: { kind: 'settings', section: 'appearance' },
      settingsReturnDestination: { kind: 'terminal' },
    });
    useProductNavigationStore.getState().backFromSettings();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'terminal',
    });
  });

  it('ignores a late prepare result after Pet Review is cancelled', async () => {
    const pending = deferred<MissionReview>();
    api.prepare.mockReturnValueOnce(pending.promise);
    const host = renderMissionSetup();
    await flush();

    act(() => button(host, /cancelar|voltar para aparência/i).click());
    await act(async () => {
      pending.resolve(petReview);
      await pending.promise;
    });

    expect(currentPetContext()).toBeNull();
    expect(host.textContent).not.toContain(imageSha256);
    expect(api.start).not.toHaveBeenCalled();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'settings',
      section: 'appearance',
    });
  });

  it('clears Pet authority on workspace replacement and cannot resurrect it from late prepare', async () => {
    const pending = deferred<MissionReview>();
    api.prepare.mockReturnValueOnce(pending.promise);
    const host = renderMissionSetup();
    await flush();

    act(() => useWorkspaceStore.setState({ current: otherWorkspace }));
    await flush();
    await act(async () => {
      pending.resolve(petReview);
      await pending.promise;
    });

    expect(currentPetContext()).toBeNull();
    expect(host.textContent).not.toContain(imageSha256);
    expect(api.start).not.toHaveBeenCalled();
  });

  it('clears the ephemeral profile before opening the successful mission on Board', async () => {
    const host = renderMissionSetup();
    await flush();

    act(() => button(host, /iniciar missão/i).click());
    await flush();

    expect(api.start).toHaveBeenCalledWith({
      missionId: petReview.missionId,
      reviewSha256: petReview.reviewSha256,
    });
    expect(currentPetContext()).toBeNull();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: snapshot.id,
      surface: 'board',
    });
  });
});
