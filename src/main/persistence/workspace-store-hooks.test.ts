import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_CHANNELS } from '../../shared/workspace-types';

/**
 * O hook de handoff legado dentro de um repo só sai do disco se o limpador
 * souber QUAL pasta abrir. O boot do main limpa o $HOME e o `process.cwd()`
 * — que num app empacotado é "/" —, então o registro de cada workspace é
 * responsabilidade do store: boot (current + recents) e cada abertura.
 */

const home = vi.hoisted(() => ({ dir: '' }));

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ws-hooks-'));
home.dir = path.join(root, 'home');
const workspaceA = path.join(root, 'repos', 'alfa');
const workspaceB = path.join(root, 'repos', 'beta');
/** Pasta com o MESMO estrago que ninguém registrou. */
const decoy = path.join(root, 'repos', 'gama');

const codexHooks = (dir: string) => path.join(dir, '.codex', 'hooks.json');
const agentsHooks = (dir: string) => path.join(dir, '.agents', 'hooks.json');

/** hooks.json com o comando morto do Overclock (o app não existe no disco). */
function writeDeadCodexHooks(dir: string): void {
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  fs.writeFileSync(
    codexHooks(dir),
    JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write|apply_patch',
            hooks: [
              {
                type: 'command',
                command: path.join(home.dir, '.overclock-app', 'soft-status.mjs'),
                timeout: 5,
              },
            ],
          },
        ],
      },
    }),
  );
}

describe('workspace-store limpa os hooks legados por workspace', () => {
  beforeAll(() => {
    for (const dir of [workspaceA, workspaceB, decoy]) {
      fs.mkdirSync(dir, { recursive: true });
      writeDeadCodexHooks(dir);
    }
    fs.mkdirSync(path.join(workspaceB, '.agents'), { recursive: true });
    fs.writeFileSync(
      agentsHooks(workspaceB),
      JSON.stringify({
        'overclock-soft-status': {
          enabled: true,
          Stop: [
            {
              type: 'command',
              command: path.join(home.dir, '.overclock-app', 'soft-status.mjs'),
            },
          ],
        },
      }),
    );
    fs.mkdirSync(path.join(home.dir, '.nexus'), { recursive: true });
    fs.writeFileSync(
      path.join(home.dir, '.nexus', 'workspaces.json'),
      JSON.stringify({
        current: { path: workspaceA, name: 'alfa', lastOpenedAt: 2 },
        recents: [
          { path: workspaceB, name: 'beta', lastOpenedAt: 1 },
          { path: workspaceA, name: 'alfa', lastOpenedAt: 2 },
        ],
      }),
    );
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('no boot limpa current e recents, e só eles', async () => {
    const store = await import('./workspace-store');
    store.registerWorkspaceIpc();

    expect(store.getWorkspaceState().current?.path).toBe(
      fs.realpathSync(workspaceA),
    );
    expect(fs.existsSync(codexHooks(workspaceA))).toBe(false);
    expect(fs.existsSync(codexHooks(workspaceB))).toBe(false);
    expect(fs.existsSync(agentsHooks(workspaceB))).toBe(false);
    // Argumento do boot do main não manda aqui: o decoy não está registrado.
    expect(fs.existsSync(codexHooks(decoy))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), '.codex', 'hooks.json'))).toBe(
      false,
    );
  });

  it('ao abrir um workspace, limpa o repo que o operador escolheu', async () => {
    const { ipcMain } = await import('electron');
    const store = await import('./workspace-store');
    // O registry é por arquivo: registrar de novo é o boot idempotente e
    // devolve os handlers deste teste (os mocks são limpos entre testes).
    store.registerWorkspaceIpc();
    const calls = vi.mocked(ipcMain.handle).mock.calls;
    const openHandler = calls.find(
      ([channel]) => channel === WORKSPACE_CHANNELS.open,
    )?.[1] as (event: unknown, raw: unknown) => unknown;
    expect(openHandler).toBeTypeOf('function');

    const sender = { isDestroyed: () => false, send: vi.fn() } as never;
    // Caminho novo exige o grant de uma pasta escolhida pelo operador.
    expect(store.grantWorkspacePathFromTrustedMain(sender, decoy)).toBe(
      fs.realpathSync(decoy),
    );
    openHandler({ sender }, { path: decoy });

    expect(store.getWorkspaceState().current?.path).toBe(fs.realpathSync(decoy));
    expect(fs.existsSync(codexHooks(decoy))).toBe(false);

    // Reabrir o mesmo repo não repete nada (idempotente).
    expect(fs.existsSync(codexHooks(workspaceA))).toBe(false);
  });
});
