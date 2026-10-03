/**
 * F-764 (C.7): main lento não pode ser silencioso. O renderer pinga este
 * canal; a resposta é trivial de propósito (só o relógio) — o que importa é
 * o main ter ATENDIDO. Sem resposta em 10 s o renderer mostra a faixa "Nexus
 * ocupado — capturando diagnóstico". Nada aqui toca disco, estado ou
 * processo: o handler não pode ser ele mesmo a causa de lentidão.
 */

import { ipcMain } from 'electron';
import { WINDOW_CHANNELS } from '../../shared/channels';

export interface MainHeartbeatReply {
  readonly at: number;
}

export function mainHeartbeatReply(now: () => number = Date.now): MainHeartbeatReply {
  return { at: now() };
}

let registered = false;

export function registerMainHeartbeatIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.handle(WINDOW_CHANNELS.heartbeat, () => mainHeartbeatReply());
}
