import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CLI_LIMIT_MS,
  activeCliLimit,
  clearCliLimit,
  isCliLimited,
  noteCliLimit,
  resetCliLimits,
} from './cli-limit-registry';
import type { LimitHit } from './limit-detector';

const HIT: LimitHit = {
  kind: 'rate-limit',
  reason: '⎿ Usage limit reached',
  cooldownMs: 5 * 60 * 60 * 1000,
  adapterId: 'muse',
  confirmed: true,
};

describe('F-1410: registro de limite de uso no nível da CLI', () => {
  afterEach(() => resetCliLimits());

  it('marca a CLI e expira exatamente na janela do hit', () => {
    const now = 1_000_000;
    noteCliLimit('muse', HIT, now);
    expect(isCliLimited('muse', now)).toBe(true);
    expect(activeCliLimit('muse', now)?.reason).toBe('Usage limit reached');
    expect(activeCliLimit('muse', now + HIT.cooldownMs - 1)).not.toBeNull();
    // Na hora exata a janela acabou: a CLI volta a ser elegível sozinha.
    expect(activeCliLimit('muse', now + HIT.cooldownMs)).toBeNull();
    expect(isCliLimited('muse', now + HIT.cooldownMs)).toBe(false);
  });

  it('CLI sem limite marcado não está limitada', () => {
    expect(isCliLimited('claude')).toBe(false);
    expect(activeCliLimit('claude')).toBeNull();
  });

  it('o limite é por CLI: marcar o muse não toca nas irmãs', () => {
    noteCliLimit('muse', HIT, 0);
    expect(isCliLimited('claude', 0)).toBe(false);
    expect(isCliLimited('codex', 0)).toBe(false);
  });

  it('um segundo hit renova a janela a partir de agora', () => {
    const first = 0;
    noteCliLimit('muse', HIT, first);
    const later = HIT.cooldownMs - 1_000;
    const renewed = noteCliLimit('muse', HIT, later);
    expect(renewed.until).toBe(later + HIT.cooldownMs);
    expect(isCliLimited('muse', first + HIT.cooldownMs)).toBe(true);
  });

  it('janela sem prova usa o piso conservador documentado', () => {
    const hit: LimitHit = { ...HIT, cooldownMs: Number.NaN };
    noteCliLimit('muse', hit, 0);
    expect(activeCliLimit('muse', 0)?.until).toBe(DEFAULT_CLI_LIMIT_MS);
  });

  it('clearCliLimit devolve a CLI à rota na hora', () => {
    noteCliLimit('muse', HIT, 0);
    clearCliLimit('muse');
    expect(isCliLimited('muse', 0)).toBe(false);
  });
});