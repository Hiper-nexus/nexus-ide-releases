import type { JevQuestion } from '../jev/jev-client';

/**
 * Resposta REAL do endpoint `POST /v1/systemone` (jev-1.13.0), capturada em 01/10/2026
 * com o CLI `jev ask` e estado sintético (nenhum dado de cliente). As 16 respostas
 * medidas nessa data somavam exatamente 1,0000 e traziam `usage`: este arquivo é a
 * prova de que a validação tolerante do Jev aceita o formato de produção.
 */
export const JEV_REAL_QUESTIONS: Record<string, JevQuestion> = {
  is_failure: { type: 'noul', instructions: 'A tarefa descrita falhou?' },
  kind: { type: 'choice', instructions: 'Que tipo de falha é esta?', criteria: { flaky: 'intermitente', environment: 'ambiente', regression: 'regressão de código' } },
  severity: { type: 'score', instructions: 'Qual a gravidade para o usuário?', criteria: ['cosmética', 'incômoda', 'bloqueia uma tarefa', 'perda de dados'] },
};

export function jevRealResponse() {
  return {
    model: 'jev-1.13.0',
    answers: {
      is_failure: { type: 'noul', noul: 0.65 },
      kind: { type: 'choice', choice: 'flaky', confidence: 0.99, probabilities: { flaky: 0.99, regression: 0, environment: 0.01 } },
      severity: {
        type: 'score', score: 1.08, confidence: 0.88,
        legend: { '0': 'cosmética', '1': 'incômoda', '2': 'bloqueia uma tarefa', '3': 'perda de dados' },
        probabilities: { '0': 0.02, '1': 0.88, '2': 0.1, '3': 0 },
      },
    },
    usage: { input_tokens: 422, output_tokens: 73 },
  };
}

/** Real vault-backed nexus_judge response on 2026-10-14; synthetic connectivity only, not calibration. */
export const JEV_114_CONNECTION_RESPONSE = {
  model: 'jev-1.14.0',
  answers: { available: { type: 'noul' as const, noul: 0.96 } },
  usage: { input_tokens: 291, output_tokens: 20 },
};
