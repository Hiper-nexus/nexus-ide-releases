import { describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../../shared/channels';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { mainHeartbeatReply, registerMainHeartbeatIpc } from './main-heartbeat-ipc';

describe('app:heartbeat (F-764 C.7)', () => {
  it('responde só o relógio, sem tocar em mais nada', () => {
    expect(mainHeartbeatReply(() => 1_234)).toEqual({ at: 1_234 });
  });

  it('registra o handler uma vez e ele devolve o eco na hora', async () => {
    registerMainHeartbeatIpc();
    registerMainHeartbeatIpc();
    const { ipcMain } = await import('electron');
    expect(ipcMain.handle).toHaveBeenCalledTimes(1);
    const handler = handlers.get(WINDOW_CHANNELS.heartbeat);
    expect(WINDOW_CHANNELS.heartbeat).toBe('app:heartbeat');
    const before = Date.now();
    const reply = handler?.({}) as { at: number };
    expect(reply.at).toBeGreaterThanOrEqual(before);
  });
});
