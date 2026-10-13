import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from './db';
import type { ProviderQuotaEntry } from '../../shared/quota-types';

/**
 * F-1470: escolha da conta do Maestro com o store de contas REAL e o
 * `pickAvailableForFailover` REAL, alimentado pelas janelas de cota do
 * snapshot (as mesmas que a regra de folga do spawn sem pin usa).
 */

vi.mock('./secrets-store', async importOriginal => {
  const secrets = new Map<string, string>();
  return {
    ...await importOriginal<typeof import('./secrets-store')>(),
    listSecretKeys: () => [...secrets.keys()],
    deleteSecret: (key: string) => { secrets.delete(key); return { ok: true }; },
    getSecret: (key: string) => secrets.get(key) ?? null,
    hasSecret: (key: string) => secrets.has(key),
    setSecret: (key: string, value: string) => { secrets.set(key, value); return { ok: true }; },
  };
});

vi.mock('../adapters/claude-credential', () => ({
  activeClaudeEmail: () => null,
  readActiveClaudeCredential: () => null,
  readActiveClaudeCredentialSlim: () => null,
  slimClaudeCredentialBlob: () => null,
  claudeCredentialBlobIsUsable: () => false,
  writeActiveClaudeCredential: vi.fn(() => true),
}));

const quota = vi.hoisted(() => ({ entries: [] as unknown[] }));
vi.mock('../quota/quota-service', async importOriginal => ({
  ...await importOriginal<typeof import('../quota/quota-service')>(),
  requireQuotaService: () => ({ lastSnapshot: () => ({ entries: quota.entries }) }),
}));

import { addAccount, initAccountStore, setCooldown } from './account-store';
import { pickMissionOrchestratorAccountId } from './provider-config-store';

const NOW = 1_000_000;
let openDb: Db | null = null;

function makeDb(): Db {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (
      id             TEXT PRIMARY KEY,
      adapter_id     TEXT NOT NULL,
      label          TEXT NOT NULL,
      mode           TEXT NOT NULL,
      upstream       TEXT NOT NULL DEFAULT 'anthropic',
      email          TEXT,
      cooldown_until INTEGER,
      last_error     TEXT,
      active          INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL
    );
  `);
  return db as unknown as Db;
}

function addAcct(adapterId: string, label: string) {
  vi.setSystemTime(Date.now() + 1_000);
  return addAccount({ adapterId, label, mode: 'api-key', key: `sk-${label}` });
}

function weekly(accountId: string, usedRatio: number): ProviderQuotaEntry {
  return {
    id: `claude:${accountId}`, adapterId: 'claude', accountId, label: accountId, installed: true, onCooldown: false, updatedAt: NOW,
    windows: [{ kind: 'weekly', label: 'Semanal', usedRatio, resetsAt: NOW + 86_400_000, source: 'provider-api', confidence: 'high' }],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  openDb = makeDb();
  initAccountStore(openDb);
  quota.entries = [];
});

afterEach(() => {
  initAccountStore(null);
  openDb?.close();
  openDb = null;
  vi.useRealTimers();
});

describe('pickMissionOrchestratorAccountId (F-1470)', () => {
  it('linha utilizável fica, mesmo com irmã mais folgada; em cooldown, vence a irmã com folga medida; nenhuma → undefined', () => {
    // A última criada fica ativa: a irmã esgotada (100% na Semanal). Sem as
    // janelas de cota a regra manteria a ativa; com elas, a irmã livre vence.
    const row = addAcct('claude', 'row');
    const free = addAcct('claude', 'free');
    const exhausted = addAcct('claude', 'exhausted');
    quota.entries = [weekly(row.id, 0.87), weekly(free.id, 0.1), weekly(exhausted.id, 1)];

    expect(pickMissionOrchestratorAccountId('claude', row.id)).toBe(row.id);

    setCooldown(row.id, Date.now() + 3_600_000, '429 weekly limit reached');
    expect(pickMissionOrchestratorAccountId('claude', row.id)).toBe(free.id);

    setCooldown(free.id, Date.now() + 3_600_000, '429 weekly limit reached');
    setCooldown(exhausted.id, Date.now() + 3_600_000, '429 weekly limit reached');
    expect(pickMissionOrchestratorAccountId('claude', row.id)).toBeUndefined();
  });

  it('candidata de outro provider ou desconhecida não é fixada; sem candidata vale a regra de folga', () => {
    const foreign = addAcct('codex', 'foreign');
    const free = addAcct('claude', 'free');
    const tight = addAcct('claude', 'tight');
    quota.entries = [weekly(free.id, 0.2), weekly(tight.id, 1)];

    expect(pickMissionOrchestratorAccountId('claude', foreign.id)).toBe(free.id);
    expect(pickMissionOrchestratorAccountId('claude', 'acct-removed')).toBe(free.id);
    expect(pickMissionOrchestratorAccountId('claude', undefined)).toBe(free.id);
    expect(pickMissionOrchestratorAccountId('gemini', undefined)).toBeUndefined();
  });
});
