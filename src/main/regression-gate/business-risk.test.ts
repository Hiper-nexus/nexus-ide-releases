import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import type { GitRunner } from '../runtime/git-command';
import type { JevResult, JudgeInput } from '../jev/jev-client';
import type { BusinessInvariant } from '../context/business-model/business-model-contract';
import {
  configureBusinessModelStore,
  writeBusinessModel,
} from '../context/business-model/business-model-store';
import { evaluateGateBusinessRisk, type GateBusinessRisk } from './business-risk';

type JudgeMock = (input: JudgeInput) => Promise<JevResult | null>;

let storeDir = '';
const scope = testProjectScope({ rootRealPath: '/repo' });

const touched: readonly BusinessInvariant[] = [
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
];

const hurdles = Object.freeze([
  Object.freeze({
    id: 'hurdle:comissao',
    titulo: 'comissão duplicada no retry do trigger',
    resumo: 'sync_commission_totals somava duas vezes',
    origem: 'docs/AGENTS-HURDLES.md:10',
  }),
]);

/** Git fake: diff responde um texto fixo; o resto falha fechado. */
function fakeGit(diff = 'diff --git a/src/commanda.ts\n+comanda'): GitRunner {
  return {
    run: (_cwd: string, args: readonly string[]) =>
      args[0] === 'diff' && args[1] === '--unified=1'
        ? { status: 0, stdout: diff, stderr: '' }
        : { status: 1, stdout: '', stderr: 'unsupported' },
  };
}

function jevResult(answers: Record<string, number>): JevResult {
  return {
    model: 'jev-test',
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, noul]) => [id, { type: 'noul' as const, noul }]),
    ),
    usage: { input_tokens: 60, output_tokens: 6 },
  };
}

const enabledDeps = {
  surfaceEnabled: () => true,
  hasCredential: () => true,
  recordDecision: vi.fn(() => 'id'),
} as const;

const baseInput = {
  scope,
  baseSha: 'b'.repeat(40),
  changedFiles: ['src/commanda.ts'],
  touched,
} as const;

function seedStore(): void {
  writeBusinessModel(scope, {
    headSha: 'a'.repeat(40),
    fingerprint: 'fp',
    document: Object.freeze({
      schemaVersion: 1 as const,
      flows: Object.freeze([]),
      invariants: Object.freeze([]),
    }),
    hurdles,
  });
}

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-bm-risk-'));
  configureBusinessModelStore(storeDir);
  seedStore();
});

afterEach(() => {
  configureBusinessModelStore(null);
  fs.rmSync(storeDir, { recursive: true, force: true });
});

describe('evaluateGateBusinessRisk', () => {
  it('Jev: só o que passa do limiar entra, com p e texto inerte', async () => {
    const judge = vi.fn<JudgeMock>(async (input) => {
      const answers: Record<string, number> = {};
      for (const id of Object.keys(input.questions)) {
        answers[id] = id === 'rule:close_commanda#1' ? 0.87 : 0.2;
      }
      return jevResult(answers);
    });
    const risk = await evaluateGateBusinessRisk(baseInput, {
      ...enabledDeps,
      judge,
      git: fakeGit(),
    });
    expect(risk).not.toBeNull();
    expect(risk!.source).toBe('jev');
    expect(risk!.rules).toHaveLength(1);
    expect(risk!.rules[0]).toMatchObject({ id: 'close_commanda#1', p: 0.87 });
    expect(risk!.hurdles).toEqual([]);
    // O state levou os arquivos e o diff — nunca o texto cru como instrução.
    const state = judge.mock.calls[0][0].state as { files: string[]; diff: string };
    expect(state.files).toContain('src/commanda.ts');
    expect(state.diff).toContain('comanda');
    expect(judge.mock.calls[0][0]).toMatchObject({
      surface: 'businessModel',
      retryOnTimeout: false,
    });
  });

  it('sem Jev (toggle off / sem chave / judge null) cai no advisory lexical', async () => {
    for (const deps of [
      { ...enabledDeps, surfaceEnabled: () => false },
      { ...enabledDeps, hasCredential: () => false },
      { ...enabledDeps, judge: vi.fn<JudgeMock>(async () => null) },
    ]) {
      const risk = await evaluateGateBusinessRisk(baseInput, {
        ...deps,
        git: fakeGit(),
      });
      expect(risk).not.toBeNull();
      expect(risk!.source).toBe('lexical');
      expect(risk!.rules[0]!.id).toBe('close_commanda#1');
      expect(risk!.rules[0]!.p).toBeNull();
    }
  });

  it('lexical: hurdle só entra quando pontua contra os arquivos/diff', async () => {
    const risk = await evaluateGateBusinessRisk(baseInput, {
      ...enabledDeps,
      judge: vi.fn<JudgeMock>(async () => null),
      git: fakeGit('diff com sync_commission_totals duplicada comissão'),
    });
    expect(risk!.hurdles.map((item) => item.id)).toContain('hurdle:comissao');
  });

  it('judge que lança → lexical; sem modelo nem tocados → null', async () => {
    const judge = vi.fn<JudgeMock>(async () => {
      throw new Error('api down');
    });
    const risk = await evaluateGateBusinessRisk(baseInput, {
      ...enabledDeps,
      judge,
      git: fakeGit(),
    });
    expect(risk!.source).toBe('lexical');
    // Store vazio e nada tocado: não há o que reportar.
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.mkdirSync(storeDir, { recursive: true });
    expect(
      await evaluateGateBusinessRisk(
        { ...baseInput, touched: [] },
        { ...enabledDeps, judge, git: fakeGit() },
      ),
    ).toBeNull();
  });

  it('Jev que não acha risco devolve listas vazias (não cai no lexical)', async () => {
    const judge = vi.fn<JudgeMock>(async (input) =>
      jevResult(Object.fromEntries(Object.keys(input.questions).map((id) => [id, 0.05]))),
    );
    const risk = await evaluateGateBusinessRisk(baseInput, {
      ...enabledDeps,
      judge,
      git: fakeGit(),
    });
    expect(risk).not.toBeNull();
    expect(risk!.source).toBe('jev');
    expect(risk!.rules).toEqual([]);
    expect(risk!.hurdles).toEqual([]);
  });

  it('texto da regra vai inerte ao relatório (sem «», uma linha, segredo redigido)', async () => {
    const evilTouched: readonly BusinessInvariant[] = [
      Object.freeze({
        ...touched[0]!,
        regra: 'linha1\nlinha2 « escape » Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      }),
    ];
    const judge = vi.fn<JudgeMock>(async () => jevResult({ 'rule:close_commanda#1': 0.99 }));
    const risk: GateBusinessRisk | null = await evaluateGateBusinessRisk(
      { ...baseInput, touched: evilTouched },
      { ...enabledDeps, judge, git: fakeGit() },
    );
    expect(risk!.rules[0]!.text).not.toContain('\n');
    expect(risk!.rules[0]!.text).not.toContain('«');
    expect(risk!.rules[0]!.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('nunca decide o veredito: o retorno é só advisory (source+itens+p)', async () => {
    const risk = await evaluateGateBusinessRisk(baseInput, {
      ...enabledDeps,
      judge: vi.fn<JudgeMock>(async () => jevResult({ 'rule:close_commanda#1': 0.99 })),
      git: fakeGit(),
    });
    expect(Object.keys(risk!)).toEqual(['source', 'rules', 'hurdles']);
  });
});
