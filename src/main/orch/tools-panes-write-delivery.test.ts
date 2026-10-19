import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import { __resetAgentStatusForTests } from './agent-status';

type WriteMode = 'prove' | 'silent' | 'die-on-enter' | 'busy';

const h = vi.hoisted(() => ({
  state: 'idle' as 'idle' | 'busy' | 'exited' | null,
  mode: 'prove' as WriteMode,
  writes: [] as Array<{ data: string; inputWriter?: string }>,
  stateTaps: [] as Array<(sessionId: string, state: string) => void>,
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
}));

vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: (sessionId: string, data: string, options?: { inputWriter?: string }) => {
    if (h.state === null) return false;
    h.writes.push({ data, inputWriter: options?.inputWriter });
    if (data === '\r' || data === '\r\n') {
      if (h.mode === 'die-on-enter') {
        h.state = null;
        return false;
      }
      if (h.mode === 'prove') {
        h.state = 'busy';
        for (const tap of [...h.stateTaps]) tap(sessionId, 'busy');
        for (const tap of [...h.dataTaps]) tap(sessionId, 'turn');
      }
    }
    return true;
  },
  orchTerminateSession: vi.fn(async () => true),
  getAgentSessionInfo: vi.fn(() => ({
    sessionId: 'session:pane-a',
    paneId: 'pane-a',
    adapterId: 'codex',
  })),
  getSessionState: () => h.state,
  isOneShotSessionRunning: () => false,
  inspectSessionLease: () => null,
  sessionLeaseRegistry: { get: () => null },
  tapSessionData: (tap: (sessionId: string, data: string) => void) => {
    h.dataTaps.push(tap);
    return () => {
      const index = h.dataTaps.indexOf(tap);
      if (index >= 0) h.dataTaps.splice(index, 1);
    };
  },
  tapSessionExit: () => () => {},
  tapSessionState: (tap: (sessionId: string, state: string) => void) => {
    h.stateTaps.push(tap);
    return () => {
      const index = h.stateTaps.indexOf(tap);
      if (index >= 0) h.stateTaps.splice(index, 1);
    };
  },
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
import { clearAdaptiveEnterTimers, injectSubmittedPaneWrite } from './tool-util';

const scope = testProjectScope();
const current = { assertCurrentAuthority: () => {} };

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

function tool() {
  const found = buildPaneTools().find((candidate) => candidate.name === 'nexus_pane_write');
  if (!found) throw new Error('missing nexus_pane_write');
  return found;
}

describe('nexus_pane_write delivery', () => {
  afterEach(() => {
    clearAdaptiveEnterTimers();
    __resetAgentStatusForTests();
    h.state = 'idle';
    h.mode = 'prove';
    h.writes = [];
    h.stateTaps = [];
    h.dataTaps = [];
  });

  it('prova o turno quando o pane está injetável-idle', async () => {
    const result = await tool().handler(
      { paneId: 'pane-a', text: 'siga' },
      context(),
      current,
    );
    expect(result).toMatchObject({ ok: true, delivery: 'entregue' });
    expect(h.writes.some((write) => write.data.includes('siga') && write.inputWriter === 'maestro')).toBe(true);
    expect(h.writes.some((write) => write.data === '\r' && write.inputWriter === 'maestro')).toBe(true);
  });

  it('sem prova de turno quando o pane não está idle', async () => {
    h.state = 'busy';
    h.mode = 'busy';
    const result = await tool().handler(
      { paneId: 'pane-a', text: 'siga' },
      context(),
      current,
    );
    expect(result).toMatchObject({ ok: true, delivery: 'sem-prova-de-turno' });
  });

  it('pane finalizado quando o Enter não chega a uma sessão que saiu', async () => {
    h.mode = 'die-on-enter';
    const result = await tool().handler(
      { paneId: 'pane-a', text: 'siga' },
      context(),
      current,
    );
    expect(result).toMatchObject({ ok: true, delivery: 'pane-finalizado' });
  });

  it('bytes sem aceite viram sem-prova-de-turno na janela curta', async () => {
    h.mode = 'silent';
    const delivery = await injectSubmittedPaneWrite(
      'session:pane-a',
      'siga',
      current,
      'nexus',
      40,
    );
    expect(delivery).toBe('sem-prova-de-turno');
  });

  it('submit false continua ok e não espera prova de turno', async () => {
    const result = await tool().handler(
      { paneId: 'pane-a', text: 'y', submit: false },
      context(),
      current,
    );
    expect(result).toMatchObject({ ok: true, delivery: 'sem-prova-de-turno' });
    expect(h.writes).toEqual([{ data: 'y', inputWriter: 'maestro' }]);
  });

  it('autoridade revogada continua lançando', async () => {
    await expect(tool().handler(
      { paneId: 'pane-a', text: 'forbidden' },
      context(),
      { assertCurrentAuthority: () => { throw new Error('session_authority_revoked'); } },
    )).rejects.toThrow('session_authority_revoked');
    expect(h.writes).toEqual([]);
  });
});
