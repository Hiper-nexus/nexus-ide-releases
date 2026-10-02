import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (name: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(name, fn),
}));

import { JEV_CHANNELS } from '../../shared/jev-channels';
import type { MissionPickRequest, MissionPickResult } from '../../shared/mission-pick';
import { registerMissionPickIpc } from './jev-mission-pick-ipc';
import { pickMissionWithJev } from './jev-mission-pick';

const valid: MissionPickRequest = {
  spoken: 'site da loja',
  candidates: [
    { title: 'Site da loja', state: 'running', updatedAt: 1_700_000_000_000 },
    { title: 'Site da loja v2', state: 'completed', updatedAt: 1_699_999_000_000 },
  ],
};

function call(...args: unknown[]): Promise<unknown> {
  const handler = h.handlers.get(JEV_CHANNELS.missionPick);
  if (!handler) throw new Error('no handler registered');
  return Promise.resolve(handler({}, ...args));
}

describe('registerMissionPickIpc', () => {
  beforeEach(() => {
    h.handlers.clear();
  });

  it('registers exactly one channel, behind the trusted-sender guard', () => {
    registerMissionPickIpc(vi.fn());
    expect([...h.handlers.keys()]).toEqual([JEV_CHANNELS.missionPick]);
    expect(JEV_CHANNELS.missionPick).toBe('jev:missionPick');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a string', 'oi'],
    ['an empty object', {}],
    ['an unknown key', { ...valid, extra: true }],
    ['a real id inside a candidate', { ...valid, candidates: [{ ...valid.candidates[0], id: 'mission-9' }, valid.candidates[1]] }],
    ['a single candidate', { ...valid, candidates: [valid.candidates[0]] }],
    ['six candidates', { ...valid, candidates: Array.from({ length: 6 }, () => valid.candidates[0]) }],
  ])('refuses %s with a typed answer, never reaching the model', async (_label, payload) => {
    const pick = vi.fn();
    registerMissionPickIpc(pick);
    expect(await call(payload)).toEqual({ decision: 'undecided', reason: 'invalid-request' });
    expect(pick).not.toHaveBeenCalled();
  });

  it('accepts a no-match request with one to eight candidates and refuses nine or none', async () => {
    const answer: MissionPickResult = { decision: 'undecided', reason: 'none' };
    const pick = vi.fn(async () => answer);
    registerMissionPickIpc(pick);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Missão ${i}`, state: 'running' }));
    for (const n of [1, 8]) {
      expect(await call({ kind: 'noMatch', spoken: 'sait da lója', candidates: many(n) })).toEqual(answer);
    }
    expect(pick).toHaveBeenCalledTimes(2);
    expect(await call({ kind: 'noMatch', spoken: 'sait da lója', candidates: many(9) })).toEqual({ decision: 'undecided', reason: 'invalid-request' });
    expect(await call({ kind: 'noMatch', spoken: 'sait da lója', candidates: [] })).toEqual({ decision: 'undecided', reason: 'invalid-request' });
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it('hands the parsed request to the picker and returns its answer', async () => {
    const answer: MissionPickResult = { decision: 'picked', index: 1, confidence: 0.9 };
    const pick = vi.fn(async () => answer);
    registerMissionPickIpc(pick);
    expect(await call(valid)).toEqual(answer);
    expect(pick).toHaveBeenCalledWith(valid);
  });

  it('turns a crash into a typed answer that carries no error text', async () => {
    registerMissionPickIpc(async () => {
      throw new Error('boom sk-abcdefghijklmnopqrstuvwxyz012345 /Users/ana/loja');
    });
    const result = await call(valid);
    expect(result).toEqual({ decision: 'undecided', reason: 'error' });
    expect(JSON.stringify(result)).not.toContain('sk-');
    expect(JSON.stringify(result)).not.toContain('/Users/ana');
  });

  it('fails open end to end without a key: no model call, a typed "no decision"', async () => {
    const judge = vi.fn();
    registerMissionPickIpc((request) =>
      pickMissionWithJev(request, {
        judge: judge as never,
        surfaceEnabled: () => true,
        hasKey: () => false,
        consumeRate: () => true,
        record: vi.fn(),
        now: () => 1_700_000_000_000,
      }),
    );
    expect(await call(valid)).toEqual({ decision: 'undecided', reason: 'unavailable' });
    expect(judge).not.toHaveBeenCalled();
  });
});
