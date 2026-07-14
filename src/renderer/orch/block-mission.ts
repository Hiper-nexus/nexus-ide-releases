import type { Mission } from '../../shared/orch-types';
import {
  appendBlockedMissionDescription,
  askConfirmWithReason,
} from '../state/confirm-store';

export type BlockMissionResult =
  | { ok: true }
  | { ok: false; cancelled?: true; error?: string };

/**
 * Shared "Encerrar como bloqueada" path for MissionRail and OpsBoard.
 * Fail-safe demotion only — never done. Requires a durable justification.
 */
export async function confirmAndBlockMission(
  mission: Mission,
): Promise<BlockMissionResult> {
  if (
    mission.status === 'done' ||
    mission.status === 'failed' ||
    mission.status === 'blocked'
  ) {
    return { ok: false, error: 'Missão já está terminal ou bloqueada.' };
  }

  const decision = await askConfirmWithReason({
    title: `Encerrar "${mission.title}" como bloqueada?`,
    body:
      'Use quando o ambiente não está pronto ou o PREVC nunca começou. ' +
      'Isto NÃO marca a missão como concluída (done) — evita green falso. ' +
      'A justificativa fica registrada na descrição da missão.',
    confirmLabel: 'Encerrar como bloqueada',
    danger: true,
    reasonLabel: 'Justificativa (obrigatória)',
    reasonPlaceholder:
      'Ex.: PREVC não iniciou; checkout sujo sem rota; credencial ausente…',
    reasonMinLength: 8,
  });
  if (!decision.ok) return { ok: false, cancelled: true };

  try {
    await window.nexus.orch.updateMission(mission.id, {
      status: 'blocked',
      description: appendBlockedMissionDescription(
        mission.description,
        decision.reason,
      ),
    });
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof Error
          ? cause.message
          : 'Falha ao encerrar a missão como bloqueada.',
    };
  }
}
