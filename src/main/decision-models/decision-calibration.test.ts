import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { JevResult, JudgeInput } from '../jev/jev-client';
import { DECISION_CALIBRATION_CASES } from './decision-calibration-cases';
import {
  calibrateDecisionQuality, calibrationModelsAvailable, estimateCalibration, recordCalibrationUsage, summarizeCalibration,
} from './decision-calibration';
import { decisionEvalCasesSchema, evaluateDecisionCases, type DecisionEvalCase } from './decision-evaluation';
import { JEV_PINNED_SURFACES, REVERSIBLE_ENSEMBLE_SURFACES } from './decision-routing';
import { decisionQualityTableSchema, MIN_QUALITY_CASES } from './decision-quality';

describe('F-1167: conjunto rotulado embutido', () => {
  it('é válido, ≥5 casos por surface roteada, cobre sim/não, escolha e escala e as duas divisões', () => {
    expect(decisionEvalCasesSchema.safeParse(DECISION_CALIBRATION_CASES).success).toBe(true);
    const bySurface = new Map<string, DecisionEvalCase[]>();
    for (const testCase of DECISION_CALIBRATION_CASES) bySurface.set(testCase.surface, [...(bySurface.get(testCase.surface) ?? []), testCase]);
    expect(new Set(bySurface.keys())).toEqual(new Set(['toolPick', 'paneState', 'intake', 'researchTriage', 'taskRouting', 'missionPick',
      'catalogPick', 'missionKickoff', 'reviewTriage', 'recoveryAdvice', 'completionCheck']));
    for (const [, rows] of bySurface) {
      expect(rows.length).toBeGreaterThanOrEqual(5);
      expect(rows.length).toBeLessThan(MIN_QUALITY_CASES);
      expect(new Set(rows.map(row => row.split))).toEqual(new Set(['development', 'heldout']));
    }
    // As reversíveis estão cobertas pelo smoke, ainda sem amostra para ensemble.
    for (const surface of REVERSIBLE_ENSEMBLE_SURFACES) expect(bySurface.get(surface)?.length ?? 0).toBeGreaterThanOrEqual(5);
    // taskRouting preserva seus casos históricos; o pino no Jev vence a medição.
    for (const surface of JEV_PINNED_SURFACES) expect(bySurface.has(surface)).toBe(surface === 'taskRouting');
    const types = new Set(DECISION_CALIBRATION_CASES.flatMap(testCase => Object.values(testCase.questions).map(question => question.type)));
    expect([...types].sort()).toEqual(['choice', 'noul', 'score']);
  });

  it('custo estimado barato: os cinco modelos juntos ficam abaixo de US$ 0,01', () => {
    const plan = estimateCalibration(DECISION_CALIBRATION_CASES, ['jev', 'clef', 'clef-flash', 'clef-omni', 'luna']);
    expect(plan.reduce((sum, row) => sum + row.estimatedUsd, 0)).toBeLessThan(0.01);
  });

  it('sem dado sensível: nada parecido com chave, token, e-mail ou caminho de usuário', () => {
    const text = JSON.stringify(DECISION_CALIBRATION_CASES);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{8,}|ghp_|AKIA[0-9A-Z]{12}|[\w.+-]+@[\w-]+\.\w+|\/Users\/|C:\\\\Users/);
  });
});

describe('F-1167: calibração só nos modelos com credencial', () => {
  const answer = (input: JudgeInput): JevResult => ({
    model: String(input.model), usage: { input_tokens: 300, output_tokens: 0 }, durationMs: 120,
    answers: Object.fromEntries(Object.entries(input.questions).map(([id, question]) => [id,
      question.type === 'noul' ? { type: 'noul', noul: 0.9 }
        : question.type === 'choice' ? { type: 'choice', choice: Object.keys(question.criteria)[0]!, probabilities: {}, confidence: 0.9 }
          : { type: 'score', score: 1, legend: {}, probabilities: {}, confidence: 0.9 }])),
  }) as JevResult;

  it('availability → modelos; Clef cobre as três variantes', () => {
    expect(calibrationModelsAvailable({ jev: true, clef: false, luna: true })).toEqual(['jev', 'luna']);
    expect(calibrationModelsAvailable({ jev: false, clef: true })).toEqual(['clef', 'clef-flash', 'clef-omni']);
    expect(calibrationModelsAvailable({ jev: false, clef: false, luna: false })).toEqual([]);
  });

  it('estimativa = tokens dos casos × tarifa de cada modelo; Clef cheio custa mais que o Flash', () => {
    const plan = estimateCalibration(DECISION_CALIBRATION_CASES, ['jev', 'clef', 'clef-flash']);
    const byModel = Object.fromEntries(plan.map(row => [row.model, row]));
    expect(byModel.jev!.estimatedTokens).toBeGreaterThan(20 * 100);
    expect(byModel.clef!.estimatedUsd).toBeGreaterThan(byModel['clef-flash']!.estimatedUsd);
    expect(byModel.clef!.estimatedUsd).toBeCloseTo(byModel.clef!.estimatedTokens * 0.24 / 1_000_000, 12);
    expect(byModel.luna).toMatchObject({ available: false });
  });

  it('só consulta os modelos pedidos, sem 2ª tentativa no timeout, e grava a tabela sem célula para os pulados', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-'));
    try {
      const judge = vi.fn(async (input: JudgeInput) => answer(input));
      const recordUsage = vi.fn();
      const file = path.join(dir, 'quality-table.json');
      const total = DECISION_CALIBRATION_CASES.length;
      const result = await calibrateDecisionQuality(DECISION_CALIBRATION_CASES, { judge, file, now: 5, models: ['jev'], recordUsage });
      expect(result.ok).toBe(true);
      expect(result.written).toBe(true);
      expect(judge).toHaveBeenCalledTimes(total);
      expect(judge.mock.calls.every(([input]) => input.retryOnTimeout === false)).toBe(true);
      expect(new Set(judge.mock.calls.map(([input]) => input.model))).toEqual(new Set([process.env.NEXUS_JEV_MODEL ?? 'jev-latest']));
      expect(recordUsage).toHaveBeenCalledTimes(1);
      const table = decisionQualityTableSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      expect(Object.keys(table.models)).toEqual(['jev']);
      expect(table.models.jev!.generatedAt).toBe(5);
      const summary = summarizeCalibration(result.report!, ['jev'], result.table ?? null);
      expect(summary.find(row => row.model === 'jev')).toMatchObject({ skipped: false, answered: total, measuredAt: 5 });
      expect(summary.find(row => row.model === 'luna')).toMatchObject({ skipped: true, accuracy: null, usd: 0, measuredAt: null });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('P2-1: calibração nova não apaga a medição já paga de quem foi pulado ou ficou indisponível', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-merge-'));
    try {
      const file = path.join(dir, 'quality-table.json');
      const judge = vi.fn(async (input: JudgeInput) => answer(input));
      await calibrateDecisionQuality(DECISION_CALIBRATION_CASES, { judge, file, now: 100, models: ['jev', 'luna'], recordUsage: () => {} });
      const before = decisionQualityTableSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      expect(before.models.luna).toBeDefined();
      // Segunda rodada: só o Jev, e a Luna "indisponível" (rede) nem entraria como medição.
      const flaky = vi.fn(async (input: JudgeInput) => {
        if (String(input.model).includes('luna')) { input.onNoAnswer?.('network'); return null; }
        return answer(input);
      });
      await calibrateDecisionQuality(DECISION_CALIBRATION_CASES, { judge: flaky, file, now: 200, models: ['jev', 'luna'], recordUsage: () => {} });
      const after = decisionQualityTableSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      expect(after.models.jev!.generatedAt).toBe(200);
      expect(after.models.luna).toEqual(before.models.luna);
      expect(after.models.luna!.generatedAt).toBe(100);
      expect(after.surfaces.toolPick!.luna!.generatedAt).toBe(100);
      expect(after.surfaces.toolPick!.jev!.generatedAt).toBe(200);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('P3: cancelar para o laço, repassa o sinal ao judge, não grava a tabela e ainda registra o gasto', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-abort-'));
    try {
      const file = path.join(dir, 'quality-table.json');
      const controller = new AbortController();
      const recordUsage = vi.fn();
      const judge = vi.fn(async (input: JudgeInput) => {
        if (judge.mock.calls.length === 3) controller.abort();
        expect(input.signal).toBe(controller.signal);
        return answer(input);
      });
      const result = await calibrateDecisionQuality(DECISION_CALIBRATION_CASES, { judge, file, models: ['jev'], signal: controller.signal, recordUsage });
      expect(result).toMatchObject({ ok: true, written: false, aborted: true });
      expect(judge).toHaveBeenCalledTimes(3);
      expect(fs.existsSync(file)).toBe(false);
      expect(recordUsage).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('P3: uma linha agregada por modelo no diário (surface calibration), sem texto de caso', async () => {
    const report = await evaluateDecisionCases(DECISION_CALIBRATION_CASES.slice(0, 6), async (_model, input) => answer(input), ['jev', 'clef-flash']);
    const record = vi.fn((_entry: Record<string, unknown>) => 'id');
    recordCalibrationUsage(report, record as never);
    expect(record).toHaveBeenCalledTimes(2);
    const jev = record.mock.calls.find(([entry]) => entry.provider === 'jev')![0];
    expect(jev).toMatchObject({ surface: 'calibration', decision: 'calibration:6/6', requestCount: 6, questions: [], probabilities: {} });
    expect(record.mock.calls.find(([entry]) => entry.provider === 'clef')![0]).toMatchObject({ model: 'clef-flash' });
    expect(JSON.stringify(record.mock.calls)).not.toContain('terminal');
  });

  it('indisponibilidade não conta como erro na acurácia mostrada', async () => {
    const report = await evaluateDecisionCases(DECISION_CALIBRATION_CASES.slice(0, 4), async (_model, input) => {
      input.onNoAnswer?.('network');
      return null;
    }, ['jev']);
    expect(summarizeCalibration(report, ['jev']).find(row => row.model === 'jev')).toMatchObject({ accuracy: null, failures: 4 });
  });

  it('a tela recebe o motivo mais comum das falhas (Luna sem acesso à API aparecia só como "Sem resposta")', async () => {
    let call = 0;
    const report = await evaluateDecisionCases(DECISION_CALIBRATION_CASES.slice(0, 5), async (_model, input) => {
      input.onNoAnswer?.(call++ === 0 ? 'network' : 'client-error');
      return null;
    }, ['luna']);
    const summary = summarizeCalibration(report, ['luna']);
    expect(summary.find(row => row.model === 'luna')).toMatchObject({ failures: 5, failureReason: 'client-error' });
    expect(summary.find(row => row.model === 'jev')).not.toHaveProperty('failureReason');
  });
});
