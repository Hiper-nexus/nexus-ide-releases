import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from './db';
import type { ProviderQuotaEntry } from '../../shared/quota-types';

/**
 * Camada 1 — o lado do Maestro. Store de contas REAL e
 * `pickAvailableForFailover` REAL, alimentados pelas janelas do snapshot.
 * O contrato do spawn sem pin é provado em `provider-config-spawn.test.ts`,
 * que já tem o harness de adapter/credencial montado.
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

import { addAccount, initAccountStore } from './account-store';
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

function weekly(accountId: string, usedRatio: number, adapterId = 'claude'): ProviderQuotaEntry {
  return {
    id: `${adapterId}:${accountId}`, adapterId, accountId, label: accountId,
    installed: true, onCooldown: false, updatedAt: NOW,
    windows: [{
      kind: 'weekly', label: 'Semanal', usedRatio,
      resetsAt: NOW + 86_400_000, source: 'provider-api', confidence: 'high',
    }],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  openDb = makeDb();
  initAccountStore(openDb);
  quota.entries = [];
  delete process.env.NEXUS_ACCOUNT_DRAIN_THRESHOLD;
});

afterEach(() => {
  initAccountStore(null);
  openDb?.close();
  openDb = null;
  delete process.env.NEXUS_ACCOUNT_DRAIN_THRESHOLD;
  vi.useRealTimers();
});

describe('camada 1 — o Maestro respeita a drenagem no respawn', () => {
  it('candidata drenando cede para a irmã com folga', () => {
    const fresh = addAcct('claude', 'fresh');
    const candidate = addAcct('claude', 'candidate');
    quota.entries = [weekly(candidate.id, 0.9), weekly(fresh.id, 0.1)];

    expect(pickMissionOrchestratorAccountId('claude', candidate.id)).toBe(fresh.id);
  });

  it('candidata abaixo do limiar continua fixada', () => {
    const fresh = addAcct('claude', 'fresh');
    const candidate = addAcct('claude', 'candidate');
    quota.entries = [weekly(candidate.id, 0.88), weekly(fresh.id, 0.1)];

    expect(pickMissionOrchestratorAccountId('claude', candidate.id)).toBe(candidate.id);
  });

  it('sem irmã com folga a candidata drenando continua', () => {
    const candidate = addAcct('claude', 'candidate');
    quota.entries = [weekly(candidate.id, 0.9)];

    expect(pickMissionOrchestratorAccountId('claude', candidate.id)).toBe(candidate.id);
  });
});
