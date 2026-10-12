import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ owned: vi.fn(), scope: vi.fn(), state: vi.fn(), sequence: vi.fn(), semantic: vi.fn(), context: vi.fn(), write: vi.fn(), adapter: vi.fn() }));
vi.mock('./pty-manager', () => ({ getOwnedAgentSessionInfo: h.owned, getSessionState: h.state, orchWriteSession: h.write }));
vi.mock('../orch/agent-status', () => ({ getAgentTurnStartSequence: h.sequence, getAgentSemanticStatusBySession: h.semantic }));
vi.mock('../persistence/renderer-workspace-scope', () => ({ requireLiveRendererWorkspaceScope: h.scope }));
vi.mock('../orch/gate', () => ({ getContextBySession: h.context }));
vi.mock('../adapters/adapter-registry', () => ({ getAdapter: h.adapter }));
import { readOwnedPromptState, submitOwnedPromptEnter } from './pty-prompt-state';
const owner = {} as never;
beforeEach(() => {
  vi.resetAllMocks(); h.owned.mockReturnValue({ scope: { rootRealPath: '/worktree' } });
  h.context.mockReturnValue({ scope: { rootRealPath: '/project' } });
  h.state.mockReturnValue('idle'); h.sequence.mockReturnValue(7); h.semantic.mockReturnValue({ status: 'awaiting-input', message: 'private' });
});
it('returns only canonical sequence, physical state and dialog veto to the owner', () => {
  expect(readOwnedPromptState(owner, { sessionId: 'session' })).toEqual({ turnStartSequence: 7, state: 'idle', awaitingInput: true });
  expect(h.owned).toHaveBeenCalledWith(owner, 'session'); expect(h.scope).toHaveBeenCalledWith(owner, { rootRealPath: '/project' });
});
it.each([null, {}, { sessionId: '' }, { sessionId: 'x'.repeat(129) }, { sessionId: 'session', extra: true }])('rejects malformed request %j', raw => {
  expect(readOwnedPromptState(owner, raw)).toBeNull(); expect(h.owned).not.toHaveBeenCalled();
});
it('rejects another owner and a switched workspace', () => {
  h.owned.mockReturnValueOnce(null); expect(readOwnedPromptState(owner, { sessionId: 'session' })).toBeNull();
  h.scope.mockImplementationOnce(() => { throw new Error('scope changed'); }); expect(readOwnedPromptState(owner, { sessionId: 'session' })).toBeNull();
  expect(h.sequence).not.toHaveBeenCalled();
});
it('busy caused by input never increments the canonical sequence', () => {
  h.state.mockReturnValue('busy'); h.semantic.mockReturnValue(undefined);
  expect(readOwnedPromptState(owner, { sessionId: 'session' })).toEqual({ turnStartSequence: 7, state: 'busy', awaitingInput: false });
});

it('rejects missing coordination context rather than falling back to execution worktree', () => {
  h.context.mockReturnValue(undefined);
  expect(readOwnedPromptState(owner, { sessionId: 'session' })).toBeNull();
  expect(h.sequence).not.toHaveBeenCalled();
});


it.each([
  { state: 'idle', semantic: undefined, sequence: 7, retry: true, accepted: true },
  { state: 'busy', semantic: undefined, sequence: 7, retry: false, accepted: true },
  { state: 'busy', semantic: undefined, sequence: 7, retry: true, accepted: false },
  { state: 'idle', semantic: 'awaiting-input', sequence: 7, retry: false, accepted: false },
  { state: 'idle', semantic: 'awaiting-input', sequence: 7, retry: true, accepted: false },
  { state: 'idle', semantic: undefined, sequence: 8, retry: true, accepted: false },
])('atomic Enter checks current dialog/state/sequence: %j', input => {
  h.state.mockReturnValue(input.state); h.semantic.mockReturnValue(input.semantic ? { status: input.semantic } : undefined);
  h.sequence.mockReturnValue(input.sequence); h.write.mockReturnValue(true);
  expect(submitOwnedPromptEnter(owner, { sessionId: 'session', turnStartSequence: 7, retry: input.retry })).toBe(input.accepted);
  expect(h.write).toHaveBeenCalledTimes(input.accepted ? 1 : 0);
});
it.each([{ sessionId: 'session', turnStartSequence: -1, retry: true }, { sessionId: 'session', turnStartSequence: 7, retry: true, text: 'injection' }])('rejects malformed Enter %j', raw => {
  expect(submitOwnedPromptEnter(owner, raw)).toBe(false); expect(h.owned).not.toHaveBeenCalled();
});

it('F-1393: a capacidade de fila vem do manifesto do adapter da sessão', () => {
  h.owned.mockReturnValue({ adapterId: 'claude', scope: { rootRealPath: '/worktree' } });
  h.state.mockReturnValue('busy'); h.semantic.mockReturnValue(undefined);
  h.adapter.mockReturnValue({ quirks: { queuesInputWhileBusy: true } });
  expect(readOwnedPromptState(owner, { sessionId: 'session' })).toEqual({ turnStartSequence: 7, state: 'busy', awaitingInput: false, queuesInputWhileBusy: true });
  expect(h.adapter).toHaveBeenCalledWith('claude');
  h.adapter.mockReturnValue({ quirks: {} });
  expect(readOwnedPromptState(owner, { sessionId: 'session' })).toEqual({ turnStartSequence: 7, state: 'busy', awaitingInput: false });
});
