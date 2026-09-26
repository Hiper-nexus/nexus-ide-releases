import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import type { PaneAuthzInfo } from './pane-authz';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => {
  const panes = new Map<string, PaneAuthzInfo>();
  const outputs = new Map<string, string>();
  return {
    panes,
    outputs,
    getPaneAuthzInfo: vi.fn((ref: string) => panes.get(ref) ?? null),
    readSessionOutput: vi.fn((sessionId: string, _lines?: number) => {
      return outputs.get(sessionId) ?? '';
    }),
    listLivePaneNumbers: vi.fn(() => [] as number[]),
    listPaneSnapshots: vi.fn(() => []),
    listVisiblePaneSnapshots: vi.fn(() => []),
    requestPaneClose: vi.fn(async () => true),
    requestMissionPaneClose: vi.fn(async () => true),
    requestPaneSpawn: vi.fn(),
    waitForIdle: vi.fn(async () => 'idle' as const),
    waitForNextIdle: vi.fn(async () => 'idle' as const),
  };
});

vi.mock('./pane-registry', () => ({
  getPaneAuthzInfo: h.getPaneAuthzInfo,
  listLivePaneNumbers: h.listLivePaneNumbers,
  listPaneSnapshots: h.listPaneSnapshots,
  listVisiblePaneSnapshots: h.listVisiblePaneSnapshots,
  readSessionOutput: h.readSessionOutput,
  requestMissionPaneClose: h.requestMissionPaneClose,
  requestPaneClose: h.requestPaneClose,
  requestPaneSpawn: h.requestPaneSpawn,
  waitForIdle: h.waitForIdle,
  waitForNextIdle: h.waitForNextIdle,
}));

vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: vi.fn(() => true),
  orchTerminateSession: vi.fn(async () => true),
  getAgentSessionInfo: vi.fn(() => null),
  getSessionState: vi.fn(() => 'idle'),
  tapSessionData: vi.fn(() => () => {}),
  tapSessionExit: vi.fn(() => () => {}),
  tapSessionState: vi.fn(() => () => {}),
}));

import { isToolAllowed } from './gate';
import { buildPaneTools } from './tools-panes';

const scope = testProjectScope({ projectId: 'project-a', checkoutId: 'checkout-a' });
const otherScope = testProjectScope({
  projectId: 'project-a',
  checkoutId: 'checkout-b',
});

function context(
  overrides: Partial<AgentGateContext> = {},
): AgentGateContext {
  return {
    token: 'peer-read-token',
    label: 'worker-a',
    role: 'worker',
    sessionId: 'session-a',
    missionId: 'mission-a',
    scope,
    allowedTools: [],
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

function registerPane(info: PaneAuthzInfo, output = ''): void {
  h.panes.set(info.paneId, info);
  if (info.sessionId) {
    h.panes.set(info.sessionId, info);
    h.outputs.set(info.sessionId, output);
  }
}

function tool(name: string) {
  const found = buildPaneTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe('in-mission pane observation (Overclock parity)', () => {
  beforeEach(() => {
    h.panes.clear();
    h.outputs.clear();
    vi.clearAllMocks();
    h.getPaneAuthzInfo.mockImplementation((ref: string) => h.panes.get(ref) ?? null);
    h.readSessionOutput.mockImplementation((sessionId: string) => {
      return h.outputs.get(sessionId) ?? '';
    });
  });

  it('keeps pane observation on the empty-allowlist worker gate', () => {
    expect(isToolAllowed([], 'nexus_pane_read')).toBe(true);
    expect(isToolAllowed([], 'nexus_pane_read_many')).toBe(true);
    expect(isToolAllowed([], 'nexus_pane_list')).toBe(true);
    expect(isToolAllowed([], 'nexus_pane_whoami')).toBe(true);
    expect(isToolAllowed([], 'nexus_pane_write')).toBe(false);
    expect(isToolAllowed([], 'nexus_pane_close')).toBe(false);
  });

  it('teaches the spoken "olha o pane X" path in the tool description', () => {
    expect(tool('nexus_pane_read').description).toMatch(/olha o que o pane/i);
    expect(tool('nexus_pane_read').description).toMatch(/orchestrator|orquestrador|senior/i);
    expect(tool('nexus_pane_read').description).toMatch(/pane 7/);
  });

  it('lets worker A read worker B in the same mission', async () => {
    registerPane({
      paneId: 'pane-b',
      sessionId: 'session-b',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope,
    }, 'worker B is compiling tests');

    await expect(
      tool('nexus_pane_read').handler({ paneId: 'pane-b' }, context()),
    ).resolves.toContain('worker B is compiling tests');
    expect(h.readSessionOutput).toHaveBeenCalledWith('session-b', 200);
  });

  it('lets a worker read the orchestrator/senior pane', async () => {
    registerPane({
      paneId: 'pane-orch',
      sessionId: 'session-orch',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'orchestrator',
      scope,
    }, 'Maestro waiting on handoff');

    await expect(
      tool('nexus_pane_read').handler({ paneId: 'pane-orch' }, context()),
    ).resolves.toContain('Maestro waiting on handoff');
  });

  it('lets the orchestrator read a worker pane', async () => {
    registerPane({
      paneId: 'pane-b',
      sessionId: 'session-b',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope,
    }, 'implementing login');

    await expect(
      tool('nexus_pane_read').handler(
        { paneId: 'pane-b' },
        context({
          role: 'orchestrator',
          sessionId: 'session-orch',
          label: 'maestro',
          allowedTools: null,
        }),
      ),
    ).resolves.toContain('implementing login');
  });

  it('fails closed for an unknown pane', async () => {
    await expect(
      tool('nexus_pane_read').handler({ paneId: 'pane-missing' }, context()),
    ).rejects.toThrow(/unknown pane: pane-missing/);
    expect(h.readSessionOutput).not.toHaveBeenCalled();
  });

  it('tells the agent why a browser pane is gone instead of a bare refusal', async () => {
    // Campo 26/09: sem a pista, o agente concluiu que o Nexus o bloqueou e
    // pediu ao operador para colar um token no chat.
    await expect(
      tool('nexus_pane_read').handler({ paneId: 'browser-gone' }, context()),
    ).rejects.toThrow(
      /unknown pane: browser-gone \(.*project is not open in the Nexus window.*nexus_browser_open/,
    );
  });

  it('refuses a pane from another mission', async () => {
    registerPane({
      paneId: 'pane-foreign',
      sessionId: 'session-foreign',
      kind: 'cli-agent',
      missionId: 'mission-b',
      role: 'worker',
      scope,
    }, 'secret from another mission');

    await expect(
      tool('nexus_pane_read').handler({ paneId: 'pane-foreign' }, context()),
    ).rejects.toThrow(/another mission/);
    expect(h.readSessionOutput).not.toHaveBeenCalled();
  });

  it('refuses a pane from another checkout even with a matching mission id', async () => {
    registerPane({
      paneId: 'pane-other-checkout',
      sessionId: 'session-other-checkout',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope: otherScope,
    }, 'other checkout buffer');

    await expect(
      tool('nexus_pane_read').handler(
        { paneId: 'pane-other-checkout' },
        context(),
      ),
    ).rejects.toThrow(/another project checkout/);
  });

  it('still blocks a worker from reading the user shell', async () => {
    registerPane({
      paneId: 'pane-shell',
      sessionId: 'session-shell',
      kind: 'shell',
      missionId: undefined,
      role: undefined,
      scope,
    }, 'user typed a secret');

    await expect(
      tool('nexus_pane_read').handler({ paneId: 'pane-shell' }, context()),
    ).rejects.toThrow(/shell/);
    expect(h.readSessionOutput).not.toHaveBeenCalled();
  });

  it('still blocks a worker from writing the orchestrator pane', async () => {
    registerPane({
      paneId: 'pane-orch',
      sessionId: 'session-orch',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'orchestrator',
      scope,
    }, 'maestro');

    await expect(
      tool('nexus_pane_write').handler(
        { paneId: 'pane-orch', text: 'injected', submit: false },
        context(),
      ),
    ).rejects.toThrow(/cannot write/);
  });

  it('returns per-item errors from pane_read_many without leaking foreign output', async () => {
    registerPane({
      paneId: 'pane-b',
      sessionId: 'session-b',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope,
    }, 'peer ok');
    registerPane({
      paneId: 'pane-foreign',
      sessionId: 'session-foreign',
      kind: 'cli-agent',
      missionId: 'mission-b',
      role: 'worker',
      scope,
    }, 'should not leak');

    const result = await tool('nexus_pane_read_many').handler(
      { paneIds: ['pane-b', 'pane-foreign', 'pane-missing'] },
      context(),
    );

    expect(result).toEqual([
      { paneId: 'pane-b', output: 'peer ok' },
      {
        paneId: 'pane-foreign',
        error: expect.stringMatching(/another mission/),
      },
      {
        paneId: 'pane-missing',
        error: expect.stringMatching(/unknown pane/),
      },
    ]);
  });
});
