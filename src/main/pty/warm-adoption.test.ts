import { describe, expect, it } from 'vitest';
import type { BoundSpawnAuthority } from '../orch/spawn-authority';
import type { SpawnRequest } from '../../shared/types';
import {
  WARM_IDLE_CONTEXT,
  requestMatchesWarmContract,
  warmSessionServes,
} from './warm-adoption';
import type { WarmSession } from './warm-pool';

const scope = {
  rootRealPath: '/work/app',
  projectId: 'p',
  checkoutId: 'c',
  version: '1',
} as unknown as BoundSpawnAuthority['scope'];

function operator(context: Record<string, unknown> = { ...WARM_IDLE_CONTEXT }): BoundSpawnAuthority {
  return {
    source: 'direct-user',
    context: context as unknown as BoundSpawnAuthority['context'],
    scope,
    cwd: '/work/app',
  };
}

const plain = { kind: 'cli-agent', cols: 120, rows: 40 } as SpawnRequest;

describe('requestMatchesWarmContract (F-642)', () => {
  it('serve só o pedido do operador sem missão, restrição nem override', () => {
    expect(requestMatchesWarmContract(plain, {}, operator())).toBe(true);
    expect(requestMatchesWarmContract(plain, { defaultModel: undefined }, operator({}))).toBe(true);
  });

  it('worker de missão, readOnly ou allowlist nunca herdam um processo do operador', () => {
    expect(requestMatchesWarmContract(plain, {}, operator({
      ...WARM_IDLE_CONTEXT, role: 'worker', missionId: 'm1',
    }))).toBe(false);
    expect(requestMatchesWarmContract(plain, {}, operator({
      ...WARM_IDLE_CONTEXT, readOnly: true,
    }))).toBe(false);
    expect(requestMatchesWarmContract(plain, {}, operator({
      ...WARM_IDLE_CONTEXT, allowedTools: ['nexus_pane_read'],
    }))).toBe(false);
    expect(requestMatchesWarmContract(plain, {}, {
      ...operator(), source: 'persisted-pane',
    })).toBe(false);
  });

  it('conta, modelo, pane ou qualquer campo que chega ao processo pede spawn frio', () => {
    expect(requestMatchesWarmContract(plain, { defaultModel: 'opus' }, operator())).toBe(false);
    expect(requestMatchesWarmContract(plain, { keyEnv: { X: '1' } }, operator())).toBe(false);
    expect(requestMatchesWarmContract({ ...plain, paneId: 'pane-2' } as SpawnRequest, {}, operator())).toBe(false);
    expect(requestMatchesWarmContract({ ...plain, model: 'sonnet' } as SpawnRequest, {}, operator())).toBe(false);
    expect(requestMatchesWarmContract({ ...plain, kind: 'shell' } as SpawnRequest, {}, operator())).toBe(false);
  });
});

describe('warmSessionServes (F-642)', () => {
  const warm: WarmSession = {
    sessionId: 's1', startKey: 'sk', cli: 'claude', bornAtMs: 0,
    cwd: '/work/app', scopeRootRealPath: '/work/app',
  };

  it('aceita o pane do mesmo CLI, projeto e cwd', () => {
    expect(warmSessionServes(warm, 'claude', operator(), '/work/app')).toBe(true);
  });

  it('pane warm de outro projeto nunca entra neste (F-634)', () => {
    expect(warmSessionServes({ ...warm, scopeRootRealPath: '/work/other' }, 'claude', operator(), '/work/app')).toBe(false);
    expect(warmSessionServes({ ...warm, cwd: '/work/other' }, 'claude', operator(), '/work/app')).toBe(false);
    expect(warmSessionServes({ ...warm, scopeRootRealPath: undefined }, 'claude', operator(), '/work/app')).toBe(false);
  });

  it('outro CLI ou lease sem startKey não serve', () => {
    expect(warmSessionServes(warm, 'codex', operator(), '/work/app')).toBe(false);
    expect(warmSessionServes({ ...warm, startKey: '' }, 'claude', operator(), '/work/app')).toBe(false);
  });
});
