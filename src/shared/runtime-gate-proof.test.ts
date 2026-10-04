import { expect, it } from 'vitest';
import { deriveRuntimeChecks, sameRuntimeConversation } from './runtime-gate-proof';
import { runtimeFactFixture } from './__tests__/runtime-gate-fixture';
it('requires exact consumed handoff, physical delivery/ACK call and live Maestro identity', () => {
  expect(deriveRuntimeChecks(runtimeFactFixture())['handoff-ack']).toBe(true);
  for (const mutate of [(f: ReturnType<typeof runtimeFactFixture>) => { f.history[6].audit[0].handoffId = 'other-row'; },
    (f: ReturnType<typeof runtimeFactFixture>) => { f.history[6].handoffs[0].deliveryState = 'queued'; },
    (f: ReturnType<typeof runtimeFactFixture>) => { f.history[6].acknowledgements[0].deliveryAttemptId = 'old-delivery'; },
    (f: ReturnType<typeof runtimeFactFixture>) => { f.history[6].audit[0].invocation = 'other-call'; }]) {
    const f = runtimeFactFixture(); mutate(f); expect(() => deriveRuntimeChecks(f)).toThrow(/handoff-ack/);
  }
});
it('requires actual retry refusal and answer result for the exact visible question', () => {
  for (const mutate of [(f: ReturnType<typeof runtimeFactFixture>) => { f.questionCommands[0].refused = false; },
    (f: ReturnType<typeof runtimeFactFixture>) => { f.questionCommands[1].questionId = 'other-question'; },
    (f: ReturnType<typeof runtimeFactFixture>) => { f.questionCommands[0].remainingQuestionId = 'old-question'; }]) {
    const f = runtimeFactFixture(); mutate(f); expect(() => deriveRuntimeChecks(f)).toThrow(/question-answer/);
  }
});
it('rejects renamed media objects, unfinished graph, missing kernel echo and unproved worker recovery', () => {
  for (const mutate of [(f: ReturnType<typeof runtimeFactFixture>) => { f.voice.final.trackIds = ['different-capture']; },
    (f: ReturnType<typeof runtimeFactFixture>) => { f.voice.final.contextIds = ['different-graph']; },
    (f: ReturnType<typeof runtimeFactFixture>) => { f.voice.final.closed = 0; }, (f: ReturnType<typeof runtimeFactFixture>) => { f.voice.permissions = 0; },
    (f: ReturnType<typeof runtimeFactFixture>) => { f.echoSessions = []; }, (f: ReturnType<typeof runtimeFactFixture>) => { f.history[6].agents[1].pid = 234; },
    (f: ReturnType<typeof runtimeFactFixture>) => { f.history[6].agents[1].conversation = { key: 'session_id', id: 'fresh-conversation' }; }]) {
    const f = runtimeFactFixture(); mutate(f); expect(() => deriveRuntimeChecks(f)).toThrow();
  }
});
it('matches actual provider identity and requires the resumed CLI reply in that exact physical session', () => {
  expect(sameRuntimeConversation({ key: 'session_id', id: 'x', transcriptPath: '/a' }, { key: 'session_id', id: 'x', transcriptPath: '/b' })).toBe(true);
  expect(sameRuntimeConversation(null, null)).toBe(false);
  expect(deriveRuntimeChecks(runtimeFactFixture('resume'))['exact-resume']).toBe(true);
  const f = runtimeFactFixture('resume'); f.resumedOutput = ['other-sid']; expect(() => deriveRuntimeChecks(f)).toThrow();
  f.resumedOutput = ['chief-sid']; f.state.conversation = { key: 'session_id', id: 'fresh-conversation' }; expect(() => deriveRuntimeChecks(f)).toThrow();
});
