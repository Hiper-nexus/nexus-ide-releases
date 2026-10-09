import { describe, expect, it, vi } from 'vitest';
import { attachCdpRelay } from './cdp-relay-attach';

function fakeWebContents() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let attached = false;
  const debuggerApi = {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    sendCommand: vi.fn(async (method: string) => {
      if (method === 'Target.getTargetInfo') {
        return { targetInfo: { targetId: 'page-42' } };
      }
      return {};
    }),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      listeners.set(event, fn);
    }),
    removeListener: vi.fn((event: string) => {
      listeners.delete(event);
    }),
  };
  return {
    id: 7,
    debugger: debuggerApi,
    getURL: () => 'https://app.local/',
    getTitle: () => 'Preview',
    getUserAgent: () => 'NexusIDE-Test',
    listeners,
  };
}

describe('CdpRelay attach (Electron plug)', () => {
  it('attaches the debugger and routes events into the relay', async () => {
    const wc = fakeWebContents();
    const written: Record<string, unknown>[] = [];
    const attach = attachCdpRelay(wc as never, {
      write: (raw) => {
        written.push(JSON.parse(raw) as Record<string, unknown>);
      },
    });
    expect(wc.debugger.attach).toHaveBeenCalledWith('1.3');
    expect(attach.attached).toBe(true);
    // Evento do debugger vira mensagem CDP no write.
    wc.listeners.get('message')?.({}, 'Page.loadEventFired', {}, undefined);
    // Precisa do Target.setAutoAttach antes de o relay emitir eventos.
    attach.connection.receive(JSON.stringify({ id: 1, method: 'Target.setAutoAttach' }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    written.length = 0;
    wc.listeners.get('message')?.({}, 'Page.loadEventFired', {}, undefined);
    expect(written[0]).toMatchObject({ method: 'Page.loadEventFired' });
    attach.detach();
    expect(wc.debugger.detach).toHaveBeenCalled();
    expect(wc.debugger.removeListener).toHaveBeenCalled();
  });

  it('shares an already-attached debugger without re-attaching', () => {
    const wc = fakeWebContents();
    wc.debugger.isAttached.mockReturnValue(true);
    const attach = attachCdpRelay(wc as never, { write: () => undefined });
    expect(wc.debugger.attach).not.toHaveBeenCalled();
    attach.detach();
    expect(wc.debugger.detach).not.toHaveBeenCalled();
  });

  it('forwards page commands to the debugger with sessionId', async () => {
    const wc = fakeWebContents();
    const attach = attachCdpRelay(wc as never, { write: () => undefined });
    attach.connection.receive(
      JSON.stringify({
        id: 2,
        method: 'Page.navigate',
        params: { url: 'https://x' },
        sessionId: 'nexus-preview-page',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith(
      'Page.navigate',
      { url: 'https://x' },
      undefined,
    );
    attach.detach();
  });
});
