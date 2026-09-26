import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_CHANNELS } from '../../shared/workspace-types';

/**
 * F-570: provider-state/<adapter>/<checkoutId> is durable and never cleaned
 * up on its own. When a workspace is removed from the recents registry, the
 * checkout it resolves to must have its provider-state purged — but only
 * that checkout, and only best-effort (a resolution failure never blocks the
 * removal itself).
 */

const home = vi.hoisted(() => ({ dir: '' }));
const userData = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  const homedir = () => home.dir || actual.homedir();
  return { ...actual, default: { ...actual, homedir }, homedir };
});

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: () => userData.dir },
}));

vi.mock('./renderer-workspace-scope', () => ({
  bindRendererWorkspaceScope: vi.fn(),
  clearRendererWorkspaceScope: vi.fn(),
  forgetRendererWorkspace: vi.fn(),
}));

vi.mock('../context/orientation/orientation-bootstrap', () => ({
  scheduleOrientationForWorkspace: vi.fn(),
  stopOrientationForWorkspace: vi.fn(),
}));

const checkoutIdByPath = vi.hoisted(() => new Map<string, string>());

vi.mock('./project-identity', () => ({
  resolveProjectExecutionScopeCached: (workspacePath: string) => {
    const checkoutId = checkoutIdByPath.get(workspacePath);
    if (!checkoutId) throw new Error(`no checkout registered for ${workspacePath}`);
    return { checkoutId };
  },
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ws-provider-purge-'));
home.dir = path.join(root, 'home');
userData.dir = path.join(root, 'user-data');
const workspaceA = path.join(root, 'repos', 'alfa');
const workspaceB = path.join(root, 'repos', 'beta');

function write(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function providerStateDir(adapter: string, checkoutId: string): string {
  return path.join(userData.dir, 'provider-state', adapter, checkoutId);
}

describe('workspace-store purga provider-state ao remover o workspace (F-570)', () => {
  beforeAll(() => {
    for (const dir of [workspaceA, workspaceB]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    checkoutIdByPath.set(fs.realpathSync(workspaceA), 'checkout-alfa');
    checkoutIdByPath.set(fs.realpathSync(workspaceB), 'checkout-beta');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    write(
      path.join(providerStateDir('grok', 'checkout-alfa'), 'sessions', 'x.json'),
      'alfa conversation',
    );
    write(
      path.join(providerStateDir('grok', 'checkout-beta'), 'sessions', 'y.json'),
      'beta conversation',
    );
  });

  it('removes only the removed workspace checkout, preserving the others', async () => {
    const { ipcMain } = await import('electron');
    const store = await import('./workspace-store');
    store.registerWorkspaceIpc();
    const calls = vi.mocked(ipcMain.handle).mock.calls;
    const removeHandler = calls.find(
      ([channel]) => channel === WORKSPACE_CHANNELS.remove,
    )?.[1] as (event: unknown, raw: unknown) => unknown;
    expect(removeHandler).toBeTypeOf('function');
    const sender = { isDestroyed: () => false, send: vi.fn() } as never;

    await removeHandler({ sender }, { path: fs.realpathSync(workspaceA) });

    expect(fs.existsSync(providerStateDir('grok', 'checkout-alfa'))).toBe(false);
    expect(fs.existsSync(providerStateDir('grok', 'checkout-beta'))).toBe(true);
    // Tirar da lista é fechamento explícito: o que ficou afastado do projeto
    // na troca de workspace (navegadores) encerra junto.
    const { forgetRendererWorkspace } = await import('./renderer-workspace-scope');
    expect(forgetRendererWorkspace).toHaveBeenCalledWith(
      sender,
      fs.realpathSync(workspaceA),
    );
  });

  it('still removes the workspace from the registry when the checkout cannot be resolved', async () => {
    const { ipcMain } = await import('electron');
    const store = await import('./workspace-store');
    store.registerWorkspaceIpc();
    const calls = vi.mocked(ipcMain.handle).mock.calls;
    const removeHandler = calls.find(
      ([channel]) => channel === WORKSPACE_CHANNELS.remove,
    )?.[1] as (event: unknown, raw: unknown) => unknown;
    const sender = { isDestroyed: () => false, send: vi.fn() } as never;
    const unresolvable = path.join(root, 'repos', 'never-registered');

    const result = (await removeHandler(
      { sender },
      { path: unresolvable },
    )) as { recents: Array<{ path: string }> };

    expect(result.recents.some((w) => w.path === unresolvable)).toBe(false);
    // Unrelated provider-state on disk is untouched by the failed lookup.
    expect(fs.existsSync(providerStateDir('grok', 'checkout-beta'))).toBe(true);
  });
});
