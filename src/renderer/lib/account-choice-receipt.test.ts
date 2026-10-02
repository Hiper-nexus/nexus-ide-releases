/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountChoiceReceipt } from '../../shared/account-choice';
import {
  ACCOUNT_CHOICE_RECEIPT_CACHE_MAX,
  clearAccountChoiceReceiptCache,
  loadAccountChoiceReceipt,
  peekAccountChoiceReceipt,
} from './account-choice-receipt';

const receipt: AccountChoiceReceipt = {
  adapterId: 'claude',
  source: 'headroom-rule',
  account: { label: 'g•••@l•••.com', mode: 'subscription' },
  headroom: { usedPct: 12, window: 'Sessão', resetsAt: null, score: 0.9 },
  alternatives: [],
  decidedAt: 1_759_999_000_000,
};

const get = vi.fn<(sessionId: string) => Promise<unknown>>();

function installBridge(bridge: unknown): void {
  Object.defineProperty(window, 'nexus', { value: bridge, configurable: true, writable: true });
}

describe('loadAccountChoiceReceipt', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue(receipt);
    installBridge({ accountChoice: { get } });
    clearAccountChoiceReceiptCache();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
  });

  it('asks the bridge once per session and serves the cache afterwards', async () => {
    expect(peekAccountChoiceReceipt('s1')).toBeUndefined();
    expect(await loadAccountChoiceReceipt('s1')).toEqual(receipt);
    expect(await loadAccountChoiceReceipt('s1')).toEqual(receipt);
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith('s1');
    expect(peekAccountChoiceReceipt('s1')).toEqual(receipt);
  });

  it('shares one in-flight request between simultaneous callers', async () => {
    const [a, b] = await Promise.all([loadAccountChoiceReceipt('s1'), loadAccountChoiceReceipt('s1')]);
    expect(a).toEqual(receipt);
    expect(b).toEqual(receipt);
    expect(get).toHaveBeenCalledOnce();
  });

  it('keeps sessions apart', async () => {
    get.mockImplementation(async (id) => ({ ...receipt, adapterId: id === 's1' ? 'claude' : 'codex' }));
    expect((await loadAccountChoiceReceipt('s1'))?.adapterId).toBe('claude');
    expect((await loadAccountChoiceReceipt('s2'))?.adapterId).toBe('codex');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not cache "no receipt": a later ask can still find one', async () => {
    get.mockResolvedValueOnce(null);
    expect(await loadAccountChoiceReceipt('s1')).toBeNull();
    expect(peekAccountChoiceReceipt('s1')).toBeUndefined();
    expect(await loadAccountChoiceReceipt('s1')).toEqual(receipt);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('turns a rejected bridge call, a missing bridge and garbage into null — never throws', async () => {
    get.mockRejectedValueOnce(new Error('ipc sender não autorizado'));
    await expect(loadAccountChoiceReceipt('s1')).resolves.toBeNull();

    get.mockResolvedValueOnce({ source: 'vip' });
    await expect(loadAccountChoiceReceipt('s2')).resolves.toBeNull();

    installBridge(undefined);
    await expect(loadAccountChoiceReceipt('s3')).resolves.toBeNull();
    installBridge({});
    await expect(loadAccountChoiceReceipt('s4')).resolves.toBeNull();
  });

  it('re-sanitizes what the bridge returns (defense in depth at the renderer boundary)', async () => {
    get.mockResolvedValueOnce({
      ...receipt,
      accountId: 'acct-9f8c',
      account: { label: 'gabriel@lupygo.com.br', mode: 'subscription' },
    });
    const out = await loadAccountChoiceReceipt('s1');
    expect(out?.account?.label).toBe('g•••@l•••.com.br');
    expect(JSON.stringify(out)).not.toMatch(/gabriel|lupygo|acct-9f8c/);
  });

  it('bounds the cache: the oldest session is forgotten first', async () => {
    for (let i = 0; i < ACCOUNT_CHOICE_RECEIPT_CACHE_MAX + 1; i += 1) {
      await loadAccountChoiceReceipt(`s${i}`);
    }
    expect(peekAccountChoiceReceipt('s0')).toBeUndefined();
    expect(peekAccountChoiceReceipt(`s${ACCOUNT_CHOICE_RECEIPT_CACHE_MAX}`)).toEqual(receipt);
    expect(peekAccountChoiceReceipt('s1')).toEqual(receipt);
  });
});
