import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from './db';

/**
 * Cooldown escopado + espera-pela-irmã + probe-after (entrega C1).
 * Derived from can1357/oh-my-pi@03c48d073 auth-storage cooldown machine (MIT).
 * O DB de teste cria só a tabela accounts — a tabela de blocos nasce do DDL
 * defensivo do próprio store (mesmo caminho de um DB legado em produção).
 */

vi.mock('./secrets-store', () => {
  const secrets = new Map<string, string>();
  return {
    deleteSecret: (key: string) => {
      secrets.delete(key);
      return { ok: true };
    },
    getSecret: (key: string) => secrets.get(key) ?? null,
    hasSecret: (key: string) => secrets.has(key),
    setSecret: (key: string, value: string) => {
      secrets.set(key, value);
      return { ok: true };
    },
  };
});

vi.mock('../adapters/claude-credential', () => ({
  activeClaudeEmail: () => null,
  readActiveClaudeCredential: () => null,
  writeActiveClaudeCredential: vi.fn(() => true),
}));

vi.mock('../adapters/managed-credentials', async () => {
  const actual = await vi.importActual<typeof import('../adapters/managed-credentials')>(
    '../adapters/managed-credentials',
  );
  return {
    ...actual,
    materializeManagedHome: vi.fn(() => '/tmp/managed/test'),
    captureNativeAuth: vi.fn(() => null),
    removeManagedHome: vi.fn(),
  };
});

import {
  addAccount,
  initAccountStore,
  isAccountBlockedForScope,
  pickAvailable,
  pickAvailableForFailover,
  prepareAccountForSpawn,
  setCooldown,
} from './account-store';
import type { Account } from '../../shared/account-types';

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

const NOW = 1_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let openDb: Db | null = null;

function addAcct(label: string): Account {
  return addAccount({
    adapterId: 'claude',
    label,
    mode: 'api-key',
    key: `sk-${label}`,
  });
}

function blockRowCount(): number {
  const row = openDb!
    .prepare('SELECT COUNT(*) AS n FROM account_cooldown_blocks')
    .get() as { n: number };
  return row.n;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  openDb = makeDb();
  initAccountStore(openDb);
});

afterEach(() => {
  initAccountStore(null);
  try {
    openDb?.close();
  } catch {
    // Alguns testes fecham o DB no meio do caminho.
  }
  openDb = null;
  vi.useRealTimers();
});

describe('cooldown escopado (tier)', () => {
  it('bloco tier:fable não impede seleção para sonnet nem seleção global', () => {
    const a = addAcct('a');
    setCooldown(a.id, NOW + MINUTE, 'fable limit', 'tier:fable');

    // Escopado: bloqueia só o próprio tier.
    expect(isAccountBlockedForScope(a.id, NOW, 'tier:fable')).toBe(true);
    expect(isAccountBlockedForScope(a.id, NOW, 'tier:sonnet')).toBe(false);
    expect(isAccountBlockedForScope(a.id, NOW)).toBe(false);

    // Seleção para outro tier ainda enxerga a conta.
    const forSonnet = pickAvailableForFailover('claude', null, NOW, undefined, {
      scope: 'tier:sonnet',
    });
    expect(forSonnet.account?.id).toBe(a.id);
    expect(forSonnet.probe).toBe(false);

    // Seleção legada (sem escopo) idem: bloco escopado não é cooldown global.
    expect(pickAvailable('claude', null, NOW)?.id).toBe(a.id);
    // Spawn direto (sem contexto de modelo) também segue permitido.
    expect(prepareAccountForSpawn('claude', a.id, NOW).ok).toBe(true);

    // Para o tier bloqueado a conta sai do pool (e informa quando libera).
    const forFable = pickAvailableForFailover(
      'claude',
      null,
      NOW,
      undefined,
      { scope: 'tier:fable' },
    );
    expect(forFable.account).toBeNull();
    expect(forFable.nextUnblockAtMs).toBe(NOW + MINUTE);
  });

  it('bloco global impede todos os escopos (comportamento legado)', () => {
    const a = addAcct('a');
    const b = addAcct('b');
    setCooldown(a.id, NOW + MINUTE, 'quota');

    expect(isAccountBlockedForScope(a.id, NOW)).toBe(true);
    expect(isAccountBlockedForScope(a.id, NOW, 'tier:sonnet')).toBe(true);
    const pick = pickAvailableForFailover('claude', null, NOW, undefined, {
      scope: 'tier:sonnet',
    });
    expect(pick.account?.id).toBe(b.id);
  });

  it('escopado usa max(): um retry-after curto não encurta um bloco longo', () => {
    const a = addAcct('a');
    setCooldown(a.id, NOW + 100_000, 'long', 'tier:fable');
    setCooldown(a.id, NOW + 10_000, 'short', 'tier:fable');

    expect(isAccountBlockedForScope(a.id, NOW + 50_000, 'tier:fable')).toBe(
      true,
    );
  });

  it('blocos escopados sobrevivem re-hidratação do SQLite', () => {
    const a = addAcct('a');
    setCooldown(a.id, NOW + MINUTE, 'fable limit', 'tier:fable');

    initAccountStore(openDb);

    expect(isAccountBlockedForScope(a.id, NOW, 'tier:fable')).toBe(true);
    expect(isAccountBlockedForScope(a.id, NOW, 'tier:sonnet')).toBe(false);
  });
});

describe('espera-pela-irmã (nextUnblockAtMs)', () => {
  it('todas bloqueadas → decisão carrega o menor blockedUntil entre as irmãs', () => {
    const a = addAcct('a');
    const b = addAcct('b');
    setCooldown(a.id, NOW + 90_000, 'x');
    setCooldown(b.id, NOW + 30_000, 'y');

    const pick = pickAvailableForFailover('claude', null, NOW);
    expect(pick.account).toBeNull();
    expect(pick.nextUnblockAtMs).toBe(NOW + 30_000);
  });

  it('irmã com bloco só escopado conta como LIVRE para outro tier', () => {
    const a = addAcct('a');
    const b = addAcct('b');
    setCooldown(a.id, NOW + 90_000, 'x');
    setCooldown(b.id, NOW + 30_000, 'fable', 'tier:fable');

    const pick = pickAvailableForFailover('claude', null, NOW, undefined, {
      scope: 'tier:sonnet',
    });
    expect(pick.account?.id).toBe(b.id);
  });
});

describe('probe-after (sondagem last-resort)', () => {
  it('permite UMA sondagem por janela após probeAfter, e só uma', () => {
    const a = addAcct('a');
    setCooldown(a.id, NOW + 12 * HOUR, 'quota');

    // Antes de probeAfter (30min): nada de sondagem.
    const early = pickAvailableForFailover('claude', null, NOW + 10 * MINUTE, undefined, {
      allowProbe: true,
    });
    expect(early.account).toBeNull();
    expect(early.nextUnblockAtMs).toBe(NOW + 12 * HOUR);

    // Depois de probeAfter: uma sondagem controlada.
    const at = NOW + 31 * MINUTE;
    const probe = pickAvailableForFailover('claude', null, at, undefined, {
      allowProbe: true,
    });
    expect(probe.account?.id).toBe(a.id);
    expect(probe.probe).toBe(true);

    // Consumida: segunda tentativa na mesma janela não sonda de novo.
    const again = pickAvailableForFailover('claude', null, at + 1, undefined, {
      allowProbe: true,
    });
    expect(again.account).toBeNull();

    // O consumo é durável (persistido no SQLite).
    initAccountStore(openDb);
    const afterRehydrate = pickAvailableForFailover(
      'claude',
      null,
      at + 2,
      undefined,
      { allowProbe: true },
    );
    expect(afterRehydrate.account).toBeNull();
  });

  it('re-marcação do bloco reabre a janela de sondagem 30min depois', () => {
    const a = addAcct('a');
    setCooldown(a.id, NOW + 12 * HOUR, 'quota');
    const firstProbeAt = NOW + 31 * MINUTE;
    expect(
      pickAvailableForFailover('claude', null, firstProbeAt, undefined, {
        allowProbe: true,
      }).probe,
    ).toBe(true);

    // A sondagem falhou → detector re-marca o cooldown (nova janela).
    vi.setSystemTime(firstProbeAt);
    setCooldown(a.id, firstProbeAt + 12 * HOUR, 'quota again');

    // Logo depois da re-marcação: sem sondagem (probeAfter ainda no futuro).
    expect(
      pickAvailableForFailover('claude', null, firstProbeAt + MINUTE, undefined, {
        allowProbe: true,
      }).account,
    ).toBeNull();

    // 31min após a re-marcação: nova janela, nova sondagem única.
    expect(
      pickAvailableForFailover(
        'claude',
        null,
        firstProbeAt + 31 * MINUTE,
        undefined,
        { allowProbe: true },
      ).probe,
    ).toBe(true);
  });

  it('sondagem exige opt-in do prepare para conta ainda em cooldown', () => {
    const a = addAcct('a');
    setCooldown(a.id, NOW + 12 * HOUR, 'quota');

    const denied = prepareAccountForSpawn('claude', a.id, NOW + HOUR);
    expect(denied.ok).toBe(false);

    const allowed = prepareAccountForSpawn('claude', a.id, NOW + HOUR, {
      allowCoolingProbe: true,
    });
    expect(allowed.ok).toBe(true);
  });
});

describe('restauração automática ao expirar', () => {
  it('cooldown global expirado devolve a conta ao pool e limpa o bloco', () => {
    const a = addAcct('a');
    setCooldown(a.id, NOW + MINUTE, 'x');
    expect(blockRowCount()).toBe(1);

    const after = pickAvailableForFailover('claude', null, NOW + MINUTE + 1);
    expect(after.account?.id).toBe(a.id);
    expect(after.probe).toBe(false);
    // Limpeza preguiçosa removeu a linha espelhada.
    expect(blockRowCount()).toBe(0);
  });

  it('bloco escopado expirado libera o tier de volta', () => {
    const a = addAcct('a');
    setCooldown(a.id, NOW + MINUTE, 'fable', 'tier:fable');
    expect(isAccountBlockedForScope(a.id, NOW, 'tier:fable')).toBe(true);

    expect(
      isAccountBlockedForScope(a.id, NOW + MINUTE + 1, 'tier:fable'),
    ).toBe(false);
    const pick = pickAvailableForFailover(
      'claude',
      null,
      NOW + MINUTE + 1,
      undefined,
      { scope: 'tier:fable' },
    );
    expect(pick.account?.id).toBe(a.id);
  });
});
