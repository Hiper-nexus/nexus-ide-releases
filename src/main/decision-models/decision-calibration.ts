/**
 * Entrada pronta para calibrar o roteador v2 (F-1165). Roda os casos
 * rotulados em todos os modelos da avaliação e grava a tabela de qualidade.
 * Nada aqui é chamado sozinho: a Fase 3 liga um botão "Calibrar". Cada
 * consulta sai com o modelo explícito, então só roda de fato no Automático
 * (nos modos fixos a rota do modelo pedido é nula e a observação conta como
 * indisponível, fora da qualidade).
 */
import type { JevResult, JudgeInput } from '../jev/jev-client';
import {
  decisionEvalCasesSchema, decisionEvalModelId, evaluateDecisionCases, type DecisionEvalCase, type DecisionEvalReport,
} from './decision-evaluation';
import { writeDecisionQualityTable } from './decision-quality';

export interface CalibrationResult { ok: boolean; written: boolean; report: DecisionEvalReport | null }

export async function calibrateDecisionQuality(
  rawCases: unknown,
  deps: { judge?: (input: JudgeInput) => Promise<JevResult | null>; file?: string; now?: number } = {},
): Promise<CalibrationResult> {
  const parsed = decisionEvalCasesSchema.safeParse(rawCases);
  if (!parsed.success) return { ok: false, written: false, report: null };
  const judgeFn = deps.judge ?? (async (input: JudgeInput) => {
    // Tardio: o cliente puxa o cofre e o Electron; a calibração é sob demanda.
    const { judge } = await import('../jev/jev-client');
    return judge(input);
  });
  const report = await evaluateDecisionCases(parsed.data as DecisionEvalCase[],
    (model, input) => judgeFn({ ...input, model: decisionEvalModelId(model) }));
  return { ok: true, written: writeDecisionQualityTable(report, { file: deps.file, now: deps.now }), report };
}
