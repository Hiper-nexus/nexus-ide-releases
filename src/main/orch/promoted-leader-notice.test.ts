import { beforeEach, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import { promotedLeaderNoticeAuthority } from './promoted-leader-notice';

const physical = vi.hoisted(() => ({ sessions: [] as Record<string, unknown>[] }));
vi.mock('../pty/pty-manager', () => ({ listAgentSessions: () => physical.sessions }));
const scope = testProjectScope();
const execution = { ...scope, rootRealPath: '/private/execution', checkoutId: 'execution' };
const input = { scope, sessionId: 'session-399', paneId: 'pane-399', missionId: 'mission-399' };
beforeEach(() => {
  physical.sessions = [{ ...input, role: 'orchestrator', adapterId: 'claude', accountId: 'account-399',
    scope: execution, coordinationScope: scope }];
});

it('F-399 captures Claude proof options and keeps coordination separate from execution', () => {
  const captured = promotedLeaderNoticeAuthority(input);
  expect(captured.adapterId).toBe('claude');
  expect(() => captured.invocation.assertCurrentAuthority?.()).not.toThrow();
});

it.each(['sessionId', 'paneId', 'missionId', 'role', 'adapterId', 'accountId', 'scope', 'coordinationScope', 'missing'])(
  'F-399 rejects actual physical authority drift: %s', field => {
    const captured = promotedLeaderNoticeAuthority(input);
    physical.sessions = field === 'missing' ? [] : [{ ...physical.sessions[0],
      [field]: field === 'scope' || field === 'coordinationScope' ? { ...scope, checkoutId: 'foreign' } : 'foreign' }];
    expect(() => captured.invocation.assertCurrentAuthority?.()).toThrow('operator_tab_mission_authority_changed');
  },
);
