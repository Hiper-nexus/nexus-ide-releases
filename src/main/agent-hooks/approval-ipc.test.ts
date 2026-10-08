import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (name: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(name, fn),
}));

import { APPROVAL_CHANNELS } from '../../shared/approval-channels';
import {
  ApprovalBroker,
  __resetApprovalRespondersForTests,
  approvalFingerprint,
  hasApprovalResponder,
} from './approval-broker';
import { registerApprovalIpc } from './approval-ipc';

type Sender = {
  id: number;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  isCrashed: () => boolean;
  once: (event: string, cb: () => void) => void;
  destroy: () => void;
};

function sender(id = 1): Sender {
  let destroyed = false;
  const onDestroyed: Array<() => void> = [];
  return {
    id,
    send: vi.fn(),
    isDestroyed: () => destroyed,
    isCrashed: () => false,
    once: (event, cb) => {
      if (event === 'destroyed') onDestroyed.push(cb);
    },
    destroy: () => {
      destroyed = true;
      for (const cb of onDestroyed) cb();
    },
  };
}

function call(channel: string, event: unknown, ...args: unknown[]): unknown {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler(event, ...args);
}

function openOn(broker: ApprovalBroker) {
  return broker.open({
    sessionId: 'sess-a',
    provider: 'claude',
    tool: 'Bash',
    summary: 'ls',
    options: [{ optionId: 'accept' }, { optionId: 'decline' }],
    waitMs: 60_000,
    fingerprint: approvalFingerprint('Bash', { command: 'ls' }),
    highImpact: false,
  })!;
}

afterEach(() => {
  h.handlers.clear();
  __resetApprovalRespondersForTests();
});

describe('approval IPC (desktop card)', () => {
  it('lists, pushes changes to the renderer and answers with a decision', async () => {
    const broker = new ApprovalBroker();
    registerApprovalIpc(broker);
    const web = sender();
    expect(call(APPROVAL_CHANNELS.list, { sender: web })).toEqual([]);
    const opened = openOn(broker);
    expect(web.send).toHaveBeenLastCalledWith(APPROVAL_CHANNELS.changed, [opened.request]);
    const result = call(APPROVAL_CHANNELS.respond, { sender: web }, {
      requestId: opened.request.requestId,
      expectedRevision: 1,
      optionId: 'accept',
    });
    expect(result).toMatchObject({ status: 'accepted', receipt: { source: 'desktop' } });
    await expect(opened.decision).resolves.toBe('accept');
    expect(web.send).toHaveBeenLastCalledWith(APPROVAL_CHANNELS.changed, []);
  });

  it('refuses malformed answers without side effects', () => {
    const broker = new ApprovalBroker();
    registerApprovalIpc(broker);
    const opened = openOn(broker);
    for (const bad of [
      { requestId: opened.request.requestId, expectedRevision: 1, optionId: 'acceptAlways' },
      { requestId: opened.request.requestId, expectedRevision: 1, optionId: 'accept', extra: 1 },
      { requestId: opened.request.requestId, expectedRevision: '1', optionId: 'accept' },
      null,
    ]) {
      expect(call(APPROVAL_CHANNELS.respond, { sender: sender() }, bad)).toEqual({
        status: 'rejected',
        reason: 'invalid-params',
      });
    }
    expect(broker.list()).toHaveLength(1);
  });

  it('a visible card makes the session a responder until the window goes away', () => {
    registerApprovalIpc(new ApprovalBroker());
    const web = sender(7);
    expect(hasApprovalResponder('sess-a')).toBe(false);
    expect(call(APPROVAL_CHANNELS.surfaces, { sender: web }, { sessionIds: ['sess-a'] })).toBe(true);
    expect(hasApprovalResponder('sess-a')).toBe(true);
    expect(call(APPROVAL_CHANNELS.surfaces, { sender: web }, { sessionIds: [] })).toBe(true);
    expect(hasApprovalResponder('sess-a')).toBe(false);
    call(APPROVAL_CHANNELS.surfaces, { sender: web }, { sessionIds: ['sess-a'] });
    web.destroy();
    expect(hasApprovalResponder('sess-a')).toBe(false);
    expect(call(APPROVAL_CHANNELS.surfaces, { sender: web }, { sessionIds: 'sess-a' })).toBe(false);
  });
});
