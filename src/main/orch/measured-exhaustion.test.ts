import { describe, expect, it, vi } from 'vitest';
import type { HeadroomInput } from '../quota/account-headroom';
import {
  MEASURED_EXHAUSTION_REASON,
  reportMeasuredExhaustion,
  SUSTAINED_SILENCE_MS,
  type MeasuredExhaustionDeps,
} from './measured-exhaustion';
import { detectLimit } from './limit-detector';
import { SEMANTIC_WORKING_VETO_MS } from './agent-status';

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
  silentForMs: 10 * 60_000,
  semanticWorkingAt: null as number | null,
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

describe('laço de realimentação', () => {
  it('a razão do hit sintetizado NÃO é reconhecida pelo detector de limite', () => {
    // Ela vira last_error da conta e volta ao detectLimit em quota-service.
    // Um padrão novo que a reconheça fecharia o laço: a troca geraria o
    // sinal que dispara a próxima troca.
    expect(detectLimit(MEASURED_EXHAUSTION_REASON)).toBeNull();
  });
});

describe('prova de que o pane REALMENTE parou (C6)', () => {
  it('pane com status semântico working FRESCO nunca é trocado, mesmo esgotado', () => {
    const d = deps();
    const out = reportMeasuredExhaustion(
      { ...input, semanticWorkingAt: NOW - 60_000, silentForMs: 10 * 60_000 },
      d,
    );
    expect(out.acted).toBe(false);
    expect(out.reason).toMatch(/trabalhando/i);
    expect(d.commitHit).not.toHaveBeenCalled();
  });

  it('working OBSOLETO não veta: a cota esgotada impede o stop de chegar', () => {
    // O hook diz working, o pedido ao provedor trava por falta de cota e o
    // evento de parada nunca vem. Sem prazo, o veto duraria para sempre e o
    // pane nunca seria resgatado — exatamente o caso que isto existe para
    // resolver. Mesmo prazo do resto do supervisor (SEMANTIC_WORKING_VETO_MS).
    const d = deps();
    const out = reportMeasuredExhaustion(
      { ...input, semanticWorkingAt: NOW - SEMANTIC_WORKING_VETO_MS - 1 },
      d,
    );
    expect(out.acted).toBe(true);
  });

  it('working exatamente no limite do prazo ainda veta', () => {
    const d = deps();
    expect(
      reportMeasuredExhaustion(
        { ...input, semanticWorkingAt: NOW - SEMANTIC_WORKING_VETO_MS },
        d,
      ).acted,
    ).toBe(false);
  });

  it('silêncio curto não é prova: pode ser chamada de API em voo', () => {
    const d = deps();
    const out = reportMeasuredExhaustion({ ...input, silentForMs: 30_000 }, d);
    expect(out.acted).toBe(false);
    expect(out.reason).toMatch(/sil[êe]ncio/i);
    expect(d.commitHit).not.toHaveBeenCalled();
  });

  it('silêncio sustentado com conta esgotada troca', () => {
    const d = deps();
    expect(
      reportMeasuredExhaustion({ ...input, silentForMs: SUSTAINED_SILENCE_MS }, d).acted,
    ).toBe(true);
  });

  it('silêncio desconhecido não autoriza', () => {
    const d = deps();
    expect(
      reportMeasuredExhaustion({ ...input, silentForMs: undefined }, d).acted,
    ).toBe(false);
  });
});

describe('leitura emprestada não grava cooldown (C3)', () => {
  it('leitura atribuída da identidade viva NÃO sintetiza limite', () => {
    // O bridge do AGY não traz identidade e prefere o processo do IDE: com o
    // Antigravity aberto noutra conta, a leitura seria de um terceiro. Drenar
    // por ela é recuperável; pôr a conta em cooldown e rerrotear, não.
    const d = deps({
      headroomFor: () => ({ ...read(1), attributed: true }),
    });
    const out = reportMeasuredExhaustion(input, d);
    expect(out.acted).toBe(false);
    expect(out.reason).toMatch(/pr[óo]pria/i);
    expect(d.commitHit).not.toHaveBeenCalled();
  });

  it('leitura própria da conta continua sintetizando', () => {
    const d = deps({ headroomFor: () => read(1) });
    expect(reportMeasuredExhaustion(input, d).acted).toBe(true);
  });
});
