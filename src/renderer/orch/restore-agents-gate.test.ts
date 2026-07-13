/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const holdSpawnUntilApproved = vi.fn();
const markResumeOnSpawn = vi.fn();
const releaseHeldSpawns = vi.fn();
const askConfirm = vi.fn();
const setRestoredPanesHandler = vi.fn();
const orchGet = vi.fn();

vi.mock('../terminal/terminal-host', () => ({
  holdSpawnUntilApproved: (...args: unknown[]) => holdSpawnUntilApproved(...args),
  markResumeOnSpawn: (...args: unknown[]) => markResumeOnSpawn(...args),
  releaseHeldSpawns: (...args: unknown[]) => releaseHeldSpawns(...args),
}));

vi.mock('../state/confirm-store', () => ({
  askConfirm: (...args: unknown[]) => askConfirm(...args),
}));

vi.mock('../state/layout-store', () => ({
  setRestoredPanesHandler: (...args: unknown[]) => setRestoredPanesHandler(...args),
}));

import {
  gateRestoredAgents,
  installRestoredAgentsGate,
  resetRestoredAgentsGate,
  resolveAgentRestoreAction,
} from './restore-agents-gate';

const agent = (id: string, title: string) =>
  ({
    id,
    kind: 'cli-agent' as const,
    title,
    adapterId: 'claude',
    cwd: '/ws',
  }) as const;

const shell = {
  id: 'sh-1',
  kind: 'shell' as const,
  title: 'shell',
  cwd: '/ws',
} as const;

describe('resolveAgentRestoreAction (multi-OS policy)', () => {
  it('defaults unknown values to ask (safe on every platform)', () => {
    expect(resolveAgentRestoreAction('ask')).toBe('ask');
    expect(resolveAgentRestoreAction('pause')).toBe('pause');
    expect(resolveAgentRestoreAction('resume')).toBe('resume');
    expect(resolveAgentRestoreAction('nope' as 'ask')).toBe('ask');
  });
});

describe('restore-agents-gate', () => {
  beforeEach(() => {
    resetRestoredAgentsGate();
    holdSpawnUntilApproved.mockReset();
    markResumeOnSpawn.mockReset();
    releaseHeldSpawns.mockReset();
    askConfirm.mockReset();
    setRestoredPanesHandler.mockReset();
    orchGet.mockReset();
    orchGet.mockResolvedValue({ agentRestorePolicy: 'ask' });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { settings: { orchGet } },
    });
  });

  it('does nothing when the layout has no agents', async () => {
    await gateRestoredAgents([shell]);
    expect(holdSpawnUntilApproved).not.toHaveBeenCalled();
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it('policy ask: holds agents and requires confirm (safe default)', async () => {
    askConfirm.mockResolvedValue(false);
    await gateRestoredAgents([agent('a1', 'Orquestrador'), shell]);

    expect(holdSpawnUntilApproved).toHaveBeenCalledWith('a1');
    expect(askConfirm).toHaveBeenCalledOnce();
    expect(askConfirm.mock.calls[0]?.[0]).toMatchObject({
      confirmLabel: 'Retomar agentes',
      cancelLabel: 'Deixar em pausa',
      danger: true,
    });
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['a1'], { resume: false });
  });

  it('policy pause: never asks, never auto-resumes', async () => {
    orchGet.mockResolvedValue({ agentRestorePolicy: 'pause' });
    await gateRestoredAgents([agent('a1', 'Orq'), agent('a2', 'Worker')]);
    expect(askConfirm).not.toHaveBeenCalled();
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['a1', 'a2'], {
      resume: false,
    });
    expect(holdSpawnUntilApproved).toHaveBeenCalled();
  });

  it('policy resume: silent resume (legacy / power user)', async () => {
    orchGet.mockResolvedValue({ agentRestorePolicy: 'resume' });
    await gateRestoredAgents([agent('a1', 'Orq')]);
    expect(askConfirm).not.toHaveBeenCalled();
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['a1'], { resume: true });
  });

  it('on ask+approve, resumes agents', async () => {
    askConfirm.mockResolvedValue(true);
    await gateRestoredAgents([agent('a1', 'Orq'), agent('a2', 'Worker')]);
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['a1', 'a2'], {
      resume: true,
    });
  });

  it('installRestoredAgentsGate wires the layout restore handler', () => {
    installRestoredAgentsGate();
    expect(setRestoredPanesHandler).toHaveBeenCalledOnce();
  });
});
