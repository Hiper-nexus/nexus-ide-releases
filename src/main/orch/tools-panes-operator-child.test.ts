import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const harness = vi.hoisted(() => ({
  spawnPaneAndMaybePrompt: vi.fn(async (_options: Record<string, unknown>) => ({
    paneId: 'pane-child',
    sessionId: 'pty-child',
  })),
  takePendingPaneSpawnResult: vi.fn((): unknown => null),
}));

vi.mock('./tool-util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tool-util')>()),
  spawnPaneAndMaybePrompt: harness.spawnPaneAndMaybePrompt,
}));
vi.mock('./pane-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pane-registry')>()),
  takePendingPaneSpawnResult: harness.takePendingPaneSpawnResult,
}));

import { paneSpawnTool } from './tools-panes';

function userPane(overrides: Partial<AgentGateContext> = {}): AgentGateContext {
  return {
    token: 'token',
    label: 'pane do operador',
    role: 'user',
    sessionId: 'session-user',
    scope: testProjectScope(),
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

function spawnedRole(): unknown {
  const call = harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0] as
    | { role?: unknown }
    | undefined;
  return call?.role;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Decisão 09/09, opção "panes que você abre herdam a liberdade": o filho do
 * pane do operador sem missão não nasce worker preso — o handler OMITE `role`
 * e o main minta `user` (`mcp-server`: `meta?.role ?? "user"`), então o filho
 * herda o modo vibe e a pane-authz do operador.
 */
describe('nexus_pane_spawn — pane filho da mão do operador', () => {
  it('omite role no spawn ad-hoc (main minta user)', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex' }, userPane());
    expect(harness.spawnPaneAndMaybePrompt).toHaveBeenCalledTimes(1);
    expect(spawnedRole()).toBeUndefined();
    expect(harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0]).toMatchObject({ operatorParentSessionId: 'session-user' });
  });

  it('com missão o caller não é a mão do operador e o role explícito continua', async () => {
    // Orquestrador com missão: a isenção não se aplica (role !== user com
    // missão). O spawn falha antes do PTY por falta de stores reais no teste,
    // mas nunca deve chegar ao mock — prova que a decisão não vazou.
    await expect(
      paneSpawnTool.handler(
        { adapterId: 'codex' },
        userPane({
          role: 'orchestrator',
          label: 'orch',
          sessionId: 'session-orch',
          missionId: 'mission-a',
        }),
      ),
    ).rejects.toBeTruthy();
    expect(harness.spawnPaneAndMaybePrompt).not.toHaveBeenCalled();
  });

  it('expõe o ACK pendente quando a sessão ainda não materializou', async () => {
    harness.spawnPaneAndMaybePrompt.mockRejectedValueOnce(
      new Error('pane spawn pending'),
    );
    harness.takePendingPaneSpawnResult.mockReturnValueOnce({
      requestId: 'orchspawn-pending',
      ok: true,
      paneId: 'pane-pending',
      sessionId: null,
      pending: true,
    });

    const result = await paneSpawnTool.handler(
      { adapterId: 'codex' },
      userPane(),
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({
      ok: true,
      paneId: 'pane-pending',
      sessionId: null,
      pending: true,
    });
  });
});
