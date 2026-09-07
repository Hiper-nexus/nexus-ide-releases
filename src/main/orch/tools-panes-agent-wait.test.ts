import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';

const harness = vi.hoisted(() => ({
  authorizedSessionIdOf: vi.fn(() => 'session-1'),
  injectPrompt: vi.fn(async () => {}),
  waitForSemanticStatus: vi.fn(
    async (_target: unknown, _options?: unknown): Promise<unknown> => ({
      status: 'completed',
      sessionId: 'session-1',
      paneId: 'pane-1',
      updatedAt: 1,
    }),
  ),
  promptAgentAndWait: vi.fn(
    async (_input: Record<string, unknown>): Promise<unknown> => ({
      submitted: true,
    }),
  ),
}));

vi.mock('./tool-util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tool-util')>()),
  authorizedSessionIdOf: harness.authorizedSessionIdOf,
  injectPrompt: harness.injectPrompt,
}));

vi.mock('./semantic-wait', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./semantic-wait')>()),
  waitForSemanticStatus: harness.waitForSemanticStatus,
  promptAgentAndWait: harness.promptAgentAndWait,
}));

import { SemanticWaitError } from './semantic-wait';
import { buildPaneTools, PANE_WAIT_TIMEOUT_CAP_MS } from './tools-panes';

function context(): AgentGateContext {
  return {
    token: 'token',
    label: 'orchestrator',
    role: 'orchestrator',
    missionId: 'mission-a',
    scope: null,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  } as unknown as AgentGateContext;
}

function tool(name: string) {
  const found = buildPaneTools().find((def) => def.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('nexus_agent_wait', () => {
  it('resolves the target with the same pane authz as nexus_pane_* (wait action)', async () => {
    const result = await tool('nexus_agent_wait').handler(
      { target: 'pane-1', until: ['completed'] },
      context(),
    );

    expect(harness.authorizedSessionIdOf).toHaveBeenCalledWith(
      expect.anything(),
      'pane-1',
      'wait',
    );
    expect(harness.waitForSemanticStatus).toHaveBeenCalledWith(
      { sessionId: 'session-1' },
      expect.objectContaining({ until: ['completed'] }),
    );
    expect(result).toMatchObject({ status: 'completed' });
  });

  it('caps the requested timeout at the MCP transport cap', async () => {
    await tool('nexus_agent_wait').handler(
      { target: 'pane-1', timeoutMs: 9_000_000 },
      context(),
    );

    expect(harness.waitForSemanticStatus).toHaveBeenCalledWith(
      { sessionId: 'session-1' },
      expect.objectContaining({ timeoutMs: PANE_WAIT_TIMEOUT_CAP_MS }),
    );
  });

  it('propagates gate refusals (no wait started)', async () => {
    harness.authorizedSessionIdOf.mockImplementationOnce(() => {
      throw new Error('not authorized: pane outside caller mission');
    });

    await expect(
      tool('nexus_agent_wait').handler({ target: 'pane-9' }, context()),
    ).rejects.toThrow('not authorized');
    expect(harness.waitForSemanticStatus).not.toHaveBeenCalled();
  });
});

describe('nexus_agent_prompt', () => {
  it('maps wait.until / wait.timeout_ms and writes via injectPrompt', async () => {
    harness.promptAgentAndWait.mockResolvedValueOnce({
      submitted: true,
      match: { status: 'completed' },
    });

    const result = (await tool('nexus_agent_prompt').handler(
      {
        target: 'pane-1',
        text: 'hello',
        wait: { until: ['completed'], timeout_ms: 5_000 },
      },
      context(),
    )) as { submitted: boolean };

    expect(harness.authorizedSessionIdOf).toHaveBeenCalledWith(
      expect.anything(),
      'pane-1',
      'write',
    );
    const call = harness.promptAgentAndWait.mock.calls[0]?.[0] as unknown as {
      sessionId: string;
      text: string;
      wait: { until: string[]; timeoutMs: number };
      write: (sessionId: string, text: string) => Promise<void>;
    };
    expect(call.sessionId).toBe('session-1');
    expect(call.text).toBe('hello');
    expect(call.wait).toEqual({ until: ['completed'], timeoutMs: 5_000 });
    // The write closure must route through the existing pane write path.
    await call.write('session-1', 'hello');
    expect(harness.injectPrompt).toHaveBeenCalledWith(
      'session-1',
      'hello',
      undefined,
    );
    expect(result.submitted).toBe(true);
  });

  it('caps wait.timeout_ms at the MCP transport cap', async () => {
    await tool('nexus_agent_prompt').handler(
      { target: 'pane-1', text: 'hi', wait: { timeout_ms: 9_000_000 } },
      context(),
    );

    const call = harness.promptAgentAndWait.mock.calls[0]?.[0] as unknown as {
      wait: { timeoutMs: number };
    };
    expect(call.wait.timeoutMs).toBe(PANE_WAIT_TIMEOUT_CAP_MS);
  });

  it('omits wait entirely for fire-and-forget submission', async () => {
    await tool('nexus_agent_prompt').handler(
      { target: 'pane-1', text: 'hi' },
      context(),
    );

    const call = harness.promptAgentAndWait.mock.calls[0]?.[0] as unknown as {
      wait?: unknown;
    };
    expect(call.wait).toBeUndefined();
  });

  it('surfaces semantic errors with their stable code', async () => {
    harness.promptAgentAndWait.mockRejectedValueOnce(
      new SemanticWaitError('agent_blocked', 'agent is awaiting input'),
    );

    await expect(
      tool('nexus_agent_prompt').handler(
        { target: 'pane-1', text: 'hi', wait: {} },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'agent_blocked' });
  });
});
