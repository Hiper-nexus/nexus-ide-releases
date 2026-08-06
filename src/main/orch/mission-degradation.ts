/**
 * Doutrina D1 — NUNCA BLOQUEIE, SEMPRE DEGRADE.
 *
 * Falta de capacidade deve entregar o melhor tier FUNCIONANDO, nunca uma
 * parede. Quase toda morte do operador em 06/08 foi capacidade ausente
 * respondida com erro tecnicamente correto e inútil: worktree ausente, PREVC
 * não congelado, ownership não mapeada, provider de voz ausente — todas tinham
 * um resultado menor disponível.
 *
 * Três regras:
 *  1. falta de capacidade ⇒ entregar o tier possível;
 *  2. a redução é SEMPRE visível, com o motivo (degradar em silêncio troca uma
 *     doença por outra — foi o veredito de teto que virou "está trabalhando");
 *  3. bloquear só quando NÃO existe resultado menor — e aí ser acionável.
 *
 * Ver docs/analysis/2026-08-06-degradar-nunca-errar.md.
 */

export interface MissionDegradation {
  /** Capacidade que faltou. */
  readonly what: string;
  /** O que foi entregue no lugar. */
  readonly reducedTo: string;
  /** Por que foi reduzido, em linguagem do operador. */
  readonly why: string;
  /** Dá para recuperar depois (configurar algo, reaprovar)? */
  readonly recoverable: boolean;
}

/**
 * Linha visível no card da missão — mesma superfície do veredito de teto, que
 * é o precedente que funcionou.
 */
export function describeMissionDegradation(
  degradation: MissionDegradation,
): string {
  const tail = degradation.recoverable
    ? 'Dá para recuperar depois.'
    : 'Não reversível nesta missão.';
  return (
    `${degradation.what} reduzido para ${degradation.reducedTo} — ` +
    `${degradation.why}. ${tail}`
  );
}

/**
 * Bloqueios LEGÍTIMOS do caminho da missão: aqueles em que não existe resultado
 * menor funcionando, só resultado FALSO.
 *
 * Entrar aqui exige justificar por que degradar produziria mentira em vez de
 * entrega menor. O teste de guarda quebra o build quando um código novo aparece
 * fora desta lista — é o que impede a doutrina de virar prosa daqui a três meses.
 */
export const LEGITIMATE_MISSION_BLOCKS: ReadonlySet<string> = new Set([
  // Corrupção de topologia: o receipt selado mistura Pack e delivery. Degradar
  // seria escolher arbitrariamente uma das duas e chamar de plano.
  'guided_plan_mixed_topology_blocked',
  // Receipt legado/incompleto: sem executor e quality gate canônicos não há
  // entrega a validar — só a aparência de uma.
  'guided_plan_legacy_receipt_blocked',
  'guided_plan_receipt_missing',
  'guided_plan_contract_missing',
  // Autoridade do squad: sem roster aprovado não existe "versão menor" do
  // trabalho — existe trabalho de ninguém.
  'guided_plan_squad_missing',
  'guided_plan_squad_stale',
  'guided_plan_squad_unbound',
  'guided_plan_roster_too_large',
  // Ownership vazia: sem superfície declarada, degradar significaria escrever
  // em lugar nenhum ou em todo lugar.
  'guided_plan_ownership_missing',
  'guided_plan_ownership_invalid',
  // Idem para o Pack: story sem superfície declarada não tem onde escrever.
  'wave_pack_ownership_missing',
  'guided_team_fanout_empty',
  // PREVC: congelamento de contexto é autoridade de contrato, não capacidade
  // opcional. Um freeze pela metade valida contra contexto que não existe.
  'guided_prevc_contract_missing',
  'guided_prevc_contract_stale',
  'guided_prevc_freeze_failed',
  'guided_prevc_freeze_incomplete',
  'guided_prevc_invalid_route',
  'guided_prevc_late_freeze_blocked',
  'guided_prevc_context_bootstrap_blocked',
  // Concorrência: recuperação em curso não é falta de capacidade, é espera.
  'recovery_lock_busy',
]);
