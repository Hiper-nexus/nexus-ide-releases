/**
 * Contrafactual do recibo da rota: "o que a REGRA teria escolhido".
 *
 * Quando o Jev influenciou a classificação (tier/especialidade/esforço), o
 * recibo diz também o que a heurística + tabela escolheriam sozinhas — para a
 * pessoa e o agente que spawnou auditarem se o Jev mudou a rota ou só confirmou
 * o que a regra já faria.
 *
 * O recálculo é uma chamada em memória a `routeTask` SEM os overrides do Jev
 * (o chamador monta `routeByRule`). `routeTask` é livre de efeito de rota: não
 * grava reserva, proveniência nem log, e não consome contador. O que ela toca
 * é idempotente — expira entrada vencida do circuit breaker/quarentena (efeito
 * do relógio, não da chamada) e deduplica o aviso de modelo ausente. Por isso o
 * resultado do contrafactual NUNCA passa por `recordRouteDecision`: registrar a
 * escolha da regra como se fosse uma rota decidida abriria o gate de spawn
 * ad-hoc (`adHocSpawnGateError`) para um modelo que ninguém roteou.
 *
 * Privacidade: só `adapterId`/`model`/`effort` saem daqui. O texto da tarefa, o
 * `reason` (que cita sinais da tarefa), as alternativas e qualquer dado de
 * conta ficam na decisão da regra e morrem aqui.
 */
import {
  parseSpawnRuleChoice,
  type SpawnRuleChoiceReceipt,
} from '../../shared/spawn-route';

/** O mínimo que o contrafactual lê de uma decisão de rota. */
export interface RouteChoiceLike {
  readonly adapterId: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface RuleChoiceReceiptInput {
  /** O Jev decidiu ao menos uma dimensão (`classifierSource !== 'heuristic'`). */
  readonly jevInfluenced: boolean;
  /** A decisão final, a mesma que o spawn vai usar. */
  readonly final: RouteChoiceLike;
  /**
   * Roteia só pela regra (sem tier/especialidade/esforço do Jev) e devolve a
   * decisão já pós-processada como a final. Pura; pode lançar ou devolver null.
   */
  readonly routeByRule: () => RouteChoiceLike | null;
}

function sameChoice(left: RouteChoiceLike, right: RouteChoiceLike): boolean {
  return (
    left.adapterId === right.adapterId &&
    (left.model ?? undefined) === (right.model ?? undefined) &&
    (left.effort ?? undefined) === (right.effort ?? undefined)
  );
}

/**
 * `undefined` = sem contrafactual (Jev não influenciou, ou o recálculo falhou —
 * um recibo nunca derruba a rota); `'same'` = a regra chegaria ao mesmo lugar;
 * objeto = o que a regra escolheria, só quando difere da decisão final.
 */
export function ruleChoiceReceipt(
  input: RuleChoiceReceiptInput,
): SpawnRuleChoiceReceipt | undefined {
  if (!input.jevInfluenced) return undefined;
  let rule: RouteChoiceLike | null;
  try {
    rule = input.routeByRule();
  } catch (error) {
    console.warn(
      '[route_task] contrafactual da regra falhou (ignorado):',
      error instanceof Error ? error.message : 'erro desconhecido',
    );
    return undefined;
  }
  if (!rule) return undefined;
  if (sameChoice(input.final, rule)) return 'same';
  return parseSpawnRuleChoice({
    adapterId: rule.adapterId,
    model: rule.model,
    effort: rule.effort,
  });
}
