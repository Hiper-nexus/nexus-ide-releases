import {
  hasCurrentApprovedDispatchContract,
  type MissionIntentContract,
} from './mission-intent';
import { wasUpdatedBeforeThisProcess } from './session-restore-liveness';

export const TERMINAL_OPERATIONAL_FAILURE_MARKER =
  '[NEXUS_FAILURE:terminal]';
export const MISSION_RUNTIME_CLOSED_MARKER =
  '<!-- nexus:runtime-closed -->';

/**
 * O humano aprovou a entrega.
 *
 * O motor concluir NÃO encerra a missão: a entrega ainda precisa passar pela
 * revisão de quem pediu, que pode não aprovar. Enquanto este marcador não
 * existir, a missão fica "Aguardando você" — com "Pedir um ajuste" e "Marcar
 * como feito" na tela. Marcador durável na descrição, mesmo padrão de
 * MISSION_RUNTIME_CLOSED_MARKER: sem migração de schema.
 */
export const MISSION_OPERATOR_APPROVED_MARKER =
  '<!-- nexus:operator-approved -->';

export function wasMissionApprovedByOperator(
  mission: Pick<RecoverableMission, 'description'>,
): boolean {
  return (mission.description ?? '').includes(
    MISSION_OPERATOR_APPROVED_MARKER,
  );
}

/** Concluída pelo motor, ainda não aprovada por quem pediu. */
export function missionAwaitsOperatorReview(
  mission: Pick<RecoverableMission, 'status' | 'description'>,
): boolean {
  return mission.status === 'done' && !wasMissionApprovedByOperator(mission);
}

export function wasMissionRuntimeClosedByOperator(
  mission: Pick<RecoverableMission, 'status' | 'intentState' | 'description'>,
): boolean {
  // Bug I (2026-08-17): o teardown do shutdown podia deixar a missão em
  // blocked_technical com o marcador presente — e o marcador é escrito
  // APENAS pelo caminho de encerramento pelo operador. A presença dele numa
  // missão bloqueada é prova suficiente, qualquer que seja o intent final
  // da corrida. (Antes exigia blocked_user e o shutdown virava alerta.)
  return (
    mission.status === 'blocked' &&
    (mission.description ?? '').includes(MISSION_RUNTIME_CLOSED_MARKER)
  );
}

export function hasTerminalOperationalFailureMarker(value: string): boolean {
  return value.includes(TERMINAL_OPERATIONAL_FAILURE_MARKER);
}

interface RecoverableMission {
  readonly status: string;
  readonly intentState?: string;
  readonly description?: string;
  readonly intentVersion?: number | null;
  readonly intentContract?: MissionIntentContract | null;
  /**
   * Última escrita da linha. Uma missão bloqueada cujo updatedAt é anterior ao
   * boot DESTE processo não tem dono vivo de retry — nada re-hidrata recovery
   * no boot, então sem este guarda-chuva ela dizia "Recuperando"/"Trabalhando"
   * para sempre (caso real: "teste sistenma" 28/07, 25 dias ativa na rail).
   */
  readonly updatedAt?: number | null;
}

const AUTOMATIC_RECOVERY_INTENT_STATES = new Set([
  'blocked_technical',
  // Persisted pre-normalization pairs produced by older launch failures.
  'dispatched',
  'executing',
  'validating',
]);

/**
 * Exact durable condition owned by the automatic bootstrap recovery loop.
 * A technical-looking legacy row without current approval is a human stop,
 * not work that the UI may promise will resume by itself. A leftover row from
 * before this process booted has no living retry owner either — if Main
 * resumes the retry it touches the row and the mission becomes current again,
 * truthfully.
 */
export function hasAutomaticTechnicalRecovery(
  mission: RecoverableMission,
): boolean {
  return (
    mission.status === 'blocked' &&
    AUTOMATIC_RECOVERY_INTENT_STATES.has(mission.intentState ?? '') &&
    !wasUpdatedBeforeThisProcess(mission.updatedAt ?? NaN) &&
    hasCurrentApprovedDispatchContract(mission) &&
    !hasTerminalOperationalFailureMarker(mission.description ?? '')
  );
}

/**
 * The durable proof that an automatic recovery attempt happened. The block is
 * REPLACED attempt after attempt (never stacked), and its absence means either
 * no attempt ran yet or an old build never persisted one — the UI must treat
 * both as "unknown", never as "zero".
 */
export const RECOVERY_ATTEMPT_BLOCK_MARKER = '<!-- nexus:recovery-attempt -->';

const RECOVERY_ATTEMPT_REASON_LIMIT = 240;

export interface MissionRecoveryAttemptRecord {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly reason: string;
  readonly at: string;
}

export function formatRecoveryAttemptBlock(
  attempt: number,
  maxAttempts: number,
  reason: string,
  at: string,
): string {
  const cappedReason =
    reason.trim().length > RECOVERY_ATTEMPT_REASON_LIMIT
      ? `${reason.trim().slice(0, RECOVERY_ATTEMPT_REASON_LIMIT)}…`
      : reason.trim();
  return [
    RECOVERY_ATTEMPT_BLOCK_MARKER,
    '## Recuperação automática',
    `Tentativa ${attempt} de ${maxAttempts} · ${cappedReason} · ${at}`,
  ].join('\n');
}

const RECOVERY_ATTEMPT_LINE =
  /^Tentativa (\d+) de (\d+) · ([\s\S]*) · (\d{4}-\d{2}-\d{2}T[\d:.Z+-]+)\s*$/;

/**
 * Reads back what `formatRecoveryAttemptBlock` wrote. Defensive on purpose:
 * the description is operator-editable, so a torn block parses to null
 * instead of throwing or inventing numbers.
 */
export function parseRecoveryAttemptBlock(
  description: string,
): MissionRecoveryAttemptRecord | null {
  const markerIndex = description.lastIndexOf(RECOVERY_ATTEMPT_BLOCK_MARKER);
  if (markerIndex < 0) return null;
  for (const line of description
    .slice(markerIndex + RECOVERY_ATTEMPT_BLOCK_MARKER.length)
    .split('\n')) {
    const match = RECOVERY_ATTEMPT_LINE.exec(line.trim());
    if (!match) continue;
    return {
      attempt: Number(match[1]),
      maxAttempts: Number(match[2]),
      reason: match[3].trim(),
      at: match[4],
    };
  }
  return null;
}

/** Removes the recovery-attempt block (marker through its last line). */
export function stripRecoveryAttemptBlock(description: string): string {
  const markerIndex = description.lastIndexOf(RECOVERY_ATTEMPT_BLOCK_MARKER);
  if (markerIndex < 0) return description;
  const before = description.slice(0, markerIndex).trimEnd();
  const headerIndex = description.indexOf('## ', markerIndex);
  const nextSectionIndex = description.indexOf(
    '\n## ',
    headerIndex >= 0 ? headerIndex : markerIndex,
  );
  const after =
    nextSectionIndex >= 0 ? description.slice(nextSectionIndex + 1) : '';
  return [before, after].filter(Boolean).join('\n\n');
}

/** Replaces an existing recovery-attempt block, or appends the new one. */
export function replaceRecoveryAttemptBlock(
  description: string,
  block: string,
): string {
  const stripped = stripRecoveryAttemptBlock(description).trimEnd();
  return stripped ? `${stripped}\n\n${block}` : block;
}
