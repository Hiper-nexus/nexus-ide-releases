import { describe, expect, it } from 'vitest';

import type { AccountInfo } from '../../shared/account-types';
import type { ProviderQuotaEntry, QuotaWindow } from '../../shared/quota-types';
import {
  RESET_PROXIMITY_WINDOW_MS,
  effectiveUsedRatio,
  pickForAdapter,
  scoreFleet,
} from './smart-pick';

const NOW = 1_800_000_000_000;

function win(
  label: string,
  usedRatio: number | null,
  resetsAt?: number,
): QuotaWindow {
  return {
    kind: 'hours',
    label,
    usedRatio,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    source: 'provider-api',
    confidence: 'high',
  };
}

function entry(
  id: string,
  windows: QuotaWindow[],
  opts?: {
    accountId?: string;
    active?: boolean;
    onCooldown?: boolean;
    updatedAt?: number;
  },
): ProviderQuotaEntry {
  return {
    id,
    adapterId: id.split(':')[0],
    ...(opts?.accountId ? { accountId: opts.accountId } : {}),
    ...(opts?.active !== undefined ? { active: opts.active } : {}),
    label: id,
    installed: true,
    onCooldown: opts?.onCooldown ?? false,
    windows,
    updatedAt: opts?.updatedAt ?? NOW,
  };
}

function account(
  id: string,
  opts?: { hasCredential?: boolean; needsRelogin?: boolean; email?: string },
): AccountInfo {
  return {
    id,
    adapterId: 'claude',
    label: id,
    mode: 'subscription',
    upstream: 'anthropic',
    ...(opts?.email ? { email: opts.email } : {}),
    createdAt: NOW,
    active: false,
    hasCredential: opts?.hasCredential ?? true,
    onCooldown: false,
    needsRelogin: opts?.needsRelogin ?? false,
  } as AccountInfo;
}

describe('effectiveUsedRatio', () => {
  it('janela desconhecida nunca vira folga (null)', () => {
    expect(effectiveUsedRatio(win('5h', null), NOW)).toBeNull();
  });

  it('sem reset próximo mantém o uso', () => {
    expect(effectiveUsedRatio(win('5h', 0.4), NOW)).toBe(0.4);
  });

  it('crédito de reset é proporcional: 80% a 30min do reset = 40%', () => {
    const resetsAt = NOW + RESET_PROXIMITY_WINDOW_MS / 2;
    expect(effectiveUsedRatio(win('5h', 0.8, resetsAt), NOW)).toBeCloseTo(0.4);
  });

  it('reset vencido conta como liberada', () => {
    const resetsAt = NOW - 1;
    expect(effectiveUsedRatio(win('5h', 0.95, resetsAt), NOW)).toBe(0);
  });

  it('reset além de 60min não recebe crédito', () => {
    const resetsAt = NOW + RESET_PROXIMITY_WINDOW_MS + 1;
    expect(effectiveUsedRatio(win('5h', 0.7, resetsAt), NOW)).toBe(0.7);
  });
});

describe('scoreFleet', () => {
  it('decora elegibilidade e exclui sem credencial / relogin / cooldown / uso desconhecido', () => {
    const entries = [
      entry('claude:ok', [win('5h', 0.2)], { accountId: 'ok' }),
      entry('claude:semcred', [win('5h', 0.1)], { accountId: 'semcred' }),
      entry('claude:relogin', [win('5h', 0.1)], { accountId: 'relogin' }),
      entry('claude:cooldown', [win('5h', 0.1)], { onCooldown: true }),
      entry('claude:escuro', [win('5h', null)]),
    ];
    const accounts = [
      account('ok', { email: 'gustavo@gmail.com' }),
      account('semcred', { hasCredential: false }),
      account('relogin', { needsRelogin: true }),
    ];
    const result = scoreFleet(entries, accounts, NOW);
    const byId = new Map(result.entries.map((e) => [e.id, e]));
    expect(byId.get('claude:ok')?.eligible).toBe(true);
    expect(byId.get('claude:semcred')?.excludedReason).toBe('no-credential');
    expect(byId.get('claude:relogin')?.excludedReason).toBe('needs-relogin');
    expect(byId.get('claude:cooldown')?.excludedReason).toBe('cooldown');
    expect(byId.get('claude:escuro')?.excludedReason).toBe('unknown-usage');
  });

  it('ranking ordena por folga: conta vazia vence conta cheia', () => {
    const entries = [
      entry('claude:cheia', [win('5h', 0.9)], { accountId: 'cheia' }),
      entry('claude:vazia', [win('5h', 0.1)], { accountId: 'vazia' }),
    ];
    const accounts = [account('cheia'), account('vazia')];
    const result = scoreFleet(entries, accounts, NOW);
    expect(result.ranking.claude.map((r) => r.entryId)).toEqual([
      'claude:vazia',
      'claude:cheia',
    ]);
  });

  it('conta quase resetando compete de volta: 90% a 6min do reset vence 50% estável', () => {
    const almostReset = NOW + 6 * 60_000;
    const entries = [
      entry('claude:quase', [win('5h', 0.9, almostReset)], { accountId: 'quase' }),
      entry('claude:meio', [win('5h', 0.5)], { accountId: 'meio' }),
    ];
    const accounts = [account('quase'), account('meio')];
    const result = scoreFleet(entries, accounts, NOW);
    expect(result.ranking.claude[0].entryId).toBe('claude:quase');
    // uso efetivo: 0.9 * 6/60 = 0.09
    expect(result.ranking.claude[0].headroom).toBeCloseTo(0.91, 5);
    expect(result.ranking.claude[0].minutesToReset).toBe(6);
  });

  it('janela decisiva é a pior efetiva e o email vai mascarado', () => {
    const entries = [
      entry('claude:a', [win('5h', 0.2), win('Semana', 0.7)], {
        accountId: 'a',
      }),
    ];
    const result = scoreFleet(entries, [account('a', { email: 'gustavo@gmail.com' })], NOW);
    const [row] = result.ranking.claude;
    expect(row.decisiveWindow?.label).toBe('Semana');
    expect(row.decisiveWindow?.effectiveUsedRatio).toBe(0.7);
    expect(row.emailMasked).toBe('gu****@g**.com');
  });

  it('rótulo com e-mail sai mascarado; o endereço completo não persiste', () => {
    const entries = [
      entry('claude:a', [win('5h', 0.2)], { accountId: 'a' }),
    ];
    entries[0]!.label = 'Claude · gustavo@gmail.com';
    const result = scoreFleet(
      entries,
      [account('a', { email: 'gustavo@gmail.com' })],
      NOW,
    );
    const json = JSON.stringify(result);
    expect(json).not.toContain('gustavo@gmail.com');
    expect(result.entries[0]?.label).toBe('Claude · g•••@g•••.com');
    expect(result.ranking.claude[0]?.label).toBe('Claude · g•••@g•••.com');
  });
});

describe('pickForAdapter', () => {
  it('devolve pick + alternativas e null quando o adapter não tem elegível', () => {
    const entries = [
      entry('claude:a', [win('5h', 0.3)], { accountId: 'a' }),
      entry('claude:b', [win('5h', 0.6)], { accountId: 'b' }),
      entry('codex:c', [win('5h', 0.1)], { accountId: 'c' }),
    ];
    const accounts = [account('a'), account('b')];
    const { ranking } = scoreFleet(entries, accounts, NOW);
    expect(pickForAdapter(ranking, 'claude')?.pick.entryId).toBe('claude:a');
    expect(pickForAdapter(ranking, 'claude')?.alternatives).toHaveLength(1);
    expect(pickForAdapter(ranking, 'kimi')).toBeNull();
  });
});
