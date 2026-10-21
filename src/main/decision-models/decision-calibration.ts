/**
 * Entrada para calibrar o roteador v2 (F-1165). Roda os casos rotulados nos
 * modelos da avaliação e MESCLA o resultado na tabela de qualidade (F-1167):
 * só as células medidas de fato são trocadas. Nada aqui é chamado sozinho: o
 * botão "Calibrar modelos" dispara sob clique. Cada consulta sai com o modelo
 * explícito, então só roda de fato no Automático (nos modos fixos a rota do
 * modelo pedido é nula e a observação conta como indisponível).
 */
import { JEV_CALIBRATED_MODEL, LUNA_DECISION_MODEL, type DecisionProvider } from '../../shared/decision-models';
import type { DecisionCalibrationModelResult, DecisionCalibrationPlanModel } from '../../shared/decision-engine-ui';
import type { JevResult, JudgeInput } from '../jev/jev-client';
import { recordJevDecision } from '../jev/jev-decision-log';
import {
  DECISION_EVAL_MODELS, decisionEvalCasesSchema, decisionEvalModelId, evaluateDecisionCases,
  type DecisionEvalCase, type DecisionEvalModel, type DecisionEvalReport,
} from './decision-evaluation';
import { estimateDecisionCostUsd, estimateDecisionInputTokens } from './decision-pricing';
import {
  decisionQualityMeasuredAt, isQualityObservation, mergeAndWriteDecisionQualityTable, type DecisionQualityTable,
} from './decision-quality';
import type { DecisionAvailability } from './decision-routing';

export interface CalibrationResult {
  ok: boolean; written: boolean; report: DecisionEvalReport | null;
  /** Tabela gravada (já mesclada com a anterior); `null` = não gravou. */
  table?: DecisionQualityTable | null;
  /** Cancelada pelo operador: nada é gravado na tabela (o gasto vai ao diário). */
  aborted?: boolean;
}

function providerOf(model: DecisionEvalModel): DecisionProvider {
  return model === 'jev' ? 'jev' : model === 'luna' ? 'luna' : 'clef';
}

/**
 * Uma linha agregada POR MODELO consultado no diário (surface `calibration`):
 * o gasto da calibração aparece nas estatísticas de uso, sem texto de caso.
 */
export function recordCalibrationUsage(report: DecisionEvalReport, record: typeof recordJevDecision = recordJevDecision): void {
  for (const model of DECISION_EVAL_MODELS) {
    const rows = report.observations.filter(row => row.requestedModel === model && row.status !== 'unsupported');
    if (!rows.length) continue;
    const answered = rows.filter(row => row.status === 'answered');
    const sumMeasured = (field: 'inputTokens' | 'usd'): number | null => {
      const known = rows.flatMap(row => row[field] === null ? [] : [row[field]!]);
      return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
    };
    const requestsMeasured = rows.every(row => row.requestCount !== undefined);
    try {
      record({ surface: 'calibration', provider: providerOf(model), model: decisionEvalModelId(model),
        questions: [], probabilities: {}, decision: `calibration:${answered.length}/${rows.length}`,
        inputTokens: sumMeasured('inputTokens'), usd: sumMeasured('usd'),
        requestCount: requestsMeasured ? rows.reduce((sum, row) => sum + row.requestCount!, 0) : undefined,
        usageIncomplete: !requestsMeasured || rows.some(row => row.usageIncomplete || row.usd === null || row.inputTokens === null),
        durationMs: rows.reduce((sum, row) => sum + (row.durationMs ?? 0), 0) });
    } catch { /* o diário nunca derruba a calibração */ }
  }
}

export async function calibrateDecisionQuality(
  rawCases: unknown,
  deps: {
    judge?: (input: JudgeInput) => Promise<JevResult | null>; file?: string; now?: number;
    /** Só estes modelos são consultados (ex.: os que têm credencial). */
    models?: readonly DecisionEvalModel[];
    /** Cancelar: aborta a consulta em voo e para o laço; a tabela não é tocada. */
    signal?: AbortSignal;
    recordUsage?: (report: DecisionEvalReport) => void;
  } = {},
): Promise<CalibrationResult> {
  const parsed = decisionEvalCasesSchema.safeParse(rawCases);
  if (!parsed.success) return { ok: false, written: false, report: null };
  const judgeFn = deps.judge ?? (async (input: JudgeInput) => {
    // Tardio: o cliente puxa o cofre e o Electron; a calibração é sob demanda.
    const { judge } = await import('../jev/jev-client');
    return judge(input);
  });
  const report = await evaluateDecisionCases(parsed.data as DecisionEvalCase[],
    // Sem 2ª tentativa no timeout: a calibração é longa e o operador espera na tela.
    (model, input) => judgeFn({ ...input, model: decisionEvalModelId(model), retryOnTimeout: false,
      ...(deps.signal ? { signal: deps.signal } : {}) }), deps.models, deps.signal);
  (deps.recordUsage ?? recordCalibrationUsage)(report);
  if (deps.signal?.aborted) return { ok: true, written: false, report, table: null, aborted: true };
  const table = mergeAndWriteDecisionQualityTable(report, { file: deps.file, now: deps.now });
  return { ok: true, written: table !== null, report, table };
}

/** Modelos com credencial; o resto é pulado na calibração. */
export function calibrationModelsAvailable(available: DecisionAvailability): DecisionEvalModel[] {
  return DECISION_EVAL_MODELS.filter(model => {
    const provider = providerOf(model);
    return provider === 'luna' ? available.luna === true : available[provider];
  });
}

/** Custo estimado ANTES de rodar: tokens estimados dos casos × tarifa de entrada de cada modelo. */
export function estimateCalibration(
  cases: readonly DecisionEvalCase[], available: readonly DecisionEvalModel[], current: DecisionQualityTable | null = null,
): DecisionCalibrationPlanModel[] {
  const tokens = cases.reduce((sum, testCase) => sum + estimateDecisionInputTokens(
    { state: testCase.state, questions: testCase.questions, images: testCase.images }), 0);
  return DECISION_EVAL_MODELS.map(model => {
    const routeModel = model === 'luna' ? LUNA_DECISION_MODEL : model === 'jev' ? JEV_CALIBRATED_MODEL : model;
    return { model, available: available.includes(model), estimatedTokens: tokens,
      estimatedUsd: estimateDecisionCostUsd(tokens, providerOf(model), routeModel),
      measuredAt: decisionQualityMeasuredAt(current, model) };
  });
}

function mostFrequent(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | undefined;
  for (const [value, count] of counts) if (best === undefined || count > counts.get(best)!) best = value;
  return best;
}

/** Resumo por modelo para a tela: acurácia, p95, custo e a data da medição em vigor. */
export function summarizeCalibration(
  report: DecisionEvalReport, consulted: readonly DecisionEvalModel[], table: DecisionQualityTable | null = null,
): DecisionCalibrationModelResult[] {
  return DECISION_EVAL_MODELS.map(model => {
    const score = report.models[model];
    const skipped = !consulted.includes(model);
    // Mesmo denominador da tabela de qualidade: indisponibilidade não conta como erro.
    const measured = report.observations.filter(row => row.requestedModel === model && isQualityObservation(row));
    const correct = measured.filter(row => row.correct === true).length;
    const failureReason = mostFrequent(report.observations.flatMap(row =>
      row.requestedModel === model && row.status === 'failed' && row.failureReason ? [row.failureReason] : []));
    return { model, skipped, answered: score.answered, failures: score.failures,
      accuracy: skipped || measured.length === 0 ? null : correct / measured.length,
      p95Ms: score.p95Ms, usd: skipped ? 0 : score.usd, measuredAt: decisionQualityMeasuredAt(table, model),
      ...(failureReason ? { failureReason } : {}) };
  });
}
