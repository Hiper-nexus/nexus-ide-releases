/**
 * F-1347: a seleção do modelo de negócio olhava só as palavras do pedido.
 * Sem casamento léxico, o baseline `projeto` tornava TODA regra global
 * candidata de qualquer tarefa — o bloco injetou invariantes de troca de conta
 * e de overlay numa varredura de QA. Arquivo tocado pela tarefa pesa no
 * fluxo/invariante que o protege, e o baseline só vale sem palavra nem
 * arquivo que case.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BusinessModelDocument } from './business-model-contract';
import type { BusinessHurdle } from './business-model-hurdles';
import { selectBusinessContext } from './business-model-selection';

const document: BusinessModelDocument = Object.freeze({
  schemaVersion: 1 as const,
  flows: Object.freeze([
    Object.freeze({
      fluxo: 'conta_claude',
      definicao: 'src/renderer/components/settings/AccountsManager.tsx:10',
      escreve: Object.freeze(['managed-accounts']),
      le: Object.freeze([]),
      funcoes: Object.freeze(['addActiveSession']),
      arquivos: Object.freeze(['src/renderer/components/settings/AccountsManager.tsx']),
      testes: Object.freeze(['src/renderer/components/settings/AccountsManager.test.tsx']),
    }),
    Object.freeze({
      fluxo: 'overlay',
      definicao: 'src/main/runtime/process-home.ts:5',
      escreve: Object.freeze(['sessions']),
      le: Object.freeze([]),
      funcoes: Object.freeze(['processHome']),
      arquivos: Object.freeze(['src/main/runtime/process-home.ts']),
      testes: Object.freeze(['src/main/runtime/process-home.test.ts']),
    }),
  ]),
  invariants: Object.freeze([
    Object.freeze({
      id: 'conta_claude#1',
      fluxo: 'conta_claude',
      regra: 'Uma CLI guarda UMA sessao por vez: entre na 2a conta sem guardar a1a e perde a sessao.',
      origem: 'AGENTS.md:131',
      arquivos: Object.freeze(['src/renderer/components/settings/AccountsManager.tsx']),
      tabelas: Object.freeze([]),
      funcoes: Object.freeze(['addActiveSession']),
      testes: Object.freeze(['src/renderer/components/settings/AccountsManager.test.tsx']),
    }),
    Object.freeze({
      id: 'overlay#1',
      fluxo: 'overlay',
      regra: 'Nunca ligue sessions/historicos ao perfil nativo do CLI.',
      origem: 'AGENTS.md:555',
      arquivos: Object.freeze(['src/main/runtime/process-home.ts']),
      tabelas: Object.freeze([]),
      funcoes: Object.freeze(['processHome']),
      testes: Object.freeze(['src/main/runtime/process-home.test.ts']),
    }),
    Object.freeze({
      id: 'projeto#22',
      fluxo: 'projeto',
      regra: 'F-702 worker nunca pergunta ao humano: ninguem responde e o pane trava.',
      origem: 'AGENTS.md:509',
      arquivos: Object.freeze(['AGENTS.md']),
      tabelas: Object.freeze([]),
      funcoes: Object.freeze([]),
      testes: Object.freeze([]),
    }),
    Object.freeze({
      id: 'projeto#2',
      fluxo: 'projeto',
      regra: 'Register bugs as docs/qa/items/F-XXX.md usando o formato do QA-PROTOCOL.',
      origem: 'AGENTS.md:107',
      arquivos: Object.freeze(['AGENTS.md']),
      tabelas: Object.freeze([]),
      funcoes: Object.freeze([]),
      testes: Object.freeze([]),
    }),
  ]),
});

const hurdles: readonly BusinessHurdle[] = Object.freeze([]);

const off = {
  surfaceEnabled: () => false,
  hasCredential: () => true,
  recordDecision: vi.fn(),
  judge: vi.fn(async () => null),
} as const;

describe('selectBusinessContext — relevancia pelos arquivos tocados', () => {
  it('arquivo tocado traz o invariante dele MESMO sem a palavra no pedido', async () => {
    const selection = await selectBusinessContext(
      {
        task: 'caçar bugs por dentro e relatar o que está quebrado',
        document,
        hurdles,
        touchedFiles: ['src/renderer/components/settings/AccountsManager.tsx'],
      },
      off,
    );
    expect(selection).not.toBeNull();
    expect(selection!.invariants.map((invariant) => invariant.id)).toContain('conta_claude#1');
    expect(selection!.flows.map((flow) => flow.fluxo)).toContain('conta_claude');
  });

  it('o baseline global NAO substitui o arquivo tocado: regra de outra área fica de fora', async () => {
    const selection = await selectBusinessContext(
      {
        task: 'caçar bugs por dentro e relatar o que está quebrado',
        document,
        hurdles,
        touchedFiles: ['src/main/runtime/process-home.ts'],
      },
      off,
    );
    expect(selection!.invariants.map((invariant) => invariant.id)).toContain('overlay#1');
    // Antes o baseline entregava projeto#22 e projeto#2 para QUALQUER tarefa.
    expect(selection!.invariants.map((invariant) => invariant.id)).not.toContain('conta_claude#1');
    // Sem palavra nem arquivo dele, a regra global não ocupa vaga.
    expect(selection!.invariants.map((invariant) => invariant.id)).not.toContain('projeto#22');
  });

  it('com Jev: o invariante do arquivo tocado entra mesmo que o Jev (que não vê arquivos) diga não', async () => {
    const judge = vi.fn(async (input: { questions: Record<string, unknown> }) => ({
      model: 'jev-test',
      answers: Object.fromEntries(
        Object.keys(input.questions).map((id) => [id, { type: 'noul' as const, noul: 0.1 }]),
      ),
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const selection = await selectBusinessContext(
      {
        task: 'caçar bugs por dentro e relatar o que está quebrado',
        document,
        hurdles,
        touchedFiles: ['./src/main/runtime/process-home.test.ts'],
      },
      { surfaceEnabled: () => true, hasCredential: () => true, recordDecision: vi.fn(), judge },
    );
    expect(judge).toHaveBeenCalledTimes(1);
    expect(selection!.source).toBe('jev');
    expect(selection!.invariants.map((invariant) => invariant.id)).toEqual(['overlay#1']);
    expect(selection!.flows.map((flow) => flow.fluxo)).toEqual(['overlay']);
  });

  it('sem arquivo tocado conhecido, o baseline global continua de pé (não regride)', async () => {
    const selection = await selectBusinessContext(
      { task: 'xyzzy zzzqq nada aqui combina', document, hurdles },
      off,
    );
    expect(selection!.invariants.map((invariant) => invariant.id)).toEqual(['projeto#22', 'projeto#2']);
  });
});