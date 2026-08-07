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

import { appendMissionVerdict } from '../../shared/mission-block-cause';

/** Stable names for the four mission gates' lower-tier paths. */
export const MISSION_DEGRADATION_PATHS = Object.freeze({
  planner: 'planner.single-writer',
  prevc: 'prevc.simple-path',
  kickoff: 'kickoff.nudge-retry',
  bootstrap: 'bootstrap.reconcile',
} as const);

export type MissionDegradationPath =
  (typeof MISSION_DEGRADATION_PATHS)[keyof typeof MISSION_DEGRADATION_PATHS];

export interface MissionDegradation {
  /** Capacidade que faltou. */
  readonly what: string;
  /** O que foi entregue no lugar. */
  readonly reducedTo: string;
  /** Por que foi reduzido, em linguagem do operador. */
  readonly why: string;
  /** Dá para recuperar depois (configurar algo, reaprovar)? */
  readonly recoverable: boolean;
  /** Stable gate path used by journal/restart recovery. */
  readonly path?: MissionDegradationPath;
}

export const MISSION_DEGRADATION_MARKER = '<!-- nexus:mission-degradation -->';
export const MISSION_DEGRADATION_TOKEN = '[NEXUS_DEGRADED]';

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
  const path = degradation.path ? `[${degradation.path}] ` : '';
  return (
    `${path}${degradation.what} reduzido para ${degradation.reducedTo} — ` +
    `${degradation.why}. ${tail}`
  );
}

/** Human-readable handoff to the inactivity network after a downgrade. */
export function describeMissionDegradationNetwork(
  degradation: MissionDegradation,
): string {
  const path = degradation.path ?? 'mission.degradation';
  return (
    `Rede D1 ativa (${path}): se o próximo passo ficar inativo, ` +
    'o nudge tenta reengajar e a inatividade reentra/recolhe um resultado; ' +
    'não é necessário travar a missão.'
  );
}

/**
 * Surface one or more D1 reasons on the mission card.
 *
 * `appendMissionVerdict` is intentionally idempotent on its HTML marker, so a
 * naive loop over degradations would keep only the first reason and silently
 * drop the rest (and a later PREVC degrade would no-op after a planner note).
 * Join first write via the marker; further distinct reasons extend the line.
 */
export function appendMissionDegradationNote(
  description: string,
  reason: string,
): string {
  const trimmed = reason.trim();
  if (!trimmed) return description;
  if (!description.includes(MISSION_DEGRADATION_MARKER)) {
    return appendMissionVerdict(
      description,
      MISSION_DEGRADATION_MARKER,
      MISSION_DEGRADATION_TOKEN,
      trimmed,
    );
  }
  if (description.includes(trimmed)) return description;
  const tokenAt = description.indexOf(MISSION_DEGRADATION_TOKEN);
  if (tokenAt < 0) {
    return appendMissionVerdict(
      description,
      MISSION_DEGRADATION_MARKER,
      MISSION_DEGRADATION_TOKEN,
      trimmed,
    );
  }
  const lineEnd = description.indexOf('\n', tokenAt);
  const end = lineEnd === -1 ? description.length : lineEnd;
  return `${description.slice(0, end).trimEnd()} | ${trimmed}${description.slice(end)}`;
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
  // Squad: D1 uses nexus-story-impl / live roster for missing/stale/unbound.
  // Only the residual throw (default roster also gone) stays legitimate.
  'guided_plan_squad_missing',
  // roster_too_large: D1 truncates to 64 (no throw).
  // Ownership vazia *após* fallback greenfield: sem superfície ainda é parede.
  'guided_plan_ownership_missing',
  'guided_plan_ownership_invalid',
  'wave_pack_ownership_missing',
  'guided_team_fanout_empty',
  // PREVC: contract/route/late-freeze and sync freeze_failed remain walls.
  // Bootstrap/incomplete: D1 async boundary degrades (no throw).
  'guided_prevc_contract_missing',
  'guided_prevc_contract_stale',
  'guided_prevc_freeze_failed',
  'guided_prevc_invalid_route',
  'guided_prevc_late_freeze_blocked',
  // Sem o canal Main-owned não existe fallback seguro para dirigir o PTY do
  // Autopiloto. Injetar diretamente degradaria autoridade, não capacidade.
  'pty_mission_control_unavailable',
  // Concorrência: recuperação em curso não é falta de capacidade, é espera.
  'recovery_lock_busy',
]);
