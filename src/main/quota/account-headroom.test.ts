import { describe, expect, it } from 'vitest';
import {
  bindingHeadroomWindow,
  compareAccountHeadroom,
  headroomInputsByAccount,
  isHeadroomExhausted,
  isHeadroomDraining,
  DRAIN_THRESHOLD,
  unreadWindowWithProvenHeadroom,
  type HeadroomInput,
} from './account-headroom';
import type { ProviderQuotaEntry } from '../../shared/quota-types';

const RESET_5H = 1_791_420_599_886;
const RESET_WEEK = 1_791_658_799_908;

/** O retrato de 07/10 (F-995): Co•••de só com a Semanal, re•••no só com a de 5 Horas. */
const coClaude: HeadroomInput = {
  windows: [
    { kind: 'hours', label: '5 Horas', usedRatio: null },
    { kind: 'weekly', label: 'Semanal', usedRatio: 0.19, resetsAt: RESET_WEEK },
  ],
};
const reClaude: HeadroomInput = {
  windows: [
    { kind: 'hours', label: '5 Horas', usedRatio: 0, resetsAt: RESET_5H },
    { kind: 'weekly', label: 'Semanal', usedRatio: null },
  ],
};

describe('compareAccountHeadroom (F-995)', () => {
  it('caso de 07/10: Semanal de uma conta não se compara com 5 Horas da outra — a de 5 Horas medida vence', () => {
    expect(compareAccountHeadroom(reClaude, coClaude)).toBeGreaterThan(0);
    expect(compareAccountHeadroom(coClaude, reClaude)).toBeLessThan(0);
  });

  it('janelas comparáveis decidem pela mais apertada (a que limita de fato)', () => {
    const tightWeekly: HeadroomInput = {
      windows: [
        { kind: 'hours', label: '5 Horas', usedRatio: 0.1 },
        { kind: 'weekly', label: 'Semanal', usedRatio: 0.99 },
      ],
    };
    const balanced: HeadroomInput = {
      windows: [
        { kind: 'hours', label: '5 Horas', usedRatio: 0.5 },
        { kind: 'weekly', label: 'Semanal', usedRatio: 0.2 },
      ],
    };
    expect(compareAccountHeadroom(balanced, tightWeekly)).toBeGreaterThan(0);
  });

  it('conta sem leitura de uma janela não tem mais folga nela', () => {
    const weeklyOnly: HeadroomInput = {
      windows: [{ kind: 'weekly', label: 'Semanal', usedRatio: 0.5 }],
    };
    const both: HeadroomInput = {
      windows: [
        { kind: 'weekly', label: 'Semanal', usedRatio: 0.5 },
        { kind: 'hours', label: '5 Horas', usedRatio: 0.3 },
      ],
    };
    expect(compareAccountHeadroom(both, weeklyOnly)).toBeGreaterThan(0);
    expect(unreadWindowWithProvenHeadroom(weeklyOnly, both)).toMatchObject({
      key: 'hours',
      label: '5 Horas',
    });
    expect(unreadWindowWithProvenHeadroom(both, weeklyOnly)).toBeNull();
  });

  it('esgotada (janela cheia ou cooldown) perde para qualquer uma que não esteja', () => {
    const full: HeadroomInput = {
      windows: [{ kind: 'hours', label: '5 Horas', usedRatio: 1 }],
    };
    expect(isHeadroomExhausted(full)).toBe(true);
    expect(isHeadroomExhausted({ windows: [], onCooldown: true })).toBe(true);
    expect(compareAccountHeadroom({ windows: [] }, full)).toBeGreaterThan(0);
    expect(compareAccountHeadroom(full, { windows: [], onCooldown: true })).toBe(0);
  });

  it('a janela que limita vem com o reset dela', () => {
    expect(bindingHeadroomWindow(coClaude)).toMatchObject({
      label: 'Semanal',
      usedRatio: 0.19,
      resetsAt: RESET_WEEK,
    });
    expect(bindingHeadroomWindow({ windows: [] })).toBeNull();
  });

  it('snapshot da frota vira janelas por conta só do adapter pedido', () => {
    const map = headroomInputsByAccount(
      [
        {
          id: 'claude:a', adapterId: 'claude', accountId: 'a', label: 'A',
          installed: true, onCooldown: false, updatedAt: 1,
          windows: [{ kind: 'hours', label: '5 Horas', usedRatio: 0.4, source: 'provider-api', confidence: 'high' }],
        },
        {
          id: 'codex:x', adapterId: 'codex', accountId: 'x', label: 'X',
          installed: true, onCooldown: false, updatedAt: 1, windows: [],
        },
      ],
      'claude',
    );
    expect([...(map?.keys() ?? [])]).toEqual(['a']);
    expect(headroomInputsByAccount([], 'claude')).toBeUndefined();
  });
});

describe('folga só de cota medida desta credencial (F-1417)', () => {
  it('janela de confiança baixa (sessão `bl` da máquina) não conta como folga nem como esgotada', () => {
    const fromMachineSession: HeadroomInput = {
      windows: [{ kind: 'monthly', label: 'Mensal', usedRatio: 1, confidence: 'low' }],
    };
    expect(isHeadroomExhausted(fromMachineSession)).toBe(false);
    const measured: HeadroomInput = {
      windows: [{ kind: 'monthly', label: 'Mensal', usedRatio: 0.2, confidence: 'high' }],
    };
    const lowButEmpty: HeadroomInput = {
      windows: [{ kind: 'monthly', label: 'Mensal', usedRatio: 0, confidence: 'low' }],
    };
    // A medida de verdade vence a que só "parece" vazia.
    expect(compareAccountHeadroom(measured, lowButEmpty)).toBeGreaterThan(0);
  });
});

describe('isHeadroomDraining (limiar de drenagem)', () => {
  const NOW = 1_000_000;
  const EV = { requireSource: 'provider-api', maxAgeMs: 600_000, now: NOW } as const;
  const WIN = (
    o: Partial<HeadroomInput['windows'][number]> = {},
  ): HeadroomInput['windows'][number] => ({
    label: '5 Horas',
    kind: 'hours',
    usedRatio: 0.9,
    source: 'provider-api',
    ...o,
  });

  it('drena com leitura provider-api fresca acima do limiar', () => {
    const input: HeadroomInput = { windows: [WIN()], updatedAt: NOW - 60_000 };
    expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(true);
  });

  it('não drena abaixo do limiar', () => {
    const input: HeadroomInput = { windows: [WIN({ usedRatio: 0.88 })], updatedAt: NOW - 60_000 };
    expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(false);
  });

  it('não drena por leitura que não é do provider', () => {
    const input: HeadroomInput = {
      windows: [WIN({ source: 'local-tokens' })],
      updatedAt: NOW - 60_000,
    };
    expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(false);
  });

  it('não drena por leitura mais velha que maxAgeMs', () => {
    const input: HeadroomInput = { windows: [WIN()], updatedAt: NOW - 600_001 };
    expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(false);
  });

  it('não drena sem updatedAt: idade desconhecida não é leitura fresca', () => {
    expect(isHeadroomDraining({ windows: [WIN()] }, DRAIN_THRESHOLD, EV)).toBe(false);
  });

  it('usedRatio null não drena', () => {
    const input: HeadroomInput = { windows: [WIN({ usedRatio: null })], updatedAt: NOW - 60_000 };
    expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(false);
  });

  it('a janela mais apertada decide', () => {
    const input: HeadroomInput = {
      windows: [WIN({ kind: 'weekly', label: 'Semanal', usedRatio: 0.1 }), WIN()],
      updatedAt: NOW - 60_000,
    };
    expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(true);
  });

  it('esgotada também conta como drenando', () => {
    const input: HeadroomInput = { windows: [WIN({ usedRatio: 1 })], updatedAt: NOW - 60_000 };
    expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(true);
  });

  it('input undefined não drena', () => {
    expect(isHeadroomDraining(undefined, DRAIN_THRESHOLD, EV)).toBe(false);
  });

  it('confidence low continua descartada (F-1417)', () => {
    const input: HeadroomInput = {
      windows: [WIN({ confidence: 'low' })],
      updatedAt: NOW - 60_000,
    };
    expect(isHeadroomDraining(input, DRAIN_THRESHOLD, EV)).toBe(false);
  });
});

describe('headroomInputsByAccount — leitura da identidade viva (AGY)', () => {
  const entry = (
    over: Partial<ProviderQuotaEntry>,
  ): ProviderQuotaEntry => ({
    id: 'agy:x', adapterId: 'agy', label: 'AGY', installed: true,
    onCooldown: false, updatedAt: 1_000, windows: [], ...over,
  } as ProviderQuotaEntry);

  const w = (usedRatio: number) => ({
    kind: 'hours' as const, label: '5 Horas', usedRatio,
    source: 'provider-api' as const, confidence: 'high' as const,
  });

  it('sem a opção, a linha nativa (sem accountId) continua descartada', () => {
    const out = headroomInputsByAccount(
      [entry({ id: 'agy:native', windows: [w(0.9)] }), entry({ id: 'agy:a', accountId: 'a' })],
      'agy',
    );
    expect(out?.get('a')?.windows).toEqual([]);
  });

  it('atribui a leitura nativa à conta que detém a identidade viva', () => {
    const out = headroomInputsByAccount(
      [entry({ id: 'agy:native', windows: [w(0.9)] }), entry({ id: 'agy:a', accountId: 'a' })],
      'agy',
      { attributeNativeTo: 'a' },
    );
    expect(out?.get('a')?.windows).toEqual([w(0.9)]);
    expect(out?.get('a')?.updatedAt).toBe(1_000);
  });

  it('não atribui às IRMÃS: só a identidade viva foi medida', () => {
    const out = headroomInputsByAccount(
      [
        entry({ id: 'agy:native', windows: [w(0.9)] }),
        entry({ id: 'agy:a', accountId: 'a' }),
        entry({ id: 'agy:b', accountId: 'b' }),
      ],
      'agy',
      { attributeNativeTo: 'a' },
    );
    expect(out?.get('b')?.windows).toEqual([]);
  });

  it('a linha da própria conta vence a nativa quando ela foi medida', () => {
    const out = headroomInputsByAccount(
      [
        entry({ id: 'agy:native', windows: [w(0.9)] }),
        entry({ id: 'agy:a', accountId: 'a', windows: [w(0.2)] }),
      ],
      'agy',
      { attributeNativeTo: 'a' },
    );
    expect(out?.get('a')?.windows).toEqual([w(0.2)]);
  });

  it('preserva o cooldown da linha da conta, não o da nativa', () => {
    const out = headroomInputsByAccount(
      [
        entry({ id: 'agy:native', windows: [w(0.9)], onCooldown: false }),
        entry({ id: 'agy:a', accountId: 'a', onCooldown: true }),
      ],
      'agy',
      { attributeNativeTo: 'a' },
    );
    expect(out?.get('a')?.onCooldown).toBe(true);
  });

  it('conta que não existe na frota não vira linha', () => {
    const out = headroomInputsByAccount(
      [entry({ id: 'agy:native', windows: [w(0.9)] })],
      'agy',
      { attributeNativeTo: 'fantasma' },
    );
    expect(out).toBeUndefined();
  });
});
