import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  resolveCwdForScope: vi.fn<(_scope: unknown, value?: string) => string>(),
  requestPaneSpawn: vi.fn(async () => ({
    ok: true,
    paneId: 'pane-1',
    sessionId: 'session-1',
  })),
  writeSession: vi.fn(() => true),
  sessionState: vi.fn(() => 'busy'),
  stateTaps: [] as Array<(sessionId: string, state: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
  missionPanesRecord: vi.fn(),
}));

vi.mock('./workspace-path', () => ({ resolveCwdForScope: stubs.resolveCwdForScope }));
vi.mock('./pane-registry', () => ({
  getPaneAuthzInfo: vi.fn(),
  requestPaneClose: vi.fn(() => true),
  requestPaneSpawn: stubs.requestPaneSpawn,
  waitForIdle: vi.fn(async () => 'idle'),
}));
vi.mock('./pane-authz', () => ({ authorizePaneAccess: vi.fn() }));
vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: stubs.writeSession,
  getSessionState: stubs.sessionState,
  tapSessionState: vi.fn((tap: (sessionId: string, state: string) => void) => {
    stubs.stateTaps.push(tap);
    return () => {
      const index = stubs.stateTaps.indexOf(tap);
      if (index >= 0) stubs.stateTaps.splice(index, 1);
    };
  }),
  tapSessionExit: vi.fn((tap: (sessionId: string) => void) => {
    stubs.exitTaps.push(tap);
    return () => {
      const index = stubs.exitTaps.indexOf(tap);
      if (index >= 0) stubs.exitTaps.splice(index, 1);
    };
  }),
}));
vi.mock('../adapters/adapter-registry', () => ({
  getAdapter: vi.fn(() => ({ id: 'codex', kind: 'cli-pty', quirks: {} })),
}));
// Keep the spawn path independent of the host's real credential state.
vi.mock('../pty/pre-spawn-probe', () => ({ assertPreSpawnProbe: vi.fn() }));
vi.mock('./mission-pane-store', () => ({ recordMissionPane: vi.fn() }));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: vi.fn(() => ({
    missionPanes: { record: stubs.missionPanesRecord },
  })),
}));
vi.mock('./legacy-handoff', () => ({ LEGACY_MARKER: 'marker' }));
vi.mock('./ponytail', () => ({ PONYTAIL_RULES: '' }));
vi.mock('./engineering-charter', () => ({ ENGINEERING_CHARTER: '' }));
vi.mock('./design-charter', () => ({ DESIGN_CHARTER: '' }));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: vi.fn(() => ({ leanCode: false, seniorMode: false, designPro: false })),
}));

import {
  deliverAgentPrompt,
  injectPrompt,
  spawnPaneAndMaybePrompt,
  withHandoffContract,
} from './tool-util';
import { testProjectScope } from './__tests__/scope-fixture';

const scope = testProjectScope();

describe('agent pane workspace confinement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.stateTaps.length = 0;
    stubs.exitTaps.length = 0;
    stubs.resolveCwdForScope.mockReturnValue('/workspace');
  });

  it('pins every orchestration spawn to the canonical active workspace', async () => {
    await spawnPaneAndMaybePrompt({ adapterId: 'codex', scope });

    expect(stubs.resolveCwdForScope).toHaveBeenCalledWith(scope, undefined);
    expect(stubs.requestPaneSpawn).toHaveBeenCalledWith({
      adapterId: 'codex',
      cwd: '/workspace',
      executionScope: scope,
      scope,
    });
  });

  it('does not request a pane when no safe workspace can be resolved', async () => {
    stubs.resolveCwdForScope.mockImplementation(() => {
      throw new Error('no workspace open');
    });

    await expect(spawnPaneAndMaybePrompt({ adapterId: 'codex', scope })).rejects.toThrow(
      /no workspace open/,
    );
    expect(stubs.requestPaneSpawn).not.toHaveBeenCalled();
  });

  it('reports the pane before later mission persistence can fail', async () => {
    const onPaneCreated = vi.fn();
    stubs.missionPanesRecord.mockImplementationOnce(() => {
      expect(onPaneCreated).toHaveBeenCalledWith('pane-1', 'session-1');
      throw new Error('database unavailable');
    });

    await expect(
      spawnPaneAndMaybePrompt(
        { adapterId: 'codex', missionId: 'm1', scope },
        { onPaneCreated },
      ),
    ).rejects.toThrow('database unavailable');

    expect(onPaneCreated).toHaveBeenCalledWith('pane-1', 'session-1');
  });
});

describe('worker handoff capability contract', () => {
  it('uses the MCP handoff for every declaratively wired adapter', () => {
    const prompt = withHandoffContract('task', {
      quirks: { nexusMcp: 'opencode' },
    });
    expect(prompt).toContain('nexus_handoff_submit');
    expect(prompt).not.toContain('marker');
  });

  it('keeps Aider operational as a legacy-handoff worker', () => {
    const prompt = withHandoffContract('task', {
      quirks: { nexusMcp: 'none' },
    });
    expect(prompt).toContain('marker');
    expect(prompt).not.toContain('nexus_handoff_submit');
  });
});

describe('agent prompt injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.writeSession.mockReturnValue(true);
    stubs.sessionState.mockReturnValue('busy');
  });

  it('submits multiline briefs as one bracketed-paste transaction', async () => {
    vi.useFakeTimers();
    try {
      // First CR leaves the session idle → second CR retries (boot-menu recovery).
      stubs.sessionState.mockReturnValue('idle');
      const pending = injectPrompt('session-1', 'line one\nline two');
      await vi.advanceTimersByTimeAsync(249);
      expect(stubs.writeSession).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(stubs.writeSession).toHaveBeenNthCalledWith(2, 'session-1', '\r');
      await vi.advanceTimersByTimeAsync(400);
      await pending;

      expect(stubs.writeSession).toHaveBeenNthCalledWith(
        1,
        'session-1',
        '\x1b[200~line one\nline two\x1b[201~',
      );
      expect(stubs.writeSession).toHaveBeenNthCalledWith(2, 'session-1', '\r');
      expect(stubs.writeSession).toHaveBeenNthCalledWith(3, 'session-1', '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips retry Enter once the session turns busy', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('busy');
      const pending = injectPrompt('session-1', 'go');
      await vi.advanceTimersByTimeAsync(650);
      await pending;
      expect(stubs.writeSession).toHaveBeenCalledTimes(2); // paste + one CR
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not duplicate a prompt when a fast busy→idle turn finishes during submit', async () => {
    vi.useFakeTimers();
    try {
      stubs.sessionState.mockReturnValue('idle');
      const pending = deliverAgentPrompt('session-1', 'quick task');
      await vi.advanceTimersByTimeAsync(250);
      expect(stubs.writeSession).toHaveBeenNthCalledWith(2, 'session-1', '\r');

      for (const tap of [...stubs.stateTaps]) tap('session-1', 'busy');
      stubs.sessionState.mockReturnValue('idle');
      for (const tap of [...stubs.stateTaps]) tap('session-1', 'idle');
      await vi.advanceTimersByTimeAsync(400);
      await pending;

      expect(stubs.writeSession).toHaveBeenCalledTimes(2); // prompt + one CR
      expect(stubs.stateTaps).toHaveLength(0);
      expect(stubs.exitTaps).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
