/**
 * Isolamento durável de leftover (Overclock-class, sem copiar Overclock).
 *
 * Uma missão focused neste processo ganha o orçamento de panes vivos.
 * As outras dormem na rail sem PTY. Restart restaura o card, não a equipe.
 *
 * Régua de persist-on-sleep (referência Orca, implementação Nexus): o
 * Encerrar/park grava leftover não-running no SQLite ANTES de soltar o
 * PTY. Reopen lê o card e NÃO remonta. Só Retomar do operador religa.
 *
 * A UI já pintava Parou/Dormindo a partir de flag de layout enquanto o
 * SQLite ficava `status=running`. No reopen o motor remontava Maestro
 * zumbi e roubava maxWorkers. Este módulo persiste um status não-running
 * e impede remount automático.
 */

import { appendMissionVerdict } from './mission-block-cause';
import {
  MISSION_RUNTIME_CLOSED_MARKER,
  wasMissionRuntimeClosedByOperator,
} from './mission-recovery-policy';
import { wasUpdatedBeforeThisProcess } from './session-restore-liveness';

export const NEXUS_LEFTOVER_PARKED_MARKER = '<!-- nexus:leftover-parked -->';
export const NEXUS_LEFTOVER_PARKED_TOKEN = '[NEXUS_LEFTOVER_PARKED]';

export type LeftoverIsolationReason =
  | 'park'
  | 'unfocus'
  | 'leftover'
  | 'encerrar';

export type LeftoverRemountKind = 'automatic' | 'operator';

export interface LeftoverIsolationMission {
  readonly id: string;
  readonly status: string;
  readonly intentState?: string | null;
  readonly description?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

/**
 * Iniciar fresco deste processo. Recibo de kickoff NÃO é exigido —
 * no Via Rápida o recibo ainda não gravou quando o board pinta.
 * idade <1s OU seladas≥20+panes 0 OU running sem Maestro deste pid.
 */
export function isFreshIniciarKickoff(input: {
  readonly status: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly sealedCount?: number;
  readonly paneCount?: number;
  readonly hasLiveMaestro?: boolean;
  readonly hasKickoffReceipt?: boolean;
}): boolean {
  const stamp = input.updatedAt ?? input.createdAt ?? 0;
  if (stamp > 0 && wasUpdatedBeforeThisProcess(stamp)) return false;
  const ageMs = Date.now() - (input.createdAt ?? input.updatedAt ?? 0);
  if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 1000) return true;
  const panes = input.paneCount ?? 0;
  if ((input.sealedCount ?? 0) >= 20 && panes === 0) return true;
  if (input.status === 'running' && input.hasLiveMaestro !== true) {
    return true;
  }
  return input.hasKickoffReceipt === true;
}

export interface LeftoverIsolationWriter<T extends LeftoverIsolationMission> {
  get(id: string): T | null;
  update(
    id: string,
    patch: {
      readonly status: 'blocked';
      readonly intentState: 'blocked_user';
      readonly description: string;
    },
  ): T | null;
}

const LEFTOVER_REASON_COPY: Readonly<
  Record<LeftoverIsolationReason, string>
> = Object.freeze({
  park: 'Missão estacionada na rail; sem PTY. Restart restaura o card, não a equipe.',
  unfocus:
    'Missão saiu do orçamento focused; dorme na rail sem PTY e sem maxWorkers.',
  leftover:
    'Missão leftover: card na rail, sem PTY. Reopen não remonta o time.',
  encerrar:
    'Execução encerrada; leftover isolado para reopen não remountar o runtime.',
});

function recoverableMission(
  mission: LeftoverIsolationMission,
): {
  readonly status: string;
  readonly intentState?: string;
  readonly description?: string;
} {
  return {
    status: mission.status,
    ...(mission.intentState != null ? { intentState: mission.intentState } : {}),
    ...(mission.description != null
      ? { description: mission.description }
      : {}),
  };
}

export function wasMissionLeftoverParked(
  mission: Pick<LeftoverIsolationMission, 'description'>,
): boolean {
  return (mission.description ?? '').includes(NEXUS_LEFTOVER_PARKED_MARKER);
}

export function leftoverIsolationPatch(
  mission: LeftoverIsolationMission,
  reason: LeftoverIsolationReason = 'leftover',
): {
  readonly status: 'blocked';
  readonly intentState: 'blocked_user';
  readonly description: string;
} {
  return {
    status: 'blocked',
    intentState: 'blocked_user',
    description: appendMissionVerdict(
      mission.description ?? '',
      NEXUS_LEFTOVER_PARKED_MARKER,
      NEXUS_LEFTOVER_PARKED_TOKEN,
      LEFTOVER_REASON_COPY[reason],
    ),
  };
}

/**
 * Park / leftover / Encerrar / unfocus: grava status não-running para
 * reopen NÃO remountar PTY e NÃO contar contra maxWorkers.
 */
export function leftoverIsolationStillLive(
  mission: Pick<LeftoverIsolationMission, 'status'> | null | undefined,
): boolean {
  return mission?.status === 'running' || mission?.status === 'pending';
}

export function persistLeftoverIsolation<T extends LeftoverIsolationMission>(
  writer: LeftoverIsolationWriter<T>,
  missionId: string,
  reason: LeftoverIsolationReason = 'leftover',
): T | null {
  const mission = writer.get(missionId);
  if (!mission) return null;
  if (mission.status === 'done' || mission.status === 'failed') return mission;
  const recoverable = recoverableMission(mission);
  const alreadyClosed = wasMissionRuntimeClosedByOperator(recoverable);
  const alreadyLeftover = wasMissionLeftoverParked(mission);
  if (reason !== 'encerrar' && alreadyClosed) return mission;
  if (
    reason !== 'encerrar' &&
    alreadyLeftover &&
    mission.status !== 'running' &&
    mission.status !== 'pending'
  ) {
    return mission;
  }
  if (
    reason === 'encerrar' &&
    alreadyClosed &&
    alreadyLeftover &&
    mission.status === 'blocked'
  ) {
    return mission;
  }
  if (typeof writer.update !== 'function') {
    if (reason === 'encerrar' && leftoverIsolationStillLive(mission)) {
      throw new Error(
        'Encerrar não persistiu leftover não-running: store sem update',
      );
    }
    return mission;
  }
  const leftover = leftoverIsolationPatch(mission, reason);
  const updated =
    reason !== 'encerrar'
      ? writer.update(missionId, leftover)
      : writer.update(missionId, {
          ...leftover,
          description: appendMissionVerdict(
            leftover.description,
            MISSION_RUNTIME_CLOSED_MARKER,
            '[NEXUS_RUNTIME_CLOSED]',
            'Execução encerrada pelo operador; histórico e receipts preservados.',
          ),
        });
  if (reason === 'encerrar' && leftoverIsolationStillLive(updated)) {
    throw new Error(
      'Encerrar não persistiu leftover não-running no SQLite',
    );
  }
  return updated;
}

export function shouldPersistLeftoverIsolation(input: {
  readonly status: string;
  readonly alreadyClosedByOperator: boolean;
  readonly alreadyLeftoverParked: boolean;
  readonly hasThisProcessLiveMaestro: boolean;
  readonly isFreshKickoff?: boolean;
  readonly isFreshPending?: boolean;
}): boolean {
  if (input.alreadyClosedByOperator) return false;
  if (input.hasThisProcessLiveMaestro) return false;
  if (input.status === 'done' || input.status === 'failed') return false;
  if (
    input.alreadyLeftoverParked &&
    input.status !== 'running' &&
    input.status !== 'pending'
  ) {
    return false;
  }
  if (input.status === 'running') return input.isFreshKickoff !== true;
  if (input.status === 'pending') return input.isFreshPending !== true;
  return false;
}

/**
 * Remount automático de leftover é proibido. Retomar do operador (kind
 * `operator`) religa. Row leftover `running` sem Maestro vivo neste
 * processo — inclusive de disco — não remonta. Morte do Maestro da
 * missão focused DESTE processo (updatedAt após o boot, sem selo
 * leftover) ainda pode religar.
 */
export function shouldSkipLeftoverRemount(input: {
  readonly mission: LeftoverIsolationMission;
  readonly liveMaestroSessionId: string | null;
  readonly remountKind?: LeftoverRemountKind;
  readonly isFreshKickoff?: boolean;
  readonly isLeftover?: boolean;
}): boolean {
  if (input.remountKind === 'operator') return false;
  if (wasMissionRuntimeClosedByOperator(recoverableMission(input.mission))) {
    return true;
  }
  if (wasMissionLeftoverParked(input.mission)) return true;
  if (input.isFreshKickoff === true) return false;
  if (input.liveMaestroSessionId) return false;
  if (
    input.mission.status !== 'running' &&
    input.mission.status !== 'pending'
  ) {
    return false;
  }
  if (input.isLeftover === true) return true;
  return wasUpdatedBeforeThisProcess(input.mission.updatedAt ?? 0);
}

/**
 * Só missão com Maestro vivo NESTE processo. Row leftover do disco nunca
 * vira focused só porque o SQLite ainda diz `running`.
 */
/**
 * Iniciar uma missão nova: as outras `running` saem do orçamento focused.
 * Sem isto o Mac acumula 15 first-waves no mesmo checkout.
 */
export function siblingRunningMissionIds(
  startingMissionId: string,
  running: readonly { readonly id: string }[],
): readonly string[] {
  return running
    .map((mission) => mission.id)
    .filter((id) => id !== startingMissionId);
}

export function pickFocusedRunningMission<T extends LeftoverIsolationMission>(
  missions: readonly T[],
  liveMaestroByMissionId: ReadonlyMap<string, string>,
): T | null {
  const live = missions.filter(
    (mission) =>
      (mission.status === 'running' || mission.status === 'pending') &&
      liveMaestroByMissionId.has(mission.id) &&
      !wasMissionRuntimeClosedByOperator(recoverableMission(mission)) &&
      !wasMissionLeftoverParked(mission),
  );
  if (live.length === 0) return null;
  return [...live].sort((left, right) => {
    const byUpdated = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
    if (byUpdated !== 0) return byUpdated;
    return left.id.localeCompare(right.id);
  })[0] ?? null;
}
