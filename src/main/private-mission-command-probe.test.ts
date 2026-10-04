import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ scope: null as unknown }));
vi.mock('./persistence/renderer-workspace-scope', () => ({ getRendererWorkspaceScope: () => state.scope }));
import { armPrivateMissionCommandProbe, observePrivateMissionCommand } from './private-mission-command-probe';
const scope = { installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: '/private' };
it('is dormant and preserves the exact normal result/error without registration', async () => {
  const result = {}, run = vi.fn(async () => result);
  await expect(observePrivateMissionCommand({} as never, scope as never, { kind: 'resume', missionId: 'm' }, run as never)).resolves.toBe(result);
  const error = new Error('canonical'); await expect(observePrivateMissionCommand({} as never, scope as never, { kind: 'retry-kickoff', missionId: 'm' }, async () => { throw error; })).rejects.toBe(error);
});
it('records only the leased frame/scope and the actual refusal/current question; revocation stays passive', async () => {
  state.scope = scope; const frame = {}, wc = { mainFrame: frame }, record = vi.fn(), failed = vi.fn();
  const snapshot = vi.fn(async () => ({ question: { id: 'q' } }));
  const release = armPrivateMissionCommandProbe({ wc, frame, scope, nonce: '11111111-1111-4111-8111-111111111111', snapshot, record, failed } as never);
  const event = { sender: wc, senderFrame: frame }, command = { kind: 'retry-kickoff', missionId: 'm' } as const, error = new Error('question_pending');
  try {
    await expect(observePrivateMissionCommand({ ...event, senderFrame: {} } as never, scope as never, command, async () => { throw error; })).rejects.toBe(error);
    expect(record).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled();
    await expect(observePrivateMissionCommand(event as never, scope as never, command, async () => { throw error; })).rejects.toBe(error);
    expect(record).toHaveBeenCalledWith({ missionId: 'm', questionId: 'q', kind: 'retry-kickoff', refused: true, remainingQuestionId: 'q', errorCode: 'question_pending' });
    record.mockClear(); state.scope = { ...scope, checkoutId: 'other' };
    await observePrivateMissionCommand(event as never, scope as never, command, async () => ({} as never)); expect(record).not.toHaveBeenCalled();
  } finally { release(); }
});
it('cannot change canonical success when a passive observation fails', async () => {
  state.scope = scope; const frame = {}, wc = { mainFrame: frame }, result = { question: undefined };
  const release = armPrivateMissionCommandProbe({ wc, frame, scope, nonce: 'nonce', snapshot: async () => ({ question: { id: 'q' } }),
    record: () => { throw new Error('observer'); }, failed: () => { throw new Error('observer-failure'); } } as never);
  try { await expect(observePrivateMissionCommand({ sender: wc, senderFrame: frame } as never, scope as never,
    { kind: 'answer-question', missionId: 'm', questionId: 'q', optionId: 'choice' }, async () => result as never)).resolves.toBe(result); } finally { release(); }
});
