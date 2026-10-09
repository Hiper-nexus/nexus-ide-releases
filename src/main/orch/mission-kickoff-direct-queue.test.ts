import { afterEach, describe, expect, it } from 'vitest';
import {
  enqueueKickoffDirect,
  isKickoffInProgressError,
  rememberKickoffBrief,
  rememberedKickoffBrief,
  resetKickoffDirectQueueForTests,
  takeKickoffDirects,
  tryRecordIdleKickoffAcceptance,
  beginKickoffBriefDelivery,
  endKickoffBriefDelivery,
  updateKickoffBriefDeliveryHash,
  pendingKickoffBriefDelivery,
} from './mission-kickoff-direct-queue';

afterEach(() => {
  resetKickoffDirectQueueForTests();
});
const scope = { version: 1 as const, identitySource: 'manifest' as const, installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: '/tmp/owned' };
const admission = { intentVersion: 1, intentAuthorityHash: 'a'.repeat(64) };

describe('mission-kickoff-direct-queue', () => {
  it('F-1109: two coordination scopes with the same mission id retain independent holds and queues', () => {
    const other = { ...scope, checkoutId: 'other-checkout', rootRealPath: '/tmp/other', workspaceRootDevice: '1', workspaceRootInode: '2' };
    const first = beginKickoffBriefDelivery(scope, { ...admission, missionId: 'm1', orchestratorSessionId: 's1', promptHash: 'a'.repeat(64) });
    enqueueKickoffDirect({ ...admission, scope, missionId: 'm1', targetAgentId: null, text: 'A', kickoffAttemptId: first.attemptId });
    const second = beginKickoffBriefDelivery(other, { ...admission, missionId: 'm1', orchestratorSessionId: 's2', promptHash: 'b'.repeat(64) });
    enqueueKickoffDirect({ ...admission, scope: other, missionId: 'm1', targetAgentId: null, text: 'B', kickoffAttemptId: second.attemptId });
    expect(pendingKickoffBriefDelivery(scope, 'm1')).toBe(first);
    expect(pendingKickoffBriefDelivery(other, 'm1')).toBe(second);
    const updated = updateKickoffBriefDeliveryHash(first, 'c'.repeat(64));
    expect(endKickoffBriefDelivery(first)).toBe(false);
    expect(pendingKickoffBriefDelivery(other, 'm1')).toBe(second);
    expect(takeKickoffDirects('m1', scope, second.attemptId)).toEqual([]);
    expect(takeKickoffDirects('m1', scope, first.attemptId).map(item => item.text)).toEqual(['A']);
    expect(endKickoffBriefDelivery(updated)).toBe(true);
    expect(pendingKickoffBriefDelivery(other, 'm1')).toBe(second);
    expect(takeKickoffDirects('m1', other, second.attemptId).map(item => item.text)).toEqual(['B']);
    expect(endKickoffBriefDelivery(second)).toBe(true);
  });
  it('F-1109: context hash updates and old attempts cannot clear a newer session or borrow another scope', () => {
    const owner = { ...scope, workspaceRootDevice: '1', workspaceRootInode: '2' };
    const old = beginKickoffBriefDelivery(owner, { ...admission, missionId: 'm1', orchestratorSessionId: 's1', promptHash: 'b'.repeat(64) });
    const composed = updateKickoffBriefDeliveryHash(old, 'c'.repeat(64));
    expect(endKickoffBriefDelivery(old)).toBe(false);
    expect(pendingKickoffBriefDelivery(owner, 'm1')?.promptHash).toBe('c'.repeat(64));
    const newer = beginKickoffBriefDelivery(owner, { ...admission, intentVersion: 2, missionId: 'm1', orchestratorSessionId: 's2', promptHash: 'd'.repeat(64) });
    owner.workspaceRootInode = '3';
    expect(pendingKickoffBriefDelivery(owner, 'm1')).toBeNull();
    expect(pendingKickoffBriefDelivery({ ...owner, workspaceRootInode: '2' }, 'm1')?.orchestratorSessionId).toBe('s2');
    expect(endKickoffBriefDelivery(composed)).toBe(false);
    expect(() => updateKickoffBriefDeliveryHash(composed, 'e'.repeat(64))).toThrow('kickoff_delivery_attempt_changed');
    expect(pendingKickoffBriefDelivery({ ...owner, workspaceRootInode: '2' }, 'm2')).toBeNull();
    expect(endKickoffBriefDelivery(newer)).toBe(true);
  });
  it('F-1109: a bootstrap adopts only unbound rows of its captured scope and intent', () => {
    const own = enqueueKickoffDirect({ ...admission, scope, missionId: 'm1', targetAgentId: null, text: 'current' });
    const stale = enqueueKickoffDirect({ ...admission, intentVersion: 0, scope, missionId: 'm1', targetAgentId: null, text: 'old version' });
    const changed = enqueueKickoffDirect({ ...admission, intentAuthorityHash: 'f'.repeat(64), scope, missionId: 'm1', targetAgentId: null, text: 'old authority' });
    const foreign = enqueueKickoffDirect({ ...admission, scope: { ...scope, checkoutId: 'foreign' }, missionId: 'm1', targetAgentId: null, text: 'other checkout' });
    const old = beginKickoffBriefDelivery(scope, { ...admission, missionId: 'm1', orchestratorSessionId: 's1', promptHash: 'b'.repeat(64) });
    const newer = beginKickoffBriefDelivery(scope, { ...admission, missionId: 'm1', orchestratorSessionId: 's2', promptHash: 'c'.repeat(64) });
    expect(takeKickoffDirects('m1', scope, newer.attemptId)).toEqual([]);
    expect(takeKickoffDirects('m1', scope, old.attemptId).map(item => item.directionId)).toEqual([own.directionId]);
    expect(takeKickoffDirects('m1', scope).map(item => item.directionId)).toEqual([stale.directionId, changed.directionId]);
    expect(takeKickoffDirects('m1', { ...scope, checkoutId: 'foreign' }).map(item => item.directionId)).toEqual([foreign.directionId]);
  });
  it('F-1105: consumes only the originating checkout and gives repeated identical directions distinct correlations', () => {
    const scope = { version: 1 as const, identitySource: 'manifest' as const, installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: '/tmp/owned', workspaceRootDevice: '1', workspaceRootInode: '2' };
    const foreign = { ...scope, rootRealPath: '/tmp/foreign', workspaceRootInode: '3' };
    const first = enqueueKickoffDirect({ ...admission, scope, missionId: 'm1', targetAgentId: null, text: 'same direction' });
    const second = enqueueKickoffDirect({ ...admission, scope, missionId: 'm1', targetAgentId: null, text: 'same direction' });
    enqueueKickoffDirect({ ...admission, scope: foreign, missionId: 'm1', targetAgentId: null, text: 'foreign direction' });
    expect(first.directionId).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.directionId).not.toBe(first.directionId);
    scope.workspaceRootInode = '9';
    expect(takeKickoffDirects('m1', { ...scope, workspaceRootInode: '2' }).map(item => item.text)).toEqual(['same direction', 'same direction']);
    expect(takeKickoffDirects('m1', { ...scope, workspaceRootInode: '2' })).toEqual([]);
    expect(takeKickoffDirects('m1', foreign).map(item => item.text)).toEqual(['foreign direction']);
  });
  it('enfileira e devolve a orientação na ordem', () => {
    enqueueKickoffDirect({
      ...admission,
      scope,
      missionId: 'm1',
      targetAgentId: null,
      text: 'decida e entregue saas-waitlist/ sem perguntar',
    });
    enqueueKickoffDirect({
      ...admission,
      scope,
      missionId: 'm1',
      targetAgentId: 'ag-ux',
      text: 'foque no formulário',
    });

    expect(takeKickoffDirects('m1', scope).map((item) => item.text)).toEqual([
      'decida e entregue saas-waitlist/ sem perguntar',
      'foque no formulário',
    ]);
    expect(takeKickoffDirects('m1', scope)).toEqual([]);
  });

  it('grava o recibo quando o pane está idle com briefing e sem auth', () => {
    const recorded: Array<{ promptHash: string; sessionId: string }> = [];
    expect(
      tryRecordIdleKickoffAcceptance({
        missionId: 'm1',
        sessionId: 'sess-orch',
        intentVersion: 1,
        promptHash: 'a'.repeat(64),
        sessionIdle: true,
        sessionOutput: 'Claude Code ready',
        hasCurrentKickoffAcceptance: false,
        recordKickoffAcceptance: (raw) => {
          recorded.push({
            promptHash: raw.promptHash,
            sessionId: raw.orchestratorSessionId,
          });
        },
      }),
    ).toBe(true);
    expect(recorded).toEqual([
      { promptHash: 'a'.repeat(64), sessionId: 'sess-orch' },
    ]);
  });

  it('não grava recibo se o TUI ainda é OAuth/first-run', () => {
    expect(
      tryRecordIdleKickoffAcceptance({
        missionId: 'm1',
        sessionId: 'sess-orch',
        intentVersion: 1,
        promptHash: 'a'.repeat(64),
        sessionIdle: true,
        sessionOutput: 'Paste code here if prompted >',
        hasCurrentKickoffAcceptance: false,
        recordKickoffAcceptance: () => {
          throw new Error('não deveria gravar');
        },
      }),
    ).toBe(false);
  });

  it('não grava recibo enquanto o pane não está idle', () => {
    expect(
      tryRecordIdleKickoffAcceptance({
        missionId: 'm1',
        sessionId: 'sess-orch',
        intentVersion: 1,
        promptHash: 'a'.repeat(64),
        sessionIdle: false,
        sessionOutput: '',
        hasCurrentKickoffAcceptance: false,
        recordKickoffAcceptance: () => {
          throw new Error('não deveria gravar');
        },
      }),
    ).toBe(false);
  });

  it('trata o erro de recibo como kickoff em curso, não como Maestro morto', () => {
    expect(
      isKickoffInProgressError(
        new Error('mission direct requires the current kickoff receipt'),
        false,
      ),
    ).toBe(true);
    expect(
      isKickoffInProgressError(
        new Error('mission direct requires a live orchestrator session'),
        false,
      ),
    ).toBe(true);
    expect(
      isKickoffInProgressError(
        new Error('mission direct requires a live orchestrator session'),
        true,
      ),
    ).toBe(false);
  });

  it('lembra o hash do briefing para o poke aceitar o mesmo recibo', () => {
    rememberKickoffBrief({
      missionId: 'm1',
      orchestratorSessionId: 'sess-orch',
      intentVersion: 2,
      promptHash: 'b'.repeat(64),
    });
    expect(rememberedKickoffBrief('m1')).toEqual({
      missionId: 'm1',
      orchestratorSessionId: 'sess-orch',
      intentVersion: 2,
      promptHash: 'b'.repeat(64),
    });
  });
});
