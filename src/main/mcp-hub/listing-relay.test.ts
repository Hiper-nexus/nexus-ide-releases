import { describe, expect, it, vi } from 'vitest';
import {
  ListingRelay,
  LISTING_RECONNECT_TOOL_NAME,
  reconnectToolPlaceholder,
  type ListingRelayDeps,
} from './listing-relay';

type PostFn = ListingRelayDeps['post'];

function makeRelay(overrides: { post: PostFn }) {
  const emitted: unknown[] = [];
  const statuses: unknown[] = [];
  const sleep = vi.fn(async () => {});
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const relay = new ListingRelay({
    post: overrides.post,
    emit: (m) => emitted.push(m),
    log: () => {},
    writeStatus: (s) => statuses.push(s),
    sleep,
    schedule: (fn, ms) => {
      timers.push({ fn, ms });
      return () => {};
    },
    now: () => 1000,
  });
  return { relay, emitted, statuses, sleep, timers };
}

describe('ListingRelay (OVKA-754 pattern)', () => {
  it('returns real tools on a successful listing', async () => {
    const tools = [{ name: 'nexus_pane_list' }];
    const { relay, emitted } = makeRelay({
      post: async () => ({ status: 200, messages: [{ jsonrpc: '2.0', id: 1, result: { tools } }] }),
    });
    await relay.handle({ id: 1, method: 'tools/list' });
    expect(emitted[0]).toMatchObject({ result: { tools } });
    expect(relay.currentState).toBe('ok');
  });

  it('retries listing on a lost reply and uses a FRESH socket on retry', async () => {
    const calls: Array<{ fresh: boolean }> = [];
    const tools = [{ name: 'ok' }];
    let n = 0;
    const { relay, emitted } = makeRelay({
      post: async (_body, opts) => {
        calls.push({ fresh: opts.fresh });
        n += 1;
        if (n < 3) throw new Error('lost in transit');
        return { status: 200, messages: [{ jsonrpc: '2.0', id: 1, result: { tools } }] };
      },
    });
    await relay.handle({ id: 1, method: 'tools/list' });
    expect(calls).toHaveLength(3);
    expect(calls[0].fresh).toBe(false);
    expect(calls[1].fresh).toBe(true);
    expect(calls[2].fresh).toBe(true);
    expect(emitted[0]).toMatchObject({ result: { tools } });
  });

  it('never leaves the session mute: placeholder + background recovery', async () => {
    const { relay, emitted, timers } = makeRelay({
      post: async () => {
        throw new Error('gone');
      },
    });
    await relay.handle({ id: 1, method: 'tools/list' });
    const placeholder = (emitted[0] as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(placeholder[0].name).toBe(LISTING_RECONNECT_TOOL_NAME);
    expect(timers.length).toBeGreaterThan(0);
    expect(reconnectToolPlaceholder().description).toContain('list_changed');
  });

  it('never retries tools/call (state-changing)', async () => {
    let calls = 0;
    const { relay, emitted } = makeRelay({
      post: async () => {
        calls += 1;
        throw new Error('lost');
      },
    });
    await relay.handle({ id: 2, method: 'tools/call', params: { name: 'nexus_pane_close' } });
    expect(calls).toBe(1);
    expect(emitted[0]).toMatchObject({
      error: { message: expect.stringContaining('não repita') },
    });
  });
});
