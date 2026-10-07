// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: casos de "pools" e
// "pooled account columns" reescritos sobre ProviderQuotaEntry, mais os
// invariantes do Nexus (quotaGroup, desconhecido ≠ 0, janela comparável, seleção intacta).
import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../shared/account-types';
import type { ProviderQuotaEntry, QuotaWindow } from '../../shared/quota-types';
import { pickForAdapter, scoreFleet } from '../../main/quota/smart-pick';
import {
  collectQuotaPools,
  nextPoolRefill,
  poolAccountLabel,
  poolToolLabel,
  type QuotaPool,
} from './quota-pool';

const now = Date.parse('2026-09-03T12:00:00.000Z');
const HOUR = 60 * 60_000;

const fiveHours = (usedRatio: number | null, resetsAt?: number): QuotaWindow => ({
  kind: 'hours',
  label: '5 Horas',
  usedRatio,
  source: usedRatio === null ? 'unknown' : 'provider-api',
  confidence: usedRatio === null ? 'low' : 'high',
  ...(resetsAt !== undefined ? { resetsAt } : {}),
});
const weekly = (usedRatio: number | null, resetsAt?: number): QuotaWindow => ({
  kind: 'weekly',
  label: 'Semanal',
  usedRatio,
  source: usedRatio === null ? 'unknown' : 'provider-api',
  confidence: usedRatio === null ? 'low' : 'high',
  ...(resetsAt !== undefined ? { resetsAt } : {}),
});

function account(
  accountId: string,
  windows: QuotaWindow[],
  extra: Partial<ProviderQuotaEntry> = {},
): ProviderQuotaEntry {
  return {
    id: `claude:${accountId}`,
    adapterId: 'claude',
    accountId,
    label: `Claude · ${accountId}`,
    installed: true,
    onCooldown: false,
    windows,
    updatedAt: now,
    ...extra,
  };
}

/** Conta por coluna em cada linha; null = coluna preservada sem leitura. */
const columns = (pool: QuotaPool) =>
  pool.windows.map((row) => row.columns.map((column) => (column.member ? column.entry.accountId : null)));

describe('collectQuotaPools', () => {
  it('soma por ferramenta só com duas contas ou mais e ordena renovações por chegada', () => {
    const pools = collectQuotaPools(
      [
        account('a', [fiveHours(0.8, now + HOUR), weekly(0.2, now + 72 * HOUR)]),
        account('b', [fiveHours(0.4, now + 3 * HOUR)]),
        { ...account('solo', [weekly(0.5)]), id: 'codex:solo', adapterId: 'codex', label: 'Codex · solo' },
      ],
      now,
    );
    expect(pools.map((pool) => [pool.adapterId, pool.entries.length])).toEqual([['claude', 2]]);
    const [session, week] = pools[0]!.windows;
    expect(session!.label).toBe('5 Horas');
    expect(session!.usedRatio).toBeCloseTo(0.6);
    expect(session!.remainingRatio).toBeCloseTo(0.4);
    expect(session!.resets.map((reset) => [reset.member.entry.accountId, reset.restoresRatio])).toEqual([
      ['a', 0.4],
      ['b', 0.2],
    ]);
    expect(nextPoolRefill(session!)?.member.entry.accountId).toBe('a');
    expect(week!.members.map((member) => member.entry.accountId)).toEqual(['a']);
    expect(week!.remainingRatio).toBeCloseTo(0.8);
  });

  it('conta uma vez a cota compartilhada pela mesma credencial (quotaGroup)', () => {
    const pools = collectQuotaPools(
      [
        account('a', [fiveHours(0.8)], { quotaGroup: 'credencial-1' }),
        account('a-flash', [fiveHours(0.8)], { quotaGroup: 'credencial-1' }),
        account('c', [fiveHours(0.2)]),
      ],
      now,
    );
    expect(pools[0]!.entries.map((entry) => entry.accountId)).toEqual(['a', 'c']);
    expect(pools[0]!.windows[0]!.members).toHaveLength(2);
    // Contada duas vezes a média seria 0,6 usado (0,4 restante).
    expect(pools[0]!.windows[0]!.remainingRatio).toBeCloseTo(0.5);
  });

  it('preserva a coluna da conta sem a janela, sem contá-la na soma', () => {
    const [pool] = collectQuotaPools(
      [
        account('a', [fiveHours(0.5, now + HOUR)]),
        account('b', [fiveHours(0.5, now + 2 * HOUR), weekly(0.8, now + 24 * HOUR)]),
        account('c', [weekly(0.4, now + 48 * HOUR)]),
      ],
      now,
    );
    expect(columns(pool!)).toEqual([
      ['a', 'b', null],
      [null, 'b', 'c'],
    ]);
    expect(pool!.windows[1]!.remainingRatio).toBeCloseTo(0.4);
    expect(pool!.windows[1]!.resets.map((reset) => reset.restoresRatio)).toEqual([0.4, 0.2]);
  });

  it('leitura desconhecida não vira zero nem cheio: coluna vazia e fora da média', () => {
    const [pool] = collectQuotaPools(
      [
        account('a', [fiveHours(0.6, now + HOUR)]),
        account('b', [fiveHours(null)]),
        // A credencial pertence a outra conta: a leitura não é desta linha.
        account('c', [fiveHours(0.9, now + HOUR)], { readHint: 'identity-mismatch' }),
        account('d', [fiveHours(Number.NaN)]),
      ],
      now,
    );
    const row = pool!.windows[0]!;
    expect(row.columns).toHaveLength(4);
    expect(row.members.map((member) => member.entry.accountId)).toEqual(['a']);
    // Desconhecido como 0% usado daria 0,85 restante; como 100%, 0,1.
    expect(row.remainingRatio).toBeCloseTo(0.4);
    expect(row.resets.map((reset) => reset.restoresRatio)).toEqual([0.6]);
  });

  it('não monta conjunto quando nenhuma conta tem leitura', () => {
    expect(
      collectQuotaPools([account('a', [fiveHours(null)]), account('b', [weekly(null)])], now),
    ).toEqual([]);
  });

  it('só soma janelas comparáveis: mesma kind e rótulo, mesmo fornecedor, sem contagem local', () => {
    const tokenPlan: QuotaWindow = {
      kind: 'credits', label: 'Token Plan', usedRatio: 0.5, source: 'provider-api', confidence: 'high',
    };
    const compensation: QuotaWindow = { ...tokenPlan, label: 'Créditos de compensação', usedRatio: 0.1 };
    const monthlyFive: QuotaWindow = { ...fiveHours(0.9), kind: 'monthly' };
    const local: QuotaWindow = {
      kind: 'local', label: 'Projeto', usedRatio: null, source: 'local-tokens', confidence: 'high',
    };
    const pools = collectQuotaPools(
      [
        account('a', [fiveHours(0.4), tokenPlan, local]),
        account('b', [weekly(0.8), compensation, monthlyFive, local]),
        account('glm', [fiveHours(0.1)], { usageProviderId: 'glm' }),
      ],
      now,
    );
    expect(pools).toHaveLength(1);
    const rows = pools[0]!.windows.map((row) => [row.kind, row.label, row.members.length]);
    expect(rows).toEqual([
      ['hours', '5 Horas', 1],
      ['weekly', 'Semanal', 1],
      ['monthly', '5 Horas', 1],
      ['credits', 'Token Plan', 1],
      ['credits', 'Créditos de compensação', 1],
    ]);
    expect(pools[0]!.windows[0]!.remainingRatio).toBeCloseTo(0.6);
    // A conta que lê GLM não entra no conjunto da cota Anthropic.
    expect(pools[0]!.entries.map((entry) => entry.accountId)).toEqual(['a', 'b']);
  });

  it('mantém as colunas pela renovação da janela mais curta, com desempate estável', () => {
    const accounts = [
      account('a', [weekly(0.8, now + 72 * HOUR), fiveHours(0.1, now + 3 * HOUR)]),
      account('b', [weekly(0.2, now + 96 * HOUR), fiveHours(0.9, now + HOUR)]),
      account('z', [fiveHours(0.3)]),
      account('y', [fiveHours(0.3, Number.NaN)]),
    ];
    const [pool] = collectQuotaPools(accounts, now);
    expect(pool!.entries.map((entry) => entry.accountId)).toEqual(['b', 'a', 'y', 'z']);
    expect(columns(pool!)).toEqual([
      ['b', 'a', 'y', 'z'],
      ['b', 'a', null, null],
    ]);
    expect(pool!.windows[1]!.resets.map((reset) => reset.member.entry.accountId)).toEqual(['a', 'b']);
    expect(columns(collectQuotaPools([...accounts].reverse(), now)[0]!)).toEqual(columns(pool!));
  });

  it('ignora renovação já passada e não anuncia devolução de conta intocada', () => {
    const [pool] = collectQuotaPools(
      [account('a', [fiveHours(0, now + HOUR)]), account('b', [fiveHours(0.5, now - HOUR)]), account('c', [fiveHours(0.4, now + 2 * HOUR)])],
      now,
    );
    const row = pool!.windows[0]!;
    expect(row.resets.map((reset) => reset.member.entry.accountId)).toEqual(['a', 'c']);
    expect(nextPoolRefill(row)?.member.entry.accountId).toBe('c');
    expect(nextPoolRefill(row)?.restoresRatio).toBeCloseTo(0.4 / 3);
  });

  it('não altera a escolha de conta nem as linhas de entrada', () => {
    const entries = [
      account('a', [fiveHours(0.7, now + HOUR), weekly(0.3)], { active: true }),
      account('b', [fiveHours(0.2, now + 2 * HOUR), weekly(null)]),
      account('c', [fiveHours(0.2)], { quotaGroup: 'g' }),
      account('c-dup', [fiveHours(0.2)], { quotaGroup: 'g' }),
    ];
    const accounts: AccountInfo[] = entries.map((entry, index) => ({
      id: entry.accountId!, adapterId: 'claude', label: entry.accountId!, mode: 'subscription',
      upstream: 'anthropic', createdAt: index, active: entry.active === true,
      hasCredential: true, onCooldown: false, needsRelogin: false,
    }));
    const frozen = structuredClone(entries);
    const before = scoreFleet(entries, accounts, now);
    collectQuotaPools(entries, now);
    expect(entries).toEqual(frozen);
    expect(scoreFleet(entries, accounts, now)).toEqual(before);
    expect(pickForAdapter(before.ranking, 'claude')?.pick.entryId).toBe('claude:b');
  });

  it('nomeia ferramenta e conta pelo rótulo da linha; sessão nativa é "Conexão atual"', () => {
    const native: ProviderQuotaEntry = {
      ...account('x', [fiveHours(0.1)]), id: 'claude', accountId: undefined, label: 'Claude · CLI nativo',
    };
    const [pool] = collectQuotaPools([account('Trabalho', [fiveHours(0.3)]), native], now);
    expect(poolToolLabel(pool!)).toBe('Claude');
    expect(pool!.entries.map(poolAccountLabel)).toEqual(['Conexão atual', 'Trabalho']);
  });
});
