/**
 * F-1626: viés da primeira opção. A TypeSafe documenta que o jev-1.13 "leans
 * toward the option that comes first" e manda "reorder the options to double
 * check that the answer stays consistent"
 * (docs.typesafe.ai/model-jaggedness/jev-1.13.md, lido em 21/10/2026).
 *
 * Reperguntar tudo dobraria custo e latência. A suspeita só é real quando a
 * escolha vencedora É a primeira opção listada e a confiança ficou perto do
 * limiar de aceite do chamador: aí uma segunda consulta, só com essas
 * perguntas e as opções na ordem inversa, confirma. Escolha que muda (ou
 * segunda consulta sem resposta) sai do resultado, e o chamador cai no
 * caminho determinístico que já tem para "sem resposta".
 */
import type { JevAnswer, JevQuestion, JevResult, JudgeInput } from '../jev/jev-client';
import { aggregateUsageReceipts } from './decision-usage';

export interface OrderCheckOptions {
  /** Limiar de aceite do chamador para a confiança da escolha. */
  readonly minConfidence: number;
  /** Faixa acima do limiar ainda tratada como limítrofe. */
  readonly band?: number;
}

/** O que a verificação fez, por id de pergunta (sem texto). */
export interface OrderCheckReceipt {
  readonly checked: readonly string[];
  readonly unstable: readonly string[];
}

export const ORDER_CHECK_DEFAULT_BAND = 0.2;

/** Perguntas `choice` cuja resposta é a 1ª opção listada e ficou na faixa limítrofe. */
export function orderCheckCandidates(
  questions: Record<string, JevQuestion>,
  answers: Record<string, JevAnswer>,
  options: OrderCheckOptions,
): string[] {
  const ceiling = options.minConfidence + (options.band ?? ORDER_CHECK_DEFAULT_BAND);
  return Object.entries(questions).flatMap(([id, question]) => {
    const answer = answers[id];
    if (question.type !== 'choice' || answer?.type !== 'choice') return [];
    const first = Object.keys(question.criteria)[0];
    const borderline = answer.confidence >= options.minConfidence && answer.confidence < ceiling;
    return first !== undefined && answer.choice === first && borderline ? [id] : [];
  });
}

/** Só as perguntas pedidas, com as opções na ordem inversa. */
export function reversedChoiceQuestions(
  questions: Record<string, JevQuestion>,
  ids: readonly string[],
): Record<string, JevQuestion> {
  return Object.fromEntries(ids.flatMap((id) => {
    const question = questions[id];
    if (question?.type !== 'choice') return [];
    const reversed = Object.fromEntries(Object.entries(question.criteria).reverse());
    return [[id, { ...question, criteria: reversed }]];
  }));
}

export async function confirmChoiceOrder(
  input: JudgeInput & { orderCheck: OrderCheckOptions },
  result: JevResult,
  run: (input: JudgeInput) => Promise<JevResult | null>,
): Promise<JevResult & { orderCheck?: OrderCheckReceipt }> {
  const ids = orderCheckCandidates(input.questions, result.answers, input.orderCheck);
  if (!ids.length) return result;
  const { orderCheck: _omit, ...rest } = input;
  const second = await run({ ...rest, questions: reversedChoiceQuestions(input.questions, ids) });
  const unstable = ids.filter((id) => {
    const first = result.answers[id];
    const again = second?.answers[id];
    return !(first?.type === 'choice' && again?.type === 'choice' && again.choice === first.choice);
  });
  const answers = Object.fromEntries(
    Object.entries(result.answers).filter(([id]) => !unstable.includes(id)),
  );
  const receipts = [result.usageReceipt, second?.usageReceipt].filter((receipt) => receipt !== undefined);
  return {
    ...result,
    answers,
    orderCheck: { checked: ids, unstable },
    requestCount: (result.requestCount ?? 1) + (second?.requestCount ?? (second ? 1 : 0)),
    ...(typeof result.estimatedUsd === 'number' && typeof second?.estimatedUsd === 'number'
      ? { estimatedUsd: result.estimatedUsd + second.estimatedUsd } : {}),
    ...(receipts.length === 2 ? { usageReceipt: aggregateUsageReceipts(receipts) } : {}),
  };
}
