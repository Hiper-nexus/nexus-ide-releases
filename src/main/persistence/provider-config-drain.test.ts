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

import { addAccount, initAccountStore, setCooldown } from './account-store';
import { noteLiveIdentity } from './provider-live-identity';
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

/**
 * Ponta a ponta do roteador, com o store de contas REAL, a regra de folga
 * REAL e a atribuição da leitura nativa do AGY. Três contas pessoais, só a
 * identidade viva medida — exatamente a frota do relato, em escala menor.
 */
describe('e2e — carrossel de contas AGY pessoais', () => {
  /** A única leitura que existe: linha NATIVA, sem accountId. */
  function agyNative(usedRatio: number): ProviderQuotaEntry {
    return {
      id: 'agy:native', adapterId: 'agy', label: 'AGY · CLI nativo',
      installed: true, onCooldown: false, updatedAt: NOW,
      windows: [{
        kind: 'hours', label: '5 Horas', usedRatio,
        resetsAt: NOW + 18_000_000, source: 'provider-api', confidence: 'high',
      }],
    } as ProviderQuotaEntry;
  }
  /** Linha da conta do cofre: existe, mas sem janela (o 403 do endpoint). */
  function agyVault(accountId: string): ProviderQuotaEntry {
    return {
      id: `agy:${accountId}`, adapterId: 'agy', accountId, label: accountId,
      installed: true, onCooldown: false, updatedAt: NOW, windows: [],
    } as ProviderQuotaEntry;
  }

  it('drena a, depois b, depois c, e então não sobra conta (a CLI troca)', () => {
    const a = addAcct('agy', 'a');
    const b = addAcct('agy', 'b');
    const c = addAcct('agy', 'c');
    const vault = [agyVault(a.id), agyVault(b.id), agyVault(c.id)];

    // a é a identidade viva e ainda tem folga: fica.
    noteLiveIdentity('agy', a.id);
    quota.entries = [agyNative(0.5), ...vault];
    expect(pickMissionOrchestratorAccountId('agy', a.id)).toBe(a.id);

    // a cruza o limiar: o trabalho novo vai para a irmã mais velha.
    quota.entries = [agyNative(0.9), ...vault];
    expect(pickMissionOrchestratorAccountId('agy', a.id)).toBe(b.id);

    // b assume a identidade e drena: passa para c.
    // NADA de activateAccount aqui: em produção a rotação não mexe na coluna
    // "ativa" (o único chamador é a UI). O spawn é quem sela a identidade.
    noteLiveIdentity('agy', b.id);
    expect(pickMissionOrchestratorAccountId('agy', b.id)).toBe(c.id);

    // c assume e ESGOTA: sem irmã com folga medida, ninguém sobra — é o
    // estado em que performSwitch cai na troca de CLI (F-775 item 2).
    noteLiveIdentity('agy', c.id);
    quota.entries = [agyNative(1), ...vault];
    setCooldown(a.id, NOW + 3_600_000, 'cota medida esgotada');
    setCooldown(b.id, NOW + 3_600_000, 'cota medida esgotada');
    setCooldown(c.id, NOW + 3_600_000, 'cota medida esgotada');
    expect(pickMissionOrchestratorAccountId('agy', c.id)).toBeUndefined();
  });

  it('sem a atribuição da leitura nativa nada drenaria: a linha do cofre é vazia', () => {
    const a = addAcct('agy', 'a');
    const b = addAcct('agy', 'b');
    noteLiveIdentity('agy', a.id);
    // Só as linhas do cofre (o que o 403 deixa): ninguém tem folga medida.
    quota.entries = [agyVault(a.id), agyVault(b.id)];
    expect(pickMissionOrchestratorAccountId('agy', a.id)).toBe(a.id);
  });

  it('a segunda volta do carrossel consome o resto da janela', () => {
    const a = addAcct('agy', 'a');
    const b = addAcct('agy', 'b');
    noteLiveIdentity('agy', a.id);
    // Todas drenando (a identidade viva em 0.9, irmã sem leitura própria):
    // a regra não pode devolver nada — a fatia que resta é usada.
    quota.entries = [agyNative(0.9), agyVault(a.id), agyVault(b.id)];
    const first = pickMissionOrchestratorAccountId('agy', a.id);
    expect(first).toBe(b.id);
    noteLiveIdentity('agy', b.id);
    const second = pickMissionOrchestratorAccountId('agy', b.id);
    expect(second).not.toBeUndefined();
  });
});
