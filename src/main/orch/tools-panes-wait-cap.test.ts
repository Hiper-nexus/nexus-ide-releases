import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';

const harness = vi.hoisted(() => ({
  waitForIdle: vi.fn(async (_sessionId: string, _timeoutMs?: number) =>
    'timeout' as const,
  ),
  readSessionOutput: vi.fn(() => ''),
  authorizedSessionIdOf: vi.fn(() => 'session-1'),
}));

vi.mock('./pane-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pane-registry')>()),
  readSessionOutput: harness.readSessionOutput,
  waitForIdle: harness.waitForIdle,
}));

vi.mock('./tool-util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tool-util')>()),
  authorizedSessionIdOf: harness.authorizedSessionIdOf,
}));

import { CODEX_MCP_TOOL_TIMEOUT_SEC } from './cli-mcp-inject';
import {
  buildPaneTools,
  PANE_BOOT_TIMEOUT_MS,
  PANE_WAIT_TIMEOUT_CAP_MS,
} from './tools-panes';

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

describe('pane wait timeout cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the per-call cap below the Codex MCP tool timeout', () => {
    expect(PANE_WAIT_TIMEOUT_CAP_MS).toBeLessThan(
      CODEX_MCP_TOOL_TIMEOUT_SEC * 1000,
    );
  });

  it('caps nexus_pane_wait_many so the call returns before the client kills it', async () => {
    const result = (await tool('nexus_pane_wait_many').handler(
      { paneIds: ['pane-1', 'pane-2'], timeoutMs: 300_000 },
      context(),
    )) as Array<{ paneId: string; state: string }>;

    expect(harness.waitForIdle).toHaveBeenCalledTimes(2);
    for (const call of harness.waitForIdle.mock.calls) {
      expect(call[1]).toBe(PANE_WAIT_TIMEOUT_CAP_MS);
    }
    expect(result).toEqual([
      { paneId: 'pane-1', state: 'timeout' },
      { paneId: 'pane-2', state: 'timeout' },
    ]);
  });

  it('caps nexus_pane_wait_idle as boot confirmation, not the MCP tool cap', async () => {
    const result = (await tool('nexus_pane_wait_idle').handler(
      { paneId: 'pane-1', timeoutMs: 120_000 },
      context(),
    )) as { state: string; output: string };

    expect(PANE_BOOT_TIMEOUT_MS).toBe(30_000);
    expect(PANE_BOOT_TIMEOUT_MS).toBeLessThan(PANE_WAIT_TIMEOUT_CAP_MS);
    expect(harness.waitForIdle).toHaveBeenCalledWith(
      'session-1',
      PANE_BOOT_TIMEOUT_MS,
    );
    expect(result.state).toBe('timeout');
  });
});
