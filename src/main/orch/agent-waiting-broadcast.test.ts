import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import type { AgentStatusState } from '../../shared/agent-status-types';
import type { AgentSemanticStatusEntry } from './agent-status';

const { semanticTaps, orcaTaps, sessionInfo } = vi.hoisted(() => ({
  semanticTaps: new Set<(entry: AgentSemanticStatusEntry) => void>(),
  orcaTaps: new Set<(sessionId: string, state: AgentStatusState) => void>(),
  sessionInfo: vi.fn(),
}));

vi.mock('./agent-status', () => ({
  tapAgentSemanticStatus: (cb: (entry: AgentSemanticStatusEntry) => void) => {
    semanticTaps.add(cb);
    return () => semanticTaps.delete(cb);
  },
}));

vi.mock('../agent-hooks/hook-ingest', () => ({
  tapAgentHookStatus: (
    cb: (sessionId: string, state: AgentStatusState) => void,
  ) => {
    orcaTaps.add(cb);
    return () => orcaTaps.delete(cb);
  },
}));

vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: (sessionId: string) => sessionInfo(sessionId),
}));

function renderer(): WebContents & { send: ReturnType<typeof vi.fn> } {
  return {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
}

describe('agent-waiting-broadcast', () => {
  let wc: ReturnType<typeof renderer>;

  beforeEach(async () => {
    semanticTaps.clear();
    orcaTaps.clear();
    sessionInfo.mockReset();
    const mod = await import('./agent-waiting-broadcast');
    mod.shutdownAgentWaitingBroadcast();
    wc = renderer();
    mod.registerAgentWaitingTarget(wc);
    mod.initAgentWaitingBroadcast();
  });

  afterEach(async () => {
    const mod = await import('./agent-waiting-broadcast');
    mod.unregisterAgentWaitingTarget(wc);
    mod.shutdownAgentWaitingBroadcast();
  });

  it('encaminha awaiting-input semântico com paneId e rótulo', async () => {
    sessionInfo.mockReturnValue({
      paneId: 'pane-1',
      agentName: 'Claude',
      adapterId: 'claude',
    });
    for (const tap of semanticTaps) {
      tap({
        status: 'awaiting-input',
        sessionId: 's1',
        paneId: 'pane-1',
        updatedAt: 42,
      });
    }
    expect(wc.send).toHaveBeenCalledWith(ORCH_CHANNELS.agentWaiting, {
      source: 'semantic',
      sessionId: 's1',
      paneId: 'pane-1',
      agentLabel: 'Claude',
      state: 'awaiting-input',
      at: 42,
    });
  });

  it('encaminha waiting orca só quando o PTY tem pane', async () => {
    sessionInfo.mockReturnValueOnce(null);
    for (const tap of orcaTaps) tap('ghost', 'waiting');
    expect(wc.send).not.toHaveBeenCalled();

    sessionInfo.mockReturnValue({
      paneId: 'pane-2',
      agentName: '',
      adapterId: 'codex',
    });
    for (const tap of orcaTaps) tap('s2', 'waiting');
    expect(wc.send).toHaveBeenCalledWith(
      ORCH_CHANNELS.agentWaiting,
      expect.objectContaining({
        source: 'orca',
        sessionId: 's2',
        paneId: 'pane-2',
        agentLabel: 'codex',
        state: 'waiting',
      }),
    );
  });
});
