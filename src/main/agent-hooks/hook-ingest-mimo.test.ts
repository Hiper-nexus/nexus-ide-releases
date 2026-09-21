import { beforeEach, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({
  validate: vi.fn(), notify: vi.fn(), save: vi.fn(), publish: vi.fn(() => ({ paneSessionState: 'busy' })),
}));
vi.mock('../pty/pty-manager', () => ({ getAgentSessionInfo: () => ({ adapterId: 'mimo-code', paneId: 'pane-a', accountId: 'acct-a', scope: {} }) }));
vi.mock('../agent-runtime/agent-runtime-bridge', () => ({ publishAgentHookActivity: deps.publish }));
vi.mock('../persistence/provider-session-store', () => ({ saveProviderPaneSession: deps.save }));
vi.mock('./mimo-session-registry', () => ({ validateMimoSessionBinding: deps.validate, publishMimoSessionBinding: deps.notify }));
import { ingestAgentHookStatus } from './hook-ingest';
const payload = { agentType: 'mimo-code', state: 'working', providerSession: { key: 'session_id', id: 'ses_root' } };
beforeEach(() => { vi.clearAllMocks(); deps.validate.mockReturnValue(null); deps.save.mockReturnValue(true); });

it('does not bypass the MiMo nonce by omitting providerSession and claiming another provider', () => {
  expect(ingestAgentHookStatus('pty-a', { agentType: 'claude', state: 'done' }, { pathname: '/hook/claude' }))
    .toEqual({ ok: false, reason: 'unverified-mimo-session' });
  expect(deps.publish).not.toHaveBeenCalled();
});

it('rejects an unproved MiMo root before publishing activity or persisting resume', () => {
  expect(ingestAgentHookStatus('pty-a', payload, { pathname: '/hook/mimo-code' })).toEqual({ ok: false, reason: 'unverified-mimo-session' });
  expect(deps.publish).not.toHaveBeenCalled(); expect(deps.save).not.toHaveBeenCalled();
});

it('publishes an exact verified binding and only then notifies token telemetry', () => {
  const binding = { ptySessionId: 'pty-a', providerSessionId: 'ses_root' };
  deps.validate.mockReturnValue(binding);
  expect(ingestAgentHookStatus('pty-a', payload, { pathname: '/hook/mimo-code' })).toMatchObject({ ok: true, authorizesEvidence: false });
  expect(deps.save).toHaveBeenCalledWith({}, 'pane-a', 'mimo-code', payload.providerSession, 'acct-a', undefined);
  expect(deps.notify).toHaveBeenCalledWith(binding);
  expect(deps.save.mock.invocationCallOrder[0]).toBeLessThan(deps.notify.mock.invocationCallOrder[0]);
});
