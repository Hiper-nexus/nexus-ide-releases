import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceInfo,
  WorkspaceState,
} from '../../shared/workspace-types';
import {
  getActiveWorkspacePath,
  setActiveWorkspacePath,
} from './active-workspace';

const layout = vi.hoisted(() => ({
  abandon: vi.fn(),
  detach: vi.fn(),
  hasAttached: vi.fn(() => true),
  prepare: vi.fn(() => null as string | null),
  switch: vi.fn(async (_path: string) => true),
}));

vi.mock('./layout-store', () => ({
  abandonWorkspaceLayoutAfterMainSwitch: layout.abandon,
  detachWorkspaceLayout: layout.detach,
  hasAttachedWorkspaceLayout: layout.hasAttached,
  prepareWorkspaceLayoutSwitch: layout.prepare,
  switchWorkspaceLayout: layout.switch,
}));

import { useWorkspaceStore } from './workspace-store';

function info(path: string, lastOpenedAt = 1): WorkspaceInfo {
  return {
    path,
    name: path.split('/').filter(Boolean).at(-1) ?? path,
    lastOpenedAt,
  };
}

function state(
  currentPath: string | null,
  recents = currentPath ? [info(currentPath)] : [],
): WorkspaceState {
  return {
    current: currentPath ? info(currentPath) : null,
    recents,
  };
}

function installWorkspaceApi(
  overrides: Partial<{
    get(): Promise<WorkspaceState>;
    pick(): Promise<WorkspaceState>;
    open(path: string): Promise<WorkspaceState>;
    close(): Promise<WorkspaceState>;
    remove(path: string): Promise<WorkspaceState>;
  }> = {},
) {
  const api = {
    get: vi.fn(async () => state(null)),
    pick: vi.fn(async () => state(null)),
    open: vi.fn(async (_path: string) => state(null)),
    close: vi.fn(async () => state(null)),
    remove: vi.fn(async (_path: string) => state(null)),
    onChanged: vi.fn(() => () => {}),
    ...overrides,
  };
  vi.stubGlobal('window', { nexus: { workspace: api } });
  return api;
}

describe('workspace-store layout authority transitions', () => {
  beforeEach(() => {
    layout.abandon.mockReset();
    layout.detach.mockReset();
    layout.hasAttached.mockReset();
    layout.hasAttached.mockReturnValue(true);
    layout.prepare.mockReset();
    layout.prepare.mockReturnValue(null);
    layout.switch.mockReset();
    layout.switch.mockResolvedValue(true);
    useWorkspaceStore.setState({
      current: null,
      recents: [],
      hydrated: false,
    });
    setActiveWorkspacePath(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('flushes the old layout before Main and publishes only after the canonical layout loads', async () => {
    const events: string[] = [];
    const oldPath = '/workspace/old';
    const requestedPath = '/tmp/new';
    const canonicalPath = '/private/tmp/new';
    let releaseLayout!: () => void;
    const layoutReady = new Promise<void>((resolve) => {
      releaseLayout = resolve;
    });

    useWorkspaceStore.setState({
      current: info(oldPath),
      recents: [info(oldPath)],
      hydrated: true,
    });
    setActiveWorkspacePath(oldPath);
    layout.prepare.mockImplementation(() => {
      events.push('flush:old');
      return oldPath;
    });
    layout.switch.mockImplementation(async (path) => {
      events.push(`layout:${path}`);
      await layoutReady;
      return true;
    });
    installWorkspaceApi({
      open: vi.fn(async (path) => {
        events.push(`main:${path}`);
        const next = state(canonicalPath, [
          info(canonicalPath, 2),
          info(oldPath),
        ]);
        // Main broadcasts synchronously before the matching IPC response.
        useWorkspaceStore.getState().receive(next);
        return next;
      }),
    });

    const opening = useWorkspaceStore.getState().open(requestedPath);
    await vi.waitFor(() => {
      expect(events).toEqual([
        'flush:old',
        `main:${requestedPath}`,
        `layout:${canonicalPath}`,
      ]);
    });

    expect(useWorkspaceStore.getState().current?.path).toBe(oldPath);
    expect(getActiveWorkspacePath()).toBe(canonicalPath);

    releaseLayout();
    await opening;

    expect(useWorkspaceStore.getState().current?.path).toBe(canonicalPath);
    expect(
      useWorkspaceStore.getState().recents.map((item) => item.path),
    ).toEqual([canonicalPath, oldPath]);
  });

  it('restores the outgoing layout when Main rejects the workspace', async () => {
    const oldPath = '/workspace/old';
    const denied = new Error('workspace path was not authorized');
    useWorkspaceStore.setState({
      current: info(oldPath),
      recents: [info(oldPath)],
      hydrated: true,
    });
    setActiveWorkspacePath(oldPath);
    layout.prepare.mockReturnValue(oldPath);
    const api = installWorkspaceApi({
      open: vi.fn(async () => {
        throw denied;
      }),
    });

    await expect(
      useWorkspaceStore.getState().open('/workspace/denied'),
    ).rejects.toBe(denied);

    expect(api.open).toHaveBeenCalledWith('/workspace/denied');
    expect(layout.prepare).toHaveBeenCalledOnce();
    expect(layout.switch).toHaveBeenCalledWith(oldPath);
    expect(useWorkspaceStore.getState().current?.path).toBe(oldPath);
    expect(getActiveWorkspacePath()).toBe(oldPath);
  });

  it('hydrates the canonical layout before declaring workspace boot complete', async () => {
    const canonicalPath = '/workspace/canonical';
    let releaseLayout!: () => void;
    const layoutReady = new Promise<void>((resolve) => {
      releaseLayout = resolve;
    });
    installWorkspaceApi({
      get: vi.fn(async () => state(canonicalPath)),
    });
    layout.switch.mockImplementation(async () => {
      await layoutReady;
      return false;
    });

    const hydrating = useWorkspaceStore.getState().hydrate();
    await vi.waitFor(() =>
      expect(layout.switch).toHaveBeenCalledWith(canonicalPath),
    );

    expect(useWorkspaceStore.getState().current).toBeNull();
    expect(useWorkspaceStore.getState().hydrated).toBe(false);

    releaseLayout();
    await hydrating;

    expect(useWorkspaceStore.getState().current?.path).toBe(canonicalPath);
    expect(useWorkspaceStore.getState().hydrated).toBe(true);
  });

  it('does not interrupt the active layout when removing a different recent', async () => {
    const currentPath = '/workspace/current';
    const removedPath = '/workspace/old';
    useWorkspaceStore.setState({
      current: info(currentPath),
      recents: [info(currentPath), info(removedPath)],
      hydrated: true,
    });
    setActiveWorkspacePath(currentPath);
    const api = installWorkspaceApi({
      remove: vi.fn(async () => state(currentPath, [info(currentPath)])),
    });

    await useWorkspaceStore.getState().remove(removedPath);

    expect(api.remove).toHaveBeenCalledWith(removedPath);
    expect(layout.prepare).not.toHaveBeenCalled();
    expect(layout.switch).not.toHaveBeenCalled();
    expect(layout.detach).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().recents).toEqual([info(currentPath)]);
  });

  it('flushes before close and detaches before publishing the launcher state', async () => {
    const events: string[] = [];
    const currentPath = '/workspace/current';
    useWorkspaceStore.setState({
      current: info(currentPath),
      recents: [info(currentPath)],
      hydrated: true,
    });
    setActiveWorkspacePath(currentPath);
    layout.prepare.mockImplementation(() => {
      events.push('flush');
      return currentPath;
    });
    layout.detach.mockImplementation(() => {
      events.push('detach');
    });
    installWorkspaceApi({
      close: vi.fn(async () => {
        events.push('main:close');
        return state(null, [info(currentPath)]);
      }),
    });

    await useWorkspaceStore.getState().close();

    expect(events).toEqual(['flush', 'main:close', 'detach']);
    expect(useWorkspaceStore.getState().current).toBeNull();
    expect(getActiveWorkspacePath()).toBeNull();
  });

  it('adopts an unsolicited Main workspace state without stale outgoing writes', async () => {
    const oldPath = '/workspace/old';
    const nextPath = '/workspace/main-owned';
    useWorkspaceStore.setState({
      current: info(oldPath),
      recents: [info(oldPath)],
      hydrated: true,
    });
    setActiveWorkspacePath(oldPath);
    installWorkspaceApi();

    useWorkspaceStore.getState().receive(state(nextPath));

    await vi.waitFor(() =>
      expect(useWorkspaceStore.getState().current?.path).toBe(nextPath),
    );
    expect(layout.prepare).not.toHaveBeenCalled();
    expect(layout.abandon).toHaveBeenCalledOnce();
    expect(layout.switch).toHaveBeenCalledWith(nextPath);
  });
});
