import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type {
  WorkspaceInfo,
  WorkspaceLivenessEvent,
  WorkspaceState,
} from '../../shared/workspace-types';
import { setActiveWorkspacePath } from './active-workspace';
import {
  abandonWorkspaceLayoutAfterMainSwitch,
  detachWorkspaceLayout,
  hasAttachedWorkspaceLayout,
  prepareWorkspaceLayoutSwitch,
  switchWorkspaceLayout,
} from './layout-store';
import {
  disposeWorkspaceHosts,
  parkWorkspaceHosts,
} from '../terminal/terminal-host';

/**
 * Renderer mirror of the workspace onboarding state (current + recents). The
 * app gates on `current`: no workspace → launch screen; a workspace → the
 * terminal/mission surface rooted at that folder.
 */

interface WorkspaceStore {
  current: WorkspaceInfo | null;
  recents: WorkspaceInfo[];
  hydrated: boolean;
  /**
   * A pasta do workspace corrente sumiu do disco (worktree removido por fora
   * com o app aberto). O workspace continua aberto — panes vivos seguem —,
   * mas panes novos não nascem ali; rail e cabeçalho precisam dizer isso.
   */
  currentMissing: boolean;

  hydrate(): Promise<void>;
  receive(state: WorkspaceState): void;
  receiveLiveness(event: WorkspaceLivenessEvent): void;
  pick(): Promise<void>;
  open(path: string): Promise<void>;
  close(): Promise<void>;
  remove(path: string): Promise<void>;
}

type WorkspaceSet = (
  partial:
    | Partial<WorkspaceStore>
    | ((previous: WorkspaceStore) => Partial<WorkspaceStore>),
) => void;
type WorkspaceGet = () => WorkspaceStore;

function apply(set: WorkspaceSet, state: WorkspaceState): void {
  setActiveWorkspacePath(state.current?.path ?? null);
  set((previous) => ({
    current: state.current,
    recents: state.recents,
    // O aviso de pasta sumida pertence a UM caminho: trocar de workspace o
    // limpa; mexer só nos recentes o preserva.
    currentMissing:
      previous.current?.path === state.current?.path
        ? previous.currentMissing
        : false,
  }));
}

function workspacePath(state: WorkspaceState): string | null {
  return state.current?.path ?? null;
}

/*
 * Workspace mutations are serialized because each one changes the
 * renderer-scoped Main authority. This queue also prevents two rapid recent
 * clicks from interleaving canonical responses and layout loads.
 */
let transitionTail: Promise<void> = Promise.resolve();
let pendingRendererMutations = 0;

function serializeTransition<T>(work: () => Promise<T>): Promise<T> {
  pendingRendererMutations += 1;
  const result = transitionTail.then(work);
  transitionTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result.finally(() => {
    pendingRendererMutations = Math.max(0, pendingRendererMutations - 1);
  });
}

async function activateCanonicalWorkspace(
  set: WorkspaceSet,
  state: WorkspaceState,
): Promise<void> {
  const path = workspacePath(state);
  // Project-scoped stores may consult this holder while the target layout is
  // hydrating, but the visible workspace mirror changes only after hydration.
  setActiveWorkspacePath(path);
  if (path) {
    await switchWorkspaceLayout(path);
  } else {
    detachWorkspaceLayout();
  }
  apply(set, state);
}

async function restoreOutgoingWorkspace(
  previousPath: string | null,
  previousLayoutPath: string | null,
): Promise<void> {
  setActiveWorkspacePath(previousPath);
  if (previousPath) {
    await switchWorkspaceLayout(previousLayoutPath ?? previousPath);
  } else {
    detachWorkspaceLayout();
  }
}

/**
 * Renderer-owned workspace changes have one strict order:
 * outgoing layout sync flush → Main authority mutation → canonical path
 * response → target layout hydration → renderer state publication.
 */
function mutateWorkspace(
  set: WorkspaceSet,
  get: WorkspaceGet,
  invoke: () => Promise<WorkspaceState>,
  shouldPrepareLayout: (currentPath: string | null) => boolean = () => true,
  outgoingPanes: 'park' | 'close' = 'close',
): Promise<void> {
  return serializeTransition(async () => {
    const previousPath = get().current?.path ?? null;
    const prepared =
      shouldPrepareLayout(previousPath) && hasAttachedWorkspaceLayout();
    // Trocar de projeto AFASTA os panes: o processo continua e o pane volta
    // intacto. Só `close` (o diálogo promete encerrar as sessões) deixa o
    // reconcile do App descartá-los.
    if (prepared && previousPath && outgoingPanes === 'park') {
      parkWorkspaceHosts(previousPath);
    }
    const previousLayoutPath = prepared ? prepareWorkspaceLayoutSwitch() : null;
    let state: WorkspaceState;
    try {
      state = await invoke();
    } catch (cause) {
      if (prepared) {
        await restoreOutgoingWorkspace(previousPath, previousLayoutPath).catch(
          (restoreCause) => {
            console.warn(
              '[workspace] failed to restore outgoing layout:',
              restoreCause,
            );
          },
        );
      }
      throw cause;
    }

    const nextPath = workspacePath(state);
    if (!prepared && nextPath === previousPath) {
      // Removing another recent workspace only changes list metadata. It must
      // not interrupt or rehydrate the active pane tree.
      apply(set, state);
      return;
    }
    if (!prepared) {
      // Defensive fallback for a surprising Main response. Its old authority
      // is already gone, so cancel stale persistence instead of writing under
      // the wrong scope.
      abandonWorkspaceLayoutAfterMainSwitch();
    }

    try {
      await activateCanonicalWorkspace(set, state);
    } catch (cause) {
      // Main has already committed this canonical state. Keep the renderer's
      // workspace mirror aligned even when layout I/O fails; switchWorkspaceLayout
      // detaches persistence on failure so old panes cannot leak into it.
      apply(set, state);
      throw cause;
    }
  });
}

function receiveMainState(
  set: WorkspaceSet,
  get: WorkspaceGet,
  state: WorkspaceState,
): void {
  // Renderer-owned IPC handlers broadcast before returning the same state.
  // Their direct response owns the ordered transition and will apply it.
  if (pendingRendererMutations > 0) return;

  if (workspacePath(state) === (get().current?.path ?? null)) {
    apply(set, state);
    return;
  }

  // An unsolicited Main-owned change cannot flush the old layout because Main
  // has already revoked its scope. Adopt it without issuing a stale save.
  void serializeTransition(async () => {
    abandonWorkspaceLayoutAfterMainSwitch();
    try {
      await activateCanonicalWorkspace(set, state);
    } catch (cause) {
      apply(set, state);
      console.warn('[workspace] failed to adopt main workspace state:', cause);
    }
  });
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  current: null,
  recents: [],
  hydrated: false,
  currentMissing: false,

  hydrate: async () => {
    try {
      await mutateWorkspace(set, get, () => window.nexus.workspace.get());
    } catch (err) {
      console.warn('[workspace] hydrate failed:', err);
    } finally {
      set({ hydrated: true });
    }
  },

  receive: (state) => receiveMainState(set, get, state),

  receiveLiveness: (event) => {
    if (get().current?.path !== event.path) return;
    set({ currentMissing: event.missing });
  },

  pick: async () =>
    mutateWorkspace(
      set,
      get,
      () => window.nexus.workspace.pick(),
      () => true,
      'park',
    ),
  open: async (path) =>
    mutateWorkspace(
      set,
      get,
      () => window.nexus.workspace.open(path),
      () => true,
      'park',
    ),
  close: async () =>
    mutateWorkspace(set, get, () => window.nexus.workspace.close()),
  remove: async (path) => {
    await mutateWorkspace(
      set,
      get,
      () => window.nexus.workspace.remove(path),
      (currentPath) => currentPath === path,
    );
    // Tirar o projeto da lista é fechamento explícito: o que estava
    // estacionado dele morre aqui, nunca calado numa troca.
    disposeWorkspaceHosts(path);
  },
}));

/**
 * Boot hook: hydrate once and follow main-process broadcasts. `onLiveness`
 * recebe o sumiço/volta da pasta corrente DEPOIS de a store refletir — é o
 * gancho da UI (toast com saída), que não mora numa store.
 */
export function useWorkspaceController(
  onLiveness?: (event: WorkspaceLivenessEvent) => void,
): void {
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  const onLivenessRef = useRef(onLiveness);
  onLivenessRef.current = onLiveness;
  useEffect(() => {
    void hydrate();
    const offChanged = window.nexus.workspace.onChanged((state) =>
      useWorkspaceStore.getState().receive(state),
    );
    const offLiveness = window.nexus.workspace.onLiveness((event) => {
      const store = useWorkspaceStore.getState();
      if (store.current?.path !== event.path) return;
      store.receiveLiveness(event);
      onLivenessRef.current?.(event);
    });
    return () => {
      offChanged();
      offLiveness();
    };
  }, [hydrate]);
}
