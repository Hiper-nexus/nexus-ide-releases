import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

type S = 'idle' | 'busy' | 'spawning' | 'exited' | 'hibernated' | null;
const h = vi.hoisted(() => ({
  write: vi.fn((_sessionId: string, _text: string) => true),
  state: vi.fn((_sessionId: string): S => 'idle'),
}));
vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: h.write,
  orchTerminateSession: vi.fn(async () => true),
  getAgentSessionInfo: vi.fn(() => null),
  getSessionState: h.state,
  tapSessionData: vi.fn(() => () => {}),
  tapSessionExit: vi.fn(() => () => {}),
  tapSessionState: vi.fn(() => () => {}),
  inspectSessionLease: vi.fn(() => null),
  sessionLeaseRegistry: { get: vi.fn(() => null) },
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
import { broadcastSkipReason, buildPaneTools } from './tools-panes';

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
const invocation = { assertCurrentAuthority: () => {} };
function writeMany(writes: Array<Record<string, unknown>>) {
  const tool = buildPaneTools().find((t) => t.name === 'nexus_pane_write_many');
  if (!tool) throw new Error('missing nexus_pane_write_many');
  return tool.handler({ writes }, context(), invocation) as Promise<
    Array<{ paneId: string; ok: boolean; outcome: string; reason?: string; error?: string }>
  >;
}

beforeEach(() => {
  h.write.mockReset().mockReturnValue(true);
  h.state.mockReset().mockImplementation(() => 'idle');
});

describe('broadcast com recibo por alvo (padrão Sidecar)', () => {
  it('entrega a quem pode receber e nomeia, por alvo, por que pulou os outros', async () => {
    h.state.mockImplementation((sessionId: string): S => {
      if (sessionId === 'session:morto') return 'exited';
      if (sessionId === 'session:nascendo') return 'spawning';
      if (sessionId === 'session:dormindo') return 'hibernated';
      if (sessionId === 'session:sumido') return null;
      return 'idle';
    });
    const results = await writeMany([
      { paneId: 'vivo', text: 'parem tudo', submit: false },
      { paneId: 'morto', text: 'parem tudo', submit: false },
      { paneId: 'nascendo', text: 'parem tudo', submit: false },
      { paneId: 'dormindo', text: 'parem tudo', submit: false },
      { paneId: 'sumido', text: 'parem tudo', submit: false },
    ]);
    expect(results).toEqual([
      { paneId: 'vivo', ok: true, outcome: 'submitted' },
      { paneId: 'morto', ok: false, outcome: 'skipped', reason: 'pane_dead' },
      { paneId: 'nascendo', ok: false, outcome: 'skipped', reason: 'agent_not_ready' },
      { paneId: 'dormindo', ok: false, outcome: 'skipped', reason: 'pane_hibernated' },
      { paneId: 'sumido', ok: false, outcome: 'skipped', reason: 'pane_dead' },
    ]);
    // Só o vivo recebeu bytes — um alvo recusado nunca para os irmãos.
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.write).toHaveBeenCalledWith('session:vivo', 'parem tudo', { inputWriter: 'maestro' });
  });

  it('force passa por cima de "não pronto" e "hibernado", nunca de morto', async () => {
    h.state.mockImplementation((sessionId: string): S =>
      sessionId === 'session:morto' ? 'exited' : 'spawning',
    );
    const results = await writeMany([
      { paneId: 'nascendo', text: 'oi', submit: false, force: true },
      { paneId: 'morto', text: 'oi', submit: false, force: true },
    ]);
    expect(results.map((r) => r.outcome)).toEqual(['submitted', 'skipped']);
    expect(results[1]?.reason).toBe('pane_dead');
    expect(h.write).toHaveBeenCalledOnce();
  });

  it('falha de um alvo vira failed com a mensagem, e o lote segue', async () => {
    h.write.mockImplementation((sessionId: string) => {
      if (sessionId === 'session:b') throw new Error('pty fechado');
      return true;
    });
    const results = await writeMany([
      { paneId: 'a', text: 'x', submit: false },
      { paneId: 'b', text: 'x', submit: false },
      { paneId: 'c', text: 'x', submit: false },
    ]);
    expect(results.map((r) => r.outcome)).toEqual(['submitted', 'failed', 'submitted']);
    expect(results[1]?.error).toContain('pty fechado');
  });

  it('a regra pura é explícita sobre cada estado', () => {
    expect(broadcastSkipReason('idle', false)).toBeNull();
    expect(broadcastSkipReason('busy', false)).toBeNull();
    expect(broadcastSkipReason('spawning', false)).toBe('agent_not_ready');
    expect(broadcastSkipReason('hibernated', false)).toBe('pane_hibernated');
    expect(broadcastSkipReason('exited', true)).toBe('pane_dead');
    expect(broadcastSkipReason(null, true)).toBe('pane_dead');
    expect(broadcastSkipReason('spawning', true)).toBeNull();
  });
});
