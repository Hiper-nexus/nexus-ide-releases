import { describe, expect, it, vi } from 'vitest';

const pickCalls: Array<{ adapterId?: string }> = [];
vi.mock('../quota/account-pick', () => ({
  computeAccountPick: async (opts: { adapterId?: string }) => {
    pickCalls.push({ adapterId: opts.adapterId });
    return {
      available: true,
      decidedBy: 'scorer',
      pick: { adapterId: opts.adapterId ?? 'claude', accountId: 'a1' },
      alternatives: [],
      excluded: [],
    } as never;
  },
}));

import { pickAccountTool } from './tools-pick-account';

function ctx(role: 'user' | 'worker' | 'orchestrator' = 'user', providerId?: string) {
  return {
    role,
    sessionId: 's1',
    missionId: null,
    providerId,
    allowedTools: null,
    scope: { rootRealPath: '/tmp', projectId: 'p', checkoutId: 'c', version: '1' },
  } as never;
}

describe('nexus_pick_account', () => {
  it('F-1330: worker asking for another adapter is refused, never silently swapped', async () => {
    pickCalls.length = 0;
    const out = (await pickAccountTool.handler(
      { adapterId: 'codex' },
      ctx('worker', 'claude'),
      undefined,
    )) as { available: boolean; decidedBy: string; reason: string };
    expect(out.available).toBe(false);
    expect(out.reason).toContain('codex');
    expect(out.reason).toContain('claude');
    // and the scorer was never asked about a provider the worker cannot see
    expect(pickCalls).toHaveLength(0);
  });

  it('worker picking its own provider still works', async () => {
    pickCalls.length = 0;
    const out = (await pickAccountTool.handler(
      { adapterId: 'claude' },
      ctx('worker', 'claude'),
      undefined,
    )) as { available: boolean };
    expect(out.available).toBe(true);
    expect(pickCalls).toEqual([{ adapterId: 'claude' }]);
  });

  it('worker with no adapterId keeps its own-provider boundary', async () => {
    pickCalls.length = 0;
    const out = (await pickAccountTool.handler({}, ctx('worker', 'claude'), undefined)) as {
      available: boolean;
    };
    expect(out.available).toBe(true);
    expect(pickCalls).toEqual([{ adapterId: 'claude' }]);
  });

  it('operator may ask for any adapter', async () => {
    pickCalls.length = 0;
    const out = (await pickAccountTool.handler(
      { adapterId: 'codex' },
      ctx('user'),
      undefined,
    )) as { available: boolean };
    expect(out.available).toBe(true);
    expect(pickCalls).toEqual([{ adapterId: 'codex' }]);
  });
});