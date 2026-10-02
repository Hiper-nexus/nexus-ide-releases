import { JEV_CHANNELS } from '../../shared/jev-channels';
import {
  missionPickRequestSchema,
  type MissionPickRequest,
  type MissionPickResult,
} from '../../shared/mission-pick';
import { handleTrusted } from '../security/trusted-ipc';
import { pickMissionWithJev } from './jev-mission-pick';

/**
 * IPC do desempate de missão por voz. Só o frame principal da janela principal
 * chega aqui (`handleTrusted`); o payload é `unknown` até o schema estrito
 * aceitá-lo (chave desconhecida, id real ou caminho são recusados). A resposta
 * é SEMPRE um resultado tipado: nem um erro inesperado vira exceção nem leva
 * texto de falha ao renderer, e "sem decisão" é um resultado normal, nunca um
 * motivo para travar a voz.
 */
export function registerMissionPickIpc(
  pick: (request: MissionPickRequest) => Promise<MissionPickResult> = pickMissionWithJev,
): void {
  handleTrusted(
    JEV_CHANNELS.missionPick,
    async (_event, raw): Promise<MissionPickResult> => {
      const parsed = missionPickRequestSchema.safeParse(raw);
      if (!parsed.success) return { decision: 'undecided', reason: 'invalid-request' };
      try {
        return await pick(parsed.data);
      } catch {
        return { decision: 'undecided', reason: 'error' };
      }
    },
  );
}
