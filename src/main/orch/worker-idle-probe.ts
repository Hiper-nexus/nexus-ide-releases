/**
 * F-1409 (Grok #2): sinais de atividade do worker para a rede de segurança do
 * auto-close não-success. Sessão one-shot (agy --print, opencode run — F-1272)
 * fica "busy" enquanto o processo vive, então ali só saída nova conta como
 * trabalho; nas interativas vale o estado busy/spawning.
 */
import {
  getSessionOutputSequence,
  getSessionState,
  isOneShotSessionRunning,
} from "../pty/pty-manager";
import { isWorkerSessionBusy } from "./pane-close-scopes";

export const workerActivityProbes = {
  isBusy: (sessionId: string): boolean =>
    !isOneShotSessionRunning(sessionId) &&
    isWorkerSessionBusy(getSessionState(sessionId)),
  activityMark: (sessionId: string): number | null =>
    isOneShotSessionRunning(sessionId) ? getSessionOutputSequence(sessionId) : null,
};
