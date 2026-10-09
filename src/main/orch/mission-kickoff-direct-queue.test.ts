import { afterEach, describe, expect, it } from 'vitest';
import {
  enqueueKickoffDirect,
  isKickoffInProgressError,
  rememberKickoffBrief,
  rememberedKickoffBrief,
  resetKickoffDirectQueueForTests,
  takeKickoffDirects,
  tryRecordIdleKickoffAcceptance,
} from './mission-kickoff-direct-queue';

afterEach(() => {
  resetKickoffDirectQueueForTests();
});
const scope = { version: 1 as const, identitySource: 'manifest' as const, installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: '/tmp/owned' };

describe('mission-kickoff-direct-queue', () => {
  it('F-1105: consumes only the originating checkout and gives repeated identical directions distinct correlations', () => {
    const scope = { version: 1 as const, identitySource: 'manifest' as const, installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: '/tmp/owned', workspaceRootDevice: '1', workspaceRootInode: '2' };
    const foreign = { ...scope, rootRealPath: '/tmp/foreign', workspaceRootInode: '3' };
    const first = enqueueKickoffDirect({ scope, missionId: 'm1', targetAgentId: null, text: 'same direction' });
    const second = enqueueKickoffDirect({ scope, missionId: 'm1', targetAgentId: null, text: 'same direction' });
    enqueueKickoffDirect({ scope: foreign, missionId: 'm1', targetAgentId: null, text: 'foreign direction' });
    expect(first.directionId).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.directionId).not.toBe(first.directionId);
    scope.workspaceRootInode = '9';
    expect(takeKickoffDirects('m1', { ...scope, workspaceRootInode: '2' }).map(item => item.text)).toEqual(['same direction', 'same direction']);
    expect(takeKickoffDirects('m1', { ...scope, workspaceRootInode: '2' })).toEqual([]);
    expect(takeKickoffDirects('m1', foreign).map(item => item.text)).toEqual(['foreign direction']);
  });
  it('enfileira e devolve a orientação na ordem', () => {
    enqueueKickoffDirect({
      scope,
      missionId: 'm1',
      targetAgentId: null,
      text: 'decida e entregue saas-waitlist/ sem perguntar',
    });
    enqueueKickoffDirect({
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
