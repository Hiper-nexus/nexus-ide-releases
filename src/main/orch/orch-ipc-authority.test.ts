import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import type { ProjectExecutionScope } from '../../shared/types';

interface TestOwner {
  id: number;
  isDestroyed(): boolean;
  isCrashed(): boolean;
  destroy(): void;
  crash(): void;
}

const harness = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const scopes = new Map<number, ProjectExecutionScope>();
  const windows = new Map<number, { isDestroyed(): boolean }>();
  return {
    handlers,
    scopes,
    windows,
    dialog: {
      showMessageBox: vi.fn(
        async (_window: unknown, _options: Record<string, unknown>) => ({ response: 1 }),
      ),
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
    },
    BrowserWindow: {
      fromWebContents: vi.fn((owner: { id: number }) => windows.get(owner.id) ?? null),
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      on: vi.fn(),
    },
    writeAgentSpec: vi.fn(() => ({ ok: true, path: '/home/user/.claude/agents/reviewer.md' })),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: harness.BrowserWindow,
  dialog: harness.dialog,
  ipcMain: harness.ipcMain,
}));

vi.mock('../persistence/renderer-workspace-scope', () => ({
  requireLiveRendererWorkspaceScope: (
    owner: TestOwner,
    expected?: ProjectExecutionScope,
  ) => {
    if (owner.isDestroyed() || owner.isCrashed()) {
      throw new Error('renderer is unavailable');
    }
    const current = harness.scopes.get(owner.id);
    if (!current) throw new Error('renderer has no authorized workspace scope');
    if (
      expected &&
      (current.installationId !== expected.installationId ||
        current.projectId !== expected.projectId ||
        current.checkoutId !== expected.checkoutId ||
        current.rootRealPath !== expected.rootRealPath)
    ) {
      throw new Error('renderer workspace authority changed');
    }
    return current;
  },
  requireRendererWorkspaceScope: (owner: { id: number }) => {
    const current = harness.scopes.get(owner.id);
    if (!current) throw new Error('renderer has no authorized workspace scope');
    return current;
  },
}));

vi.mock('../persistence/db', () => ({ getDb: vi.fn() }));
vi.mock('./squad-store', () => ({
  deleteSquad: vi.fn(),
  exportSquadsJson: vi.fn(),
  importSquadsJson: vi.fn(),
  initSquadStore: vi.fn(),
  listSquads: vi.fn(() => []),
  onSquadsChange: vi.fn(),
  saveSquad: vi.fn(),
}));
vi.mock('./squad-architect', () => ({
  designSquadForWorkspace: vi.fn(),
  designSquadFromIntent: vi.fn(),
}));
vi.mock('./harness-enrich', () => ({
  loadEnrichedCatalog: vi.fn(),
  runHarnessEnrichWithBrain: vi.fn(),
}));
vi.mock('./pane-registry', () => ({
  initPaneRegistry: vi.fn(),
  registerOrchRenderer: vi.fn(),
  resolveBrowserOpen: vi.fn(),
  resolveMissionPaneRecovery: vi.fn(),
  resolvePaneSpawn: vi.fn(),
  syncPanes: vi.fn(),
  unregisterOrchRenderer: vi.fn(),
}));
vi.mock('./renderer-mission-authority', () => ({
  RendererMissionAuthority: class {},
}));
vi.mock('./project-domain-store-registry', () => ({
  ProjectDomainStoreRegistry: class {},
  configureProjectDomainStoreRegistry: vi.fn(),
  disposeProjectDomainStoreRegistry: vi.fn(),
}));
vi.mock('./project-scoped-broadcast', () => ({ broadcastToProject: vi.fn() }));
vi.mock('./idle-delivery', () => ({ initIdleDelivery: vi.fn() }));
vi.mock('./stall-watchdog', () => ({
  initStallWatchdog: vi.fn(),
  shutdownStallWatchdog: vi.fn(),
}));
vi.mock('./preview-server', () => ({ stopAllPreviews: vi.fn() }));
vi.mock('../remote/remote-bridge', () => ({ stopRemoteBridge: vi.fn() }));
vi.mock('./recipe-overlay', () => ({ buildRecipeOverlay: vi.fn() }));
vi.mock('./catalog-overlay', () => ({
  proposeRecipes: vi.fn(),
  saveCatalogOverlay: vi.fn(),
}));
vi.mock('./agent-spec-writer', () => ({ writeAgentSpec: harness.writeAgentSpec }));
vi.mock('./mcp-server', () => ({
  getMcpRuntimeInfo: vi.fn(),
  getToolCatalog: vi.fn(),
  startMcpServer: vi.fn(),
  stopMcpServer: vi.fn(),
}));
vi.mock('./catalog', () => ({
  getCatalogIndex: vi.fn(),
  installCatalogItem: vi.fn(),
  listHookHomes: vi.fn(),
  listInstalledCatalogItems: vi.fn(),
  listPluginFiles: vi.fn(),
}));

import { registerOrchIpc } from './orch-ipc';

const SCOPE_A = Object.freeze({
  version: 1 as const,
  installationId: 'installation-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest' as const,
});
const SCOPE_B = Object.freeze({
  ...SCOPE_A,
  projectId: 'project-b',
  checkoutId: 'checkout-b',
  rootRealPath: '/workspace/b',
});

function owner(id = 1): TestOwner {
  let destroyed = false;
  let crashed = false;
  return {
    id,
    isDestroyed: () => destroyed,
    isCrashed: () => crashed,
    destroy: () => {
      destroyed = true;
    },
    crash: () => {
      crashed = true;
    },
  };
}

async function write(sender: ReturnType<typeof owner>, raw: unknown) {
  const handler = harness.handlers.get(ORCH_CHANNELS.agentSpecWrite);
  if (!handler) throw new Error('missing agent spec writer handler');
  return handler({ sender }, raw);
}

const AGENT_SPEC = Object.freeze({
  name: 'release-reviewer',
  tools: ['Read', 'Grep'],
  model: 'sonnet',
  systemPrompt: 'private operating instructions',
});

beforeEach(() => {
  harness.handlers.clear();
  harness.scopes.clear();
  harness.windows.clear();
  vi.clearAllMocks();
  harness.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  harness.writeAgentSpec.mockReturnValue({
    ok: true,
    path: '/home/user/.claude/agents/release-reviewer.md',
  });
  registerOrchIpc();
});

describe('agent spec renderer authority', () => {
  it('rejects missing, destroyed, and crashed renderer authority', async () => {
    const missing = owner();
    await expect(write(missing, AGENT_SPEC)).rejects.toThrow(
      /no authorized workspace scope/i,
    );

    harness.scopes.set(missing.id, SCOPE_A);
    missing.destroy();
    await expect(write(missing, AGENT_SPEC)).rejects.toThrow(
      /renderer is unavailable/i,
    );
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(harness.writeAgentSpec).not.toHaveBeenCalled();
  });

  it('requires a main-owned confirmation for every write invocation', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });

    await write(sender, AGENT_SPEC);
    await write(sender, AGENT_SPEC);

    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(harness.writeAgentSpec).toHaveBeenCalledTimes(2);
    const confirmation = harness.dialog.showMessageBox.mock.calls[0]![1];
    expect(confirmation).toMatchObject({ defaultId: 0, cancelId: 0, noLink: true });
    expect(confirmation.detail).toContain(SCOPE_A.rootRealPath);
    expect(confirmation.detail).toContain(AGENT_SPEC.name);
    expect(confirmation.detail).not.toContain(AGENT_SPEC.systemPrompt);
  });

  it('does not write when the user denies the exact invocation', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await expect(write(sender, AGENT_SPEC)).resolves.toEqual({
      ok: false,
      error: 'user_denied',
    });
    expect(harness.writeAgentSpec).not.toHaveBeenCalled();
  });

  it('invalidates approval if the renderer changes project during confirmation', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.dialog.showMessageBox.mockImplementationOnce(async () => {
      harness.scopes.set(sender.id, SCOPE_B);
      return { response: 1 };
    });

    await expect(
      write(sender, { ...AGENT_SPEC, scope: SCOPE_B }),
    ).rejects.toThrow(/workspace authority changed/i);
    expect(harness.writeAgentSpec).not.toHaveBeenCalled();
  });

  it('invalidates approval if the renderer dies during confirmation', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.dialog.showMessageBox.mockImplementationOnce(async () => {
      sender.crash();
      return { response: 1 };
    });

    await expect(write(sender, AGENT_SPEC)).rejects.toThrow(
      /renderer is unavailable/i,
    );
    expect(harness.writeAgentSpec).not.toHaveBeenCalled();
  });
});
