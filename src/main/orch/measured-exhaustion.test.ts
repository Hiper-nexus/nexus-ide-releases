import { describe, expect, it, vi } from 'vitest';
import type { HeadroomInput } from '../quota/account-headroom';
import {
  reportMeasuredExhaustion,
  type MeasuredExhaustionDeps,
} from './measured-exhaustion';

const NOW = 1_000_000;

const win = (usedRatio: number | null, source = 'provider-api') => ({
  label: '5 Horas',
  kind: 'hours' as const,
  usedRatio,
  source: source as HeadroomInput['windows'][number]['source'],
});
const read = (usedRatio: number | null, source?: string): HeadroomInput => ({
  windows: [win(usedRatio, source)],
  updatedAt: NOW - 60_000,
});

function deps(over: Partial<MeasuredExhaustionDeps> = {}): MeasuredExhaustionDeps {
  return {
    headroomFor: () => read(1),
    lastSwapAt: () => null,
    noteSwap: vi.fn(),
    commitHit: vi.fn(),
    ...over,
  };
}

const input = {
  paneId: 'p1',
  sessionId: 's1',
  adapterId: 'agy',
  accountId: 'acct-a',
  hasPendingWork: true,
  now: NOW,
};

describe('reportMeasuredExhaustion (camada 3.2 — o silêncio do AGY)', () => {
  it('conta medida esgotada com trabalho pendente vira LimitHit confirmado', () => {
    const d = deps();
    const out = reportMeasuredExhaustion(input, d);
    expect(out.acted).toBe(true);
    expect(d.commitHit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        hit: expect.objectContaining({
          kind: 'quota',
          confirmedAt: NOW,
          adapterId: 'agy',
        }),
      }),
    );
  });

  it('a prova é a medição, não o terminal: o motivo diz isso', () => {
    const d = deps();
    reportMeasuredExhaustion(input, d);
    const call = (d.commitHit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.hit.reason).toMatch(/cota medida/i);
    expect(call.hit.reason).not.toMatch(/usage limit reached/i);
  });

  it('pane ocioso porque TERMINOU não é tocado', () => {
    const d = deps();
    const out = reportMeasuredExhaustion({ ...input, hasPendingWork: false }, d);
    expect(out.acted).toBe(false);
    expect(d.commitHit).not.toHaveBeenCalled();
  });

  it('conta com folga não vira limite', () => {
    const d = deps({ headroomFor: () => read(0.3) });
    expect(reportMeasuredExhaustion(input, d).acted).toBe(false);
    expect(d.commitHit).not.toHaveBeenCalled();
  });

  it('conta apenas drenando não vira limite (isso é da camada 1)', () => {
    const d = deps({ headroomFor: () => read(0.95) });
    expect(reportMeasuredExhaustion(input, d).acted).toBe(false);
  });

  it('sem leitura de cota não vira limite', () => {
    const d = deps({ headroomFor: () => undefined });
    expect(reportMeasuredExhaustion(input, d).acted).toBe(false);
  });

  it('leitura que não é do provedor não vira limite', () => {
    const d = deps({ headroomFor: () => read(1, 'local-tokens') });
    expect(reportMeasuredExhaustion(input, d).acted).toBe(false);
  });

  it('leitura velha não vira limite', () => {
    const d = deps({
      headroomFor: () => ({ windows: [win(1)], updatedAt: NOW - 600_001 }),
    });
    expect(reportMeasuredExhaustion(input, d).acted).toBe(false);
  });

  it('pane sem conta não vira limite', () => {
    const d = deps();
    expect(reportMeasuredExhaustion({ ...input, accountId: null }, d).acted).toBe(false);
  });

  it('respeita o teto de uma troca por pane por hora', () => {
    const d = deps({ lastSwapAt: () => NOW - 60_000 });
    expect(reportMeasuredExhaustion(input, d).acted).toBe(false);
  });

  it('registra a troca para o teto valer na próxima passada', () => {
    const d = deps();
    reportMeasuredExhaustion(input, d);
    expect(d.noteSwap).toHaveBeenCalledWith('p1', NOW);
  });

  it('não registra troca quando não agiu', () => {
    const d = deps({ headroomFor: () => read(0.3) });
    reportMeasuredExhaustion(input, d);
    expect(d.noteSwap).not.toHaveBeenCalled();
  });
});
