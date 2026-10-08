import { describe, expect, it } from 'vitest';
import {
  bindingHeadroomWindow,
  compareAccountHeadroom,
  headroomInputsByAccount,
  isHeadroomExhausted,
  unreadWindowWithProvenHeadroom,
  type HeadroomInput,
} from './account-headroom';

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
