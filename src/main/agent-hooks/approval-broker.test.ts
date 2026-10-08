import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalOption } from '../../shared/approval-decision';
import {
  ApprovalBroker,
  __resetApprovalRespondersForTests,
  approvalFingerprint,
  hasApprovalResponder,
  registerRemoteApprovalResponder,
  setDesktopApprovalSurfaces,
  type OpenApprovalInput,
} from './approval-broker';

const OPTIONS: ApprovalOption[] = [{ optionId: 'accept' }, { optionId: 'acceptForSession' }, { optionId: 'decline' }];

function input(overrides: Partial<OpenApprovalInput> = {}): OpenApprovalInput {
  return {
    sessionId: 'sess-a',
    provider: 'claude',
    tool: 'Bash',
    summary: 'ls',
    options: OPTIONS,
    waitMs: 60_000,
    fingerprint: approvalFingerprint('Bash', { command: 'ls' }),
    highImpact: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  __resetApprovalRespondersForTests();
});

describe('ApprovalBroker', () => {
  it('resolves the waiting hook with the decision and returns a receipt', async () => {
    const broker = new ApprovalBroker({ now: () => 1_000 });
    const opened = broker.open(input())!;
    const result = broker.respond({
      requestId: opened.request.requestId,
      expectedRevision: 1,
      optionId: 'accept',
      source: 'mobile',
    });
    expect(result).toEqual({
      status: 'accepted',
      receipt: {
        requestId: opened.request.requestId,
        revision: 1,
        optionId: 'accept',
        source: 'mobile',
        decidedAt: 1_000,
        duplicate: false,
      },
    });
    await expect(opened.decision).resolves.toBe('accept');
    expect(broker.list()).toEqual([]);
  });

  it('CAS: a stale revision is rejected and the request stays open', () => {
    const broker = new ApprovalBroker();
    const opened = broker.open(input())!;
    expect(
      broker.respond({ requestId: opened.request.requestId, expectedRevision: 2, optionId: 'accept', source: 'desktop' }),
    ).toEqual({ status: 'rejected', reason: 'stale-revision' });
    expect(broker.list()).toHaveLength(1);
  });

  it('is idempotent: the same answer again returns the receipt without deciding twice', async () => {
    const broker = new ApprovalBroker();
    const opened = broker.open(input())!;
    const answer = { requestId: opened.request.requestId, expectedRevision: 1, optionId: 'decline' as const, source: 'mobile' as const };
    const first = broker.respond(answer);
    const again = broker.respond(answer);
    expect(again).toEqual({
      status: 'accepted',
      receipt: { ...(first as { receipt: object }).receipt, duplicate: true },
    });
    expect(broker.respond({ ...answer, optionId: 'accept' })).toEqual({ status: 'rejected', reason: 'already-resolved' });
    await expect(opened.decision).resolves.toBe('decline');
  });

  it('rejects an option the card did not offer', () => {
    const broker = new ApprovalBroker();
    const opened = broker.open(input({ options: [{ optionId: 'accept' }, { optionId: 'decline' }] }))!;
    expect(
      broker.respond({ requestId: opened.request.requestId, expectedRevision: 1, optionId: 'cancel', source: 'desktop' }),
    ).toEqual({ status: 'rejected', reason: 'option-unavailable' });
  });

  it('times out to null (the hook answers {}) and later answers are refused', async () => {
    vi.useFakeTimers();
    const broker = new ApprovalBroker();
    const opened = broker.open(input({ waitMs: 5_000 }))!;
    vi.advanceTimersByTime(5_000);
    await expect(opened.decision).resolves.toBeNull();
    expect(
      broker.respond({ requestId: opened.request.requestId, expectedRevision: 1, optionId: 'accept', source: 'mobile' }),
    ).toEqual({ status: 'rejected', reason: 'closed' });
  });

  it('decides two pending requests on the right requestId', async () => {
    const broker = new ApprovalBroker();
    const first = broker.open(input({ sessionId: 'sess-a' }))!;
    const second = broker.open(input({ sessionId: 'sess-b' }))!;
    broker.respond({ requestId: second.request.requestId, expectedRevision: 1, optionId: 'decline', source: 'desktop' });
    broker.respond({ requestId: first.request.requestId, expectedRevision: 1, optionId: 'accept', source: 'mobile' });
    await expect(first.decision).resolves.toBe('accept');
    await expect(second.decision).resolves.toBe('decline');
  });

  it('supersede closes only the matching tool call, or the whole session on turn end', async () => {
    const broker = new ApprovalBroker();
    const ls = broker.open(input())!;
    const rm = broker.open(input({ fingerprint: approvalFingerprint('Bash', { command: 'rm x' }) }))!;
    const other = broker.open(input({ sessionId: 'sess-b' }))!;
    expect(broker.supersede('sess-a', approvalFingerprint('Bash', { command: 'ls' }))).toBe(1);
    await expect(ls.decision).resolves.toBeNull();
    expect(broker.list().map((r) => r.requestId)).toEqual([rm.request.requestId, other.request.requestId]);
    expect(broker.supersede('sess-a')).toBe(1);
    await expect(rm.decision).resolves.toBeNull();
    expect(broker.list().map((r) => r.requestId)).toEqual([other.request.requestId]);
  });

  it('cancel (socket closed) frees the request and notifies listeners', async () => {
    const broker = new ApprovalBroker();
    const changes = vi.fn();
    broker.subscribe(changes);
    const opened = broker.open(input())!;
    opened.cancel();
    await expect(opened.decision).resolves.toBeNull();
    expect(changes).toHaveBeenCalledTimes(2);
    expect(broker.sessionOf(opened.request.requestId)).toBe('sess-a');
  });

  it('caps pending requests per session', () => {
    const broker = new ApprovalBroker();
    for (let i = 0; i < 8; i += 1) expect(broker.open(input())).not.toBeNull();
    expect(broker.open(input())).toBeNull();
    expect(broker.open(input({ sessionId: 'sess-b' }))).not.toBeNull();
  });

  it('forgets receipts after the TTL', () => {
    let now = 0;
    const broker = new ApprovalBroker({ now: () => now, receiptTtlMs: 1_000 });
    const opened = broker.open(input())!;
    const answer = { requestId: opened.request.requestId, expectedRevision: 1, optionId: 'accept' as const, source: 'mobile' as const };
    broker.respond(answer);
    now = 2_001;
    expect(broker.respond(answer)).toEqual({ status: 'rejected', reason: 'unknown-request' });
  });
});

describe('approval responders', () => {
  it('no responder by default; the desktop card or a remote probe makes one', () => {
    expect(hasApprovalResponder('sess-a')).toBe(false);
    setDesktopApprovalSurfaces(['sess-a']);
    expect(hasApprovalResponder('sess-a')).toBe(true);
    expect(hasApprovalResponder('sess-b')).toBe(false);
    const unregister = registerRemoteApprovalResponder((id) => id === 'sess-b');
    expect(hasApprovalResponder('sess-b')).toBe(true);
    unregister();
    expect(hasApprovalResponder('sess-b')).toBe(false);
  });

  it('a throwing probe is not a responder', () => {
    registerRemoteApprovalResponder(() => {
      throw new Error('boom');
    });
    expect(hasApprovalResponder('sess-a')).toBe(false);
  });
});
