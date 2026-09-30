import { describe, expect, it, vi } from 'vitest';
import type { JevDecisionInput } from '../../jev/jev-decision-log';
import type { JevResult, JudgeInput } from '../../jev/jev-client';
import type { BusinessModelDocument } from './business-model-contract';
import type { BusinessHurdle } from './business-model-hurdles';
import { selectBusinessContext } from './business-model-selection';

type JudgeMock = (input: JudgeInput) => Promise<JevResult | null>;

const document: BusinessModelDocument = Object.freeze({
  schemaVersion: 1 as const,
  flows: Object.freeze([
    Object.freeze({
      fluxo: 'close_commanda',
      definicao: 'supabase/migrations/2.sql:10',
      escreve: Object.freeze(['appointments', 'commission_entries']),
      le: Object.freeze([]),
      funcoes: Object.freeze(['close_commanda', 'sync_commission_totals']),
      arquivos: Object.freeze(['src/commanda.ts']),
      testes: Object.freeze(['tests/db/close-commanda.test.ts']),
    }),
    Object.freeze({
      fluxo: 'refund_payment',
      definicao: 'supabase/migrations/3.sql:20',
      escreve: Object.freeze(['payments', 'refunds']),
      le: Object.freeze(['payments']),
      funcoes: Object.freeze(['refund_payment']),
      arquivos: Object.freeze(['src/payments.ts']),
      testes: Object.freeze(['tests/db/refund.test.ts']),
    }),
  ]),
  invariants: Object.freeze([
    Object.freeze({
      id: 'close_commanda#1',
      fluxo: 'close_commanda',
      regra: 'close_commanda recusa: comanda ja fechada',
      origem: 'supabase/migrations/2.sql:14',
      arquivos: Object.freeze(['src/commanda.ts']),
      tabelas: Object.freeze(['appointments']),
      funcoes: Object.freeze(['close_commanda']),
      testes: Object.freeze(['tests/db/close-commanda.test.ts']),
    }),
    Object.freeze({
      id: 'refund_payment#1',
      fluxo: 'refund_payment',
      regra: 'refund_payment recusa: valor maior que o pago',
      origem: 'supabase/migrations/3.sql:30',
      arquivos: Object.freeze(['src/payments.ts']),
      tabelas: Object.freeze(['payments', 'refunds']),
      funcoes: Object.freeze(['refund_payment']),
      testes: Object.freeze(['tests/db/refund.test.ts']),
    }),
    Object.freeze({
      id: 'projeto#1',
      fluxo: 'projeto',
      regra: 'nunca grave commission_entries fora de close_commanda',
      origem: 'AGENTS.md:3',
      arquivos: Object.freeze(['AGENTS.md']),
      tabelas: Object.freeze([]),
      funcoes: Object.freeze([]),
      testes: Object.freeze([]),
    }),
  ]),
});

const hurdles: readonly BusinessHurdle[] = Object.freeze([
  Object.freeze({
    id: 'hurdle:comissao',
    titulo: 'comissão duplicada quando o trigger roda duas vezes',
    resumo: 'sync_commission_totals somava duas vezes no retry',
    origem: 'docs/AGENTS-HURDLES.md:10',
  }),
  Object.freeze({
    id: 'hurdle:deploy',
    titulo: 'deploy na sexta derruba a fila de webhooks',
    resumo: 'migration antes do código',
    origem: 'docs/AGENTS-HURDLES.md:50',
  }),
]);

function jevResult(answers: Record<string, number>): JevResult {
  return {
    model: 'jev-test',
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, noul]) => [id, { type: 'noul' as const, noul }]),
    ),
    usage: { input_tokens: 50, output_tokens: 5 },
  };
}

const enabled = {
  surfaceEnabled: () => true,
  hasCredential: () => true,
  recordDecision: vi.fn(() => 'id'),
} as const;

describe('selectBusinessContext — fallback lexical', () => {
  it('sem Jev seleciona pelo texto da tarefa (fluxo, invariante e hurdle)', async () => {
    const selection = await selectBusinessContext(
      {
        task: 'corrigir o close_commanda que grava commission_entries errada e causa comissão duplicada',
        document,
        hurdles,
      },
      { ...enabled, judge: vi.fn<JudgeMock>(async () => null) },
    );
    expect(selection).not.toBeNull();
    expect(selection!.source).toBe('lexical');
    expect(selection!.flows.map((flow) => flow.fluxo)).toContain('close_commanda');
    expect(selection!.flows.map((flow) => flow.fluxo)).not.toContain('refund_payment');
    expect(selection!.invariants.map((invariant) => invariant.id)).toContain('close_commanda#1');
    expect(selection!.hurdles.map((hurdle) => hurdle.id)).toContain('hurdle:comissao');
    expect(selection!.key).toBe(selectionKeyOf(selection!));
  });

  it('tarefa sem nada a ver: só a regra global do projeto sobra (baseline)', async () => {
    const selection = await selectBusinessContext(
      { task: 'xyzzy zzzqq nada aqui combina', document, hurdles: [] },
      { ...enabled, judge: vi.fn<JudgeMock>(async () => null), recordDecision: vi.fn() },
    );
    // Nenhum fluxo/hurdle pontua; a regra `projeto` entra pelo baseline
    // (regra global é levemente relevante para qualquer tarefa).
    expect(selection).not.toBeNull();
    expect(selection!.flows).toEqual([]);
    expect(selection!.hurdles).toEqual([]);
    expect(selection!.invariants.map((invariant) => invariant.id)).toEqual(['projeto#1']);
  });

  it('superfície desligada ou sem credencial: lexical, sem chamar o judge', async () => {
    const judge = vi.fn<JudgeMock>(async () => jevResult({}));
    const off = await selectBusinessContext(
      { task: 'fechar comanda', document, hurdles },
      { judge, surfaceEnabled: () => false, hasCredential: () => true, recordDecision: vi.fn() },
    );
    expect(off!.source).toBe('lexical');
    expect(judge).not.toHaveBeenCalled();
    const noKey = await selectBusinessContext(
      { task: 'fechar comanda', document, hurdles },
      { judge, surfaceEnabled: () => true, hasCredential: () => false, recordDecision: vi.fn() },
    );
    expect(noKey!.source).toBe('lexical');
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('selectBusinessContext — Jev', () => {
  it('respeita o Jev: só entra o que passou do limiar, com proveniência', async () => {
    const judge = vi.fn<JudgeMock>(async (input) => {
      const answers: Record<string, number> = {};
      for (const id of Object.keys(input.questions)) {
        answers[id] = id === 'flow:close_commanda' || id === 'inv:close_commanda#1' ? 0.9 : 0.1;
      }
      return jevResult(answers);
    });
    const recordDecision = vi.fn((_entry: JevDecisionInput) => 'log-id');
    const selection = await selectBusinessContext(
      {
        task: 'fechar comanda',
        document,
        hurdles,
        sessionId: 's1',
        missionId: 'm1',
      },
      { judge, ...enabled, recordDecision },
    );
    expect(selection).not.toBeNull();
    expect(selection!.source).toBe('jev');
    expect(selection!.flows.map((flow) => flow.fluxo)).toEqual(['close_commanda']);
    expect(selection!.invariants.map((invariant) => invariant.id)).toContain('close_commanda#1');
    expect(selection!.hurdles).toEqual([]);
    // Perguntas estruturadas: cada uma carrega o candidato tipado.
    const questions = judge.mock.calls[0][0].questions;
    expect(questions['flow:close_commanda']!.instructions).toMatchObject({
      flow: { name: 'close_commanda' },
    });
    expect(questions['inv:close_commanda#1']!.instructions).toMatchObject({
      rule: { flow: 'close_commanda' },
    });
    // Um único judge com retryOnTimeout desligado — o prompt não pode dobrar.
    expect(judge.mock.calls[0][0]).toMatchObject({
      surface: 'businessModel',
      sessionId: 's1',
      missionId: 'm1',
      retryOnTimeout: false,
    });
    expect(recordDecision).toHaveBeenCalledTimes(1);
    expect(recordDecision.mock.calls[0][0]).toMatchObject({
      surface: 'businessModel',
      decision: expect.stringMatching(/^select:\d+f\/\d+i\/\d+h$/),
    });
  });

  it('Jev que diz "nada relevante" vale a palavra dele (seleção vazia)', async () => {
    const judge = vi.fn<JudgeMock>(async () => jevResult({ 'flow:close_commanda': 0.1 }));
    const selection = await selectBusinessContext(
      { task: 'fechar comanda', document, hurdles },
      { judge, ...enabled, recordDecision: vi.fn() },
    );
    expect(selection).not.toBeNull();
    expect(selection!.source).toBe('jev');
    expect(selection!.flows).toEqual([]);
  });

  it('judge que lança → lexical (fail-open)', async () => {
    const judge = vi.fn<JudgeMock>(async () => {
      throw new Error('api fora do ar');
    });
    const selection = await selectBusinessContext(
      { task: 'fechar comanda gera comissao', document, hurdles },
      { judge, ...enabled, recordDecision: vi.fn() },
    );
    expect(selection).not.toBeNull();
    expect(selection!.source).toBe('lexical');
  });

  it('a seleção nunca inventa item: tudo sai do documento dado', async () => {
    const judge = vi.fn<JudgeMock>(async (input) => {
      const answers: Record<string, number> = {};
      for (const id of Object.keys(input.questions)) answers[id] = 0.99;
      return jevResult(answers);
    });
    const selection = await selectBusinessContext(
      { task: 'qualquer', document, hurdles },
      { judge, ...enabled, recordDecision: vi.fn() },
    );
    for (const flow of selection!.flows) {
      expect(document.flows).toContain(flow);
    }
    for (const invariant of selection!.invariants) {
      expect(document.invariants).toContain(invariant);
    }
    for (const hurdle of selection!.hurdles) {
      expect(hurdles).toContain(hurdle);
    }
  });
});

function selectionKeyOf(selection: {
  flows: readonly { fluxo: string }[];
  invariants: readonly { id: string }[];
  hurdles: readonly { id: string }[];
}): string {
  return [
    selection.flows.map((item) => item.fluxo).join(','),
    selection.invariants.map((item) => item.id).join(','),
    selection.hurdles.map((item) => item.id).join(','),
  ].join('|');
}
