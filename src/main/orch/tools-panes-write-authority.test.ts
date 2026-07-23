import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  write: vi.fn(() => true),
}));

vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: h.write,
  orchTerminateSession: vi.fn(async () => true),
  getSessionState: vi.fn(() => 'idle'),
  tapSessionData: vi.fn(() => () => {}),
  tapSessionExit: vi.fn(() => () => {}),
  tapSessionState: vi.fn(() => () => {}),
}));

vi.mock('./pane-registry', () => ({
  getPaneAuthzInfo: vi.fn((paneId: string) => ({
    paneId,
    sessionId: `session:${paneId}`,
    kind: 'cli-agent',
    missionId: 'mission-a',
    role: 'worker',
  })),
  listPaneSnapshots: vi.fn(() => []),
  listVisiblePaneSnapshots: vi.fn(() => []),
  readSessionOutput: vi.fn(() => ''),
  requestPaneClose: vi.fn(async () => true),
  requestPaneSpawn: vi.fn(),
  waitForIdle: vi.fn(async () => 'idle'),
}));

vi.mock('./pane-authz', () => ({
  authorizePaneAccess: vi.fn(() => ({ allow: true })),
}));

import { buildPaneTools } from './tools-panes';

const scope = testProjectScope();

function context(): AgentGateContext {
  return {
    token: 'write-token',
    label: 'writer',
    role: 'orchestrator',
    sessionId: 'session-orchestrator',
    missionId: 'mission-a',
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function tool(name: string) {
  const found = buildPaneTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe('pane write invocation authority', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not write once the exact invocation authority is revoked', async () => {
    await expect(
      tool('nexus_pane_write').handler(
        { paneId: 'pane-a', text: 'forbidden', submit: false },
        context(),
        {
          assertCurrentAuthority: () => {
            throw new Error('session_authority_revoked');
          },
        },
      ),
    ).rejects.toThrow('session_authority_revoked');
    expect(h.write).not.toHaveBeenCalled();
  });

  it('revalidates each write_many iteration and stops before the next write', async () => {
    const invocation = {
      assertCurrentAuthority: () => {
        if (h.write.mock.calls.length > 0) {
          throw new Error('session_authority_revoked');
        }
      },
    };
    await expect(
      tool('nexus_pane_write_many').handler(
        {
          writes: [
            { paneId: 'pane-a', text: 'first', submit: false },
            { paneId: 'pane-b', text: 'second', submit: false },
          ],
        },
        context(),
        invocation,
      ),
    ).rejects.toThrow('session_authority_revoked');
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.write).toHaveBeenCalledWith('session:pane-a', 'first');
  });
});
