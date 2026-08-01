// Fail-closed proof for the observability plane: even when the observer bus
// module itself is broken (publish throws synchronously), the agent-status
// reducer keeps its total-function contract — the hook gate endpoint must
// never be taken down by frame emission. Split from the main emission suite
// because vi.mock is file-scoped.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalHookEvent } from '../../vendor/emdash/hooks/hooks-types';

const harness = vi.hoisted(() => ({
  publish: vi.fn((_sessionId: string, _state: string) => true),
}));

vi.mock('../pty/pty-manager', () => ({
  publishSessionActivityState: (sessionId: string, state: string) =>
    harness.publish(sessionId, state),
  getAgentSessionInfo: () => null,
  getSessionState: () => 'idle',
}));

vi.mock('./observer-bus', () => ({
  publishObserverFrame: () => {
    throw new Error('observer bus is broken');
  },
}));

import {
  __resetAgentStatusForTests,
  applyCanonicalHookEvent,
  getAgentSemanticStatus,
  resetAgentStatusOnExit,
} from './agent-status';

const start: CanonicalHookEvent = { kind: 'status', type: 'start' };

beforeEach(() => {
  __resetAgentStatusForTests();
  harness.publish.mockReset().mockImplementation(() => true);
});

describe('agent-status with a broken observer bus', () => {
  it('applyCanonicalHookEvent still applies the status and reports applied:true', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-use', toolName: 'Bash' },
    });

    expect(result).toMatchObject({ applied: true, transitioned: true });
    expect(getAgentSemanticStatus('pty-1')?.status).toBe('working');
    expect(harness.publish).toHaveBeenCalledWith('pty-1', 'busy');
    warn.mockRestore();
  });

  it('resetAgentStatusOnExit still resets the pane', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });

    resetAgentStatusOnExit('pty-1');

    expect(getAgentSemanticStatus('pty-1')).toBeNull();
    warn.mockRestore();
  });
});
