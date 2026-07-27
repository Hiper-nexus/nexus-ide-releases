import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  OMP_AUTH_CHANNELS,
  type OmpAuthPushEvent,
} from '../../shared/omp-auth-types';

/**
 * Wiring do fluxo de login omp × janela in-app de autorização: a URL do
 * `awaiting-auth` abre a janela automaticamente e o `done`/`error` a fecha —
 * regresso da "aba do browser que nunca fecha" (NEXUS-UI-BUGS-001 §3).
 */

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  return {
    handlers,
    authWindow: {
      openOmpAuthWindow: vi.fn(() => ({ ok: true })),
      closeOmpAuthWindow: vi.fn(),
      disposeOmpAuthWindow: vi.fn(),
    },
    flowEvents: { current: null as null | ((event: OmpAuthPushEvent) => void) },
    cancelFlow: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) =>
      mocks.handlers.set(channel, fn),
  },
}));

vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string) => void,
  ) => cb(null, JSON.stringify([{ id: 'anthropic', name: 'Anthropic' }])),
  spawn: vi.fn(),
}));

vi.mock('./omp-auth-window', () => ({
  ...mocks.authWindow,
  OMP_AUTH_WINDOW_CLOSE_ON_DONE_DELAY_MS: 1_500,
}));

vi.mock('./omp-auth', () => ({
  OmpLoginFlow: class {
    cancel = mocks.cancelFlow;
    constructor(
      _config: unknown,
      deps: { onEvent: (event: OmpAuthPushEvent) => void },
    ) {
      mocks.flowEvents.current = deps.onEvent;
    }
  },
  parseAuthBrokerList: (json: unknown) => json,
}));

vi.mock('./omp-rpc-service', () => ({
  resolveOmpBin: vi.fn(async () => ({ binPath: '/usr/local/bin/omp' })),
  buildOmpChildEnv: vi.fn(() => ({})),
}));

import {
  disposeAllOmpAuthFlows,
  probeOmpTokenPresence,
  registerOmpAuthIpc,
} from './omp-auth-ipc';

function fakeOwner() {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  };
}

describe('omp-auth-ipc × janela de autorização', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.flowEvents.current = null;
    disposeAllOmpAuthFlows();
    vi.clearAllMocks();
    registerOmpAuthIpc();
  });

  async function startLogin(owner: ReturnType<typeof fakeOwner>) {
    const login = mocks.handlers.get(OMP_AUTH_CHANNELS.login);
    expect(login).toBeDefined();
    const res = (await login!(
      { sender: owner } as never,
      { providerId: 'anthropic' } as never,
    )) as { ok: boolean; flowId?: string; error?: string };
    expect(res.ok).toBe(true);
    expect(mocks.flowEvents.current).not.toBeNull();
    return res;
  }

  it('awaiting-auth abre a janela in-app automaticamente', async () => {
    const owner = fakeOwner();
    await startLogin(owner);
    mocks.flowEvents.current!({
      phase: 'awaiting-auth',
      providerId: 'anthropic',
      url: 'https://auth.oh-my-pi.dev/login?flow=1',
    });
    expect(mocks.authWindow.openOmpAuthWindow).toHaveBeenCalledWith(
      'https://auth.oh-my-pi.dev/login?flow=1',
    );
    // E o evento segue para o renderer (link/estado no painel).
    expect(owner.send).toHaveBeenCalledWith(
      OMP_AUTH_CHANNELS.event,
      expect.objectContaining({
        event: expect.objectContaining({ phase: 'awaiting-auth' }),
      }),
    );
  });

  it('done fecha a janela com delay (página de sucesso perceptível)', async () => {
    const owner = fakeOwner();
    await startLogin(owner);
    mocks.flowEvents.current!({
      phase: 'awaiting-auth',
      providerId: 'anthropic',
      url: 'https://auth.oh-my-pi.dev/login?flow=1',
    });
    mocks.flowEvents.current!({ phase: 'done', providerId: 'anthropic' });
    expect(mocks.authWindow.closeOmpAuthWindow).toHaveBeenCalledWith(1_500);
  });

  it('error fecha a janela imediatamente', async () => {
    const owner = fakeOwner();
    await startLogin(owner);
    mocks.flowEvents.current!({
      phase: 'error',
      providerId: 'anthropic',
      message: 'login expirou',
    });
    expect(mocks.authWindow.closeOmpAuthWindow).toHaveBeenCalledWith(0);
  });

  it('openAuthWindow reabre com a URL guardada no main (renderer não injeta URL)', async () => {
    const owner = fakeOwner();
    await startLogin(owner);
    mocks.flowEvents.current!({
      phase: 'awaiting-auth',
      providerId: 'anthropic',
      url: 'https://auth.oh-my-pi.dev/login?flow=1',
    });
    mocks.authWindow.openOmpAuthWindow.mockClear();
    const open = mocks.handlers.get(OMP_AUTH_CHANNELS.openAuthWindow);
    expect(open).toBeDefined();
    const res = (await open!({ sender: owner } as never)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(mocks.authWindow.openOmpAuthWindow).toHaveBeenCalledWith(
      'https://auth.oh-my-pi.dev/login?flow=1',
    );
  });

  it('openAuthWindow sem fluxo/URL pendente falha fechado', async () => {
    const owner = fakeOwner();
    const open = mocks.handlers.get(OMP_AUTH_CHANNELS.openAuthWindow);
    const res = (await open!({ sender: owner } as never)) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(mocks.authWindow.openOmpAuthWindow).not.toHaveBeenCalled();
  });

  it('dispose encerra fluxos e a janela', async () => {
    const owner = fakeOwner();
    await startLogin(owner);
    disposeAllOmpAuthFlows();
    expect(mocks.cancelFlow).toHaveBeenCalled();
    expect(mocks.authWindow.disposeOmpAuthWindow).toHaveBeenCalled();
  });

  it('limita a sonda de token sem capturar stdout nem deixar processo pendurado', async () => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
    };
    child.kill = vi.fn(() => true);
    const result = await probeOmpTokenPresence('/fake/omp', 'anthropic', {
      spawnImpl: vi.fn(() => child) as never,
      timeoutMs: 10,
    });
    expect(result).toBe(false);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
