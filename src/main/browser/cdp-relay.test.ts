import { describe, expect, it, vi } from 'vitest';
import { createCdpRelayConnection, type CdpRelayTarget } from './cdp-relay';

function fakeTarget(overrides: Partial<CdpRelayTarget> = {}): CdpRelayTarget {
  return {
    send: vi.fn(async () => ({})),
    targetId: async () => 'target-1',
    url: () => 'https://app.local/',
    title: () => 'Preview',
    userAgent: () => 'NexusIDE-Test',
    setDownloadDirectory: vi.fn(),
    ...overrides,
  };
}

function collectWrites() {
  const written: Record<string, unknown>[] = [];
  const relay = createCdpRelayConnection(fakeTarget(), (raw) => {
    written.push(JSON.parse(raw) as Record<string, unknown>);
  });
  return { relay, written };
}

describe('CdpRelay (T3 port)', () => {
  it('answers Browser.getVersion with the Nexus product string', async () => {
    const { relay, written } = collectWrites();
    relay.receive(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(written[0]).toMatchObject({
      id: 1,
      result: expect.objectContaining({ product: 'NexusIDE' }),
    });
  });

  it('announces attachedToTarget on the browser session that called setAutoAttach', async () => {
    const { relay, written } = collectWrites();
    relay.receive(JSON.stringify({ id: 1, method: 'Target.attachToBrowserTarget' }));
    await Promise.resolve();
    await Promise.resolve();
    const browserSession = (
      written.find((message) => message.id === 1)?.result as { sessionId?: string } | undefined
    )?.sessionId;
    expect(browserSession).toEqual(expect.any(String));
    relay.receive(
      JSON.stringify({
        id: 2,
        method: 'Target.setAutoAttach',
        sessionId: browserSession,
        params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const reply = written.find((message) => message.id === 2);
    const announce = written.find((message) => message.method === 'Target.attachedToTarget');
    expect(reply).toMatchObject({ sessionId: browserSession });
    expect(announce).toMatchObject({
      sessionId: browserSession,
      params: expect.objectContaining({ sessionId: 'nexus-preview-page' }),
    });
  });

  it('Target.setAutoAttach announces the page session after the reply', async () => {
    const { relay, written } = collectWrites();
    relay.receive(JSON.stringify({ id: 2, method: 'Target.setAutoAttach' }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const ids = written.map((m) => m.id);
    expect(ids).toContain(2);
    const announce = written.find((m) => m.method === 'Target.attachedToTarget');
    expect(announce).toMatchObject({
      params: expect.objectContaining({ sessionId: 'nexus-preview-page' }),
    });
  });

  it('refuses to attach to a foreign target', async () => {
    const target = fakeTarget();
    const written: Record<string, unknown>[] = [];
    const relay = createCdpRelayConnection(target, (raw) => {
      written.push(JSON.parse(raw) as Record<string, unknown>);
    });
    relay.receive(
      JSON.stringify({
        id: 3,
        method: 'Target.attachToTarget',
        params: { targetId: 'other' },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(written[0]).toMatchObject({
      id: 3,
      error: expect.objectContaining({ message: expect.stringContaining('Only this preview') }),
    });
  });

  it('routes page commands to the target and swallows runIfWaitingForDebugger', async () => {
    const target = fakeTarget();
    const relay = createCdpRelayConnection(target, () => undefined);
    relay.receive(
      JSON.stringify({
        id: 4,
        method: 'Page.navigate',
        params: { url: 'https://app.local/x' },
        sessionId: 'nexus-preview-page',
      }),
    );
    await Promise.resolve();
    expect(target.send).toHaveBeenCalledWith(
      'Page.navigate',
      { url: 'https://app.local/x' },
      undefined,
    );
    relay.receive(
      JSON.stringify({
        id: 5,
        method: 'Runtime.runIfWaitingForDebugger',
        sessionId: 'nexus-preview-page',
      }),
    );
    await Promise.resolve();
    expect(target.send).toHaveBeenCalledTimes(1);
  });

  it('forwards download events on the root session and page events per session', async () => {
    const written: Record<string, unknown>[] = [];
    const relay = createCdpRelayConnection(fakeTarget(), (raw) => {
      written.push(JSON.parse(raw) as Record<string, unknown>);
    });
    relay.receive(JSON.stringify({ id: 6, method: 'Target.setAutoAttach' }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    written.length = 0;
    relay.event('Browser.downloadWillBegin', { guid: 'g' }, undefined);
    relay.event('Page.loadEventFired', {}, undefined);
    expect(written[0]).toMatchObject({ method: 'Browser.downloadWillBegin' });
    expect(written[1]).toMatchObject({
      method: 'Page.loadEventFired',
      sessionId: 'nexus-preview-page',
    });
  });

  it('returns the same browser context that Target.getTargets advertises', async () => {
    const { relay, written } = collectWrites();
    relay.receive(JSON.stringify({ id: 10, method: 'Target.getBrowserContexts' }));
    relay.receive(JSON.stringify({ id: 11, method: 'Target.getTargets' }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const contexts = written.find((message) => message.id === 10);
    const targets = written.find((message) => message.id === 11);
    const contextIds = (
      contexts?.result as { browserContextIds?: string[] } | undefined
    )?.browserContextIds;
    const targetInfos = (
      targets?.result as { targetInfos?: Array<{ browserContextId?: string }> } | undefined
    )?.targetInfos;
    expect(contextIds).toEqual(['nexus-preview']);
    expect(targetInfos?.[0]?.browserContextId).toBe('nexus-preview');
  });

  it('rejects unsupported browser commands', async () => {
    const written: Record<string, unknown>[] = [];
    const relay = createCdpRelayConnection(fakeTarget(), (raw) => {
      written.push(JSON.parse(raw) as Record<string, unknown>);
    });
    relay.receive(JSON.stringify({ id: 7, method: 'Browser.close' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(written[0]).toMatchObject({
      id: 7,
      error: expect.objectContaining({ message: expect.stringContaining('Not supported') }),
    });
  });
});
