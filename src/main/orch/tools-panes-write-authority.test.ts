import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  write: vi.fn(() => true),
}));

vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: h.write,
  orchTerminateSession: vi.fn(async () => true),
  getAgentSessionInfo: vi.fn(() => null),
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
  getPaneRuntimeAuthorityBySession: vi.fn(() => null),
  listPaneSnapshots: vi.fn(() => []),
  listVisiblePaneSnapshots: vi.fn(() => []),
  readSessionOutput: vi.fn(() => ''),
  requestMissionPaneClose: vi.fn(async () => true),
  requestPaneClose: vi.fn(async () => true),
  requestPaneSpawn: vi.fn(),
  waitForIdle: vi.fn(async () => 'idle'),
  waitForNextIdle: vi.fn(async () => 'idle'),
}));

vi.mock('./pane-authz', () => ({
  authorizePaneAccess: vi.fn(() => ({ allow: true })),
}));

import { buildPaneTools } from './tools-panes';
import { getAgentSessionInfo } from '../pty/pty-manager';

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

describe('pane one-shot (F-662)', () => {
  const current = { assertCurrentAuthority: () => {} };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAgentSessionInfo).mockReturnValue(
      { sessionId: 'session:pane-a', adapterId: 'agy', oneShot: true } as never,
    );
  });
  afterEach(() => vi.mocked(getAgentSessionInfo).mockReturnValue(null));

  it('pane_ask responde na hora e não digita no stdin do one-shot', async () => {
    // Campo 28/09 10:07: 45 s de espera e "sem texto novo" num AGY que estava
    // trabalhando — o orquestrador concluiu que a infraestrutura quebrou.
    const result = (await tool('nexus_pane_ask').handler(
      { paneId: 'pane-a', question: 'recebeu a tarefa?' },
      context(),
      current,
    )) as { ok: boolean; state: string; answer: string };
    expect(result).toMatchObject({ ok: false, state: 'oneshot' });
    expect(result.answer).toContain('nexus_pane_wait');
    expect(h.write).not.toHaveBeenCalled();
  });

  it('pane_write ainda entrega, mas o recibo avisa que o one-shot não lê', async () => {
    const result = (await tool('nexus_pane_write').handler(
      { paneId: 'pane-a', text: 'y', submit: false },
      context(),
      current,
    )) as { ok: boolean; oneShot?: string };
    expect(h.write).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.oneShot).toContain('pane one-shot (agy)');
  });
});
