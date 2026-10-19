import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import {
  isMissionRuntimeSquadId,
  type Squad,
  type SquadAgent,
} from '../../shared/orch-types';
import { MISSION_SETUP_MAX_ROSTER } from '../state/mission-setup-store';

/**
 * Equipes salvas que o operador escolhe: sem as cópias seladas de missão e com
 * as dele antes das originais (a mesma ordem de Ajustes → Equipes).
 */
export function orderSavedSquads(squads: readonly Squad[]): Squad[] {
  return squads
    .filter((squad) => !isMissionRuntimeSquadId(squad.id))
    .sort((a, b) => Number(a.builtin ?? false) - Number(b.builtin ?? false));
}

/**
 * F-1578: equipes que podem virar o ponto de partida de uma missão comum.
 * O Pet Studio tem fluxo próprio e nunca entra numa missão comum.
 */
export function savedSquadsForMissionTeam(squads: readonly Squad[]): Squad[] {
  return orderSavedSquads(squads).filter(
    (squad) => squad.id !== PET_STUDIO_SQUAD_ID,
  );
}

export type SavedSquadMembersResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Aplica os integrantes de uma equipe salva ao rascunho da missão pelo
 * `setRoster` do rascunho, a única conversão squad → missão ("Usar
 * integrantes" em Ajustes e a etapa Equipe passam por aqui). `setRoster`
 * devolve `false` quando recusa; `void` conta como aplicado.
 */
export function applySavedSquadMembers(
  squad: Pick<Squad, 'agents'>,
  setRoster: (roster: readonly SquadAgent[]) => boolean | void,
): SavedSquadMembersResult {
  if (setRoster(squad.agents) !== false) return { ok: true };
  // F-1496: o tamanho é a única causa que o usuário consegue ver; a outra
  // é um integrante com dado que a missão não aceita.
  return {
    ok: false,
    message:
      squad.agents.length > MISSION_SETUP_MAX_ROSTER
        ? `Não foi possível aplicar os integrantes: esta equipe tem ${squad.agents.length} pessoas e a missão aceita até ${MISSION_SETUP_MAX_ROSTER}. Remova alguns no editor e tente de novo.`
        : 'Não foi possível aplicar os integrantes: um deles tem um dado que a missão não aceita. Abra a equipe no editor, salve de novo e tente outra vez.',
  };
}
