import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_CHANNELS } from '../../shared/workspace-types';

/**
 * A pasta do workspace corrente some com o app aberto (worktree removido
 * por outra ferramenta). `load()` só valida no boot; a sonda avisa o
 * renderer uma vez pelo sumiço e uma vez pela volta — sem fechar nada.
 */

const home = vi.hoisted(() => ({
  dir: '',
}));

vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  const homedir = () => home.dir || actual.homedir();
  return { ...actual, default: { ...actual, homedir }, homedir };
});

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ws-liveness-'));
home.dir = path.join(root, 'home');
const workspaceDir = path.join(root, 'worktrees', 'saasbarbearia');

describe('probeCurrentWorkspaceLiveness', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(home.dir, '.nexus'), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(home.dir, '.nexus', 'workspaces.json'),
      JSON.stringify({
        current: { path: workspaceDir, name: 'saasbarbearia', lastOpenedAt: 1 },
        recents: [{ path: workspaceDir, name: 'saasbarbearia', lastOpenedAt: 1 }],
      }),
    );
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('avisa uma vez quando a pasta some, uma vez quando volta, e nada entre elas', async () => {
    const store = await import('./workspace-store');
    store.registerWorkspaceIpc();
    const send = vi.fn();
    const wc = { isDestroyed: () => false, send } as never;
    store.registerWorkspaceListener(wc);

    const real = fs.realpathSync(workspaceDir);
    expect(store.getWorkspaceState().current?.path).toBe(real);
    expect(store.probeCurrentWorkspaceLiveness()).toBeNull();
    expect(send).not.toHaveBeenCalled();

    fs.rmSync(workspaceDir, { recursive: true, force: true });
    expect(store.probeCurrentWorkspaceLiveness()).toEqual({
      path: real,
      name: 'saasbarbearia',
      missing: true,
    });
    expect(send).toHaveBeenCalledWith(WORKSPACE_CHANNELS.liveness, {
      path: real,
      name: 'saasbarbearia',
      missing: true,
    });
    // Repetir a sonda (foco da janela, outro spawn falhando) não repete o aviso.
    expect(store.probeCurrentWorkspaceLiveness()).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    // O workspace continua aberto: decidir é do operador, não da sonda.
    expect(store.getWorkspaceState().current?.path).toBe(real);

    fs.mkdirSync(workspaceDir, { recursive: true });
    expect(store.probeCurrentWorkspaceLiveness()).toEqual({
      path: real,
      name: 'saasbarbearia',
      missing: false,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.probeCurrentWorkspaceLiveness()).toBeNull();
    store.unregisterWorkspaceListener(wc);
  });
});
