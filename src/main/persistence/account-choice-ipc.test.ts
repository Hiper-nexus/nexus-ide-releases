import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (name: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(name, fn),
}));

import type { AccountChoiceReceipt } from '../../shared/account-choice';
import { ACCOUNT_CHOICE_CHANNELS } from '../../shared/account-choice-channels';
import { registerAccountChoiceIpc } from './account-choice-ipc';

const receipt: AccountChoiceReceipt = {
  adapterId: 'claude',
  source: 'headroom-rule',
  account: { label: 'g•••@l•••.com', mode: 'subscription' },
  headroom: { usedPct: 12, window: 'Sessão', resetsAt: 1_760_000_000_000, score: 0.88 },
  alternatives: [
    { label: 'x•••@y•••.com', usedPct: 44, window: 'Semanal', resetsAt: null, skipped: 'less-headroom' },
  ],
  decidedAt: 1_759_999_000_000,
};

function call(...args: unknown[]): Promise<unknown> {
  const handler = h.handlers.get(ACCOUNT_CHOICE_CHANNELS.get);
  if (!handler) throw new Error('no handler for accountChoice:get');
  return Promise.resolve(handler({}, ...args));
}

describe('registerAccountChoiceIpc', () => {
  beforeEach(() => {
    h.handlers.clear();
  });

  it('registers only the read channel, behind the trusted-sender guard', () => {
    registerAccountChoiceIpc(() => undefined);
    expect([...h.handlers.keys()]).toEqual([ACCOUNT_CHOICE_CHANNELS.get]);
  });

  it('returns the receipt of the requested session, and asks the store for exactly that id', async () => {
    const lookup = vi.fn((_sessionId: string) => receipt as AccountChoiceReceipt | undefined);
    registerAccountChoiceIpc(lookup);
    expect(await call({ sessionId: 'sess-1' })).toEqual(receipt);
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith('sess-1');
  });

  it('returns null for an unknown session', async () => {
    registerAccountChoiceIpc(() => undefined);
    expect(await call({ sessionId: 'nunca-existiu' })).toBeNull();
  });

  it('refuses malformed payloads (strict schema) without touching the store', async () => {
    const lookup = vi.fn(() => receipt);
    registerAccountChoiceIpc(lookup);
    const refused: unknown[] = [
      undefined,
      null,
      42,
      'sess-1',
      [],
      ['sess-1'],
      {},
      { sessionId: '' },
      { sessionId: 42 },
      { sessionId: null },
      { sessionId: 'sess-1', extra: true },
      { sessionId: 'sess-1', accountId: 'acct-1' },
      { sessionId: 'x'.repeat(129) },
      { sessionId: 'x'.repeat(100_000) },
    ];
    for (const bad of refused) expect(await call(bad)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('accepts a session id at the size limit', async () => {
    const lookup = vi.fn(() => receipt);
    registerAccountChoiceIpc(lookup);
    expect(await call({ sessionId: 'x'.repeat(128) })).toEqual(receipt);
  });

  it('sanitizes what the store holds: raw label, extra keys and hostile text never cross the IPC', async () => {
    const leaky = {
      ...receipt,
      accountId: 'acct-9f8c',
      sessionFingerprint: 'fp-secret',
      account: { label: 'gabriel@lupygo.com.br', mode: 'subscription', id: 'acct-9f8c' },
      alternatives: [{ ...receipt.alternatives[0], label: 'ana.silva@gmail.com', fingerprint: 'fp-b' }],
      note: 'abrindo na ativa gabriel@lupygo.com.br',
    };
    registerAccountChoiceIpc(() => leaky as unknown as AccountChoiceReceipt);
    const out = await call({ sessionId: 'sess-1' });
    const json = JSON.stringify(out);
    for (const leak of ['gabriel', 'lupygo', 'silva', 'gmail', 'acct-9f8c', 'fp-secret', 'fp-b']) {
      expect(json).not.toContain(leak);
    }
    expect(out).toMatchObject({ account: { label: 'g•••@l•••.com.br' } });
  });

  it('returns null when the stored receipt is not a valid receipt', async () => {
    registerAccountChoiceIpc(() => ({ source: 'vip' }) as unknown as AccountChoiceReceipt);
    expect(await call({ sessionId: 'sess-1' })).toBeNull();
  });

  it('is wired into the main-process bootstrap, like the other IPC registrations', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
    expect(source).toContain('registerAccountChoiceIpc } from "./persistence/account-choice-ipc"');
    // Passos do boot ficam protegidos por bootStep (falha de git não derruba o app).
    expect(source).toMatch(/bootStep\('registerAccountChoiceIpc', \(\) => registerAccountChoiceIpc\(\)\);/);
  });

  it('never throws, even if the store does', async () => {
    registerAccountChoiceIpc(() => {
      throw new Error('boom com segredo sk-ant-xyz');
    });
    await expect(call({ sessionId: 'sess-1' })).resolves.toBeNull();
  });
});
