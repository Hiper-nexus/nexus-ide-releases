/**
 * F-764 (C.7): main lento não pode ser silencioso.
 *
 * No travamento de 03/10 o renderer ficou ocioso esperando IPC e a janela
 * parecia morta — ninguém sabia se era o app, a máquina ou um agente. O
 * renderer roda em outro processo e continua pintando; então ele pinga o main
 * (`app:heartbeat`) e, quando um ping fica 10 s sem resposta, acusa "main
 * ocupado". A resposta (ou um erro de IPC, que também prova que o main
 * atendeu) apaga o aviso sozinha.
 *
 * Um ping por vez, nunca empilhado: num main preso, cada ping extra seria
 * mais uma mensagem na fila que ele precisa esvaziar quando voltar. Sem
 * auto-kill — a doutrina do watchdog vale aqui também.
 */

/** Ritmo do relógio do renderer (só confere prazo; não manda IPC sozinho). */
export const MAIN_HEARTBEAT_TICK_MS = 1_000;
/** Intervalo mínimo entre pings respondidos. */
export const MAIN_HEARTBEAT_PING_EVERY_MS = 3_000;
/** Ping sem resposta por isso = main ocupado. */
export const MAIN_BUSY_AFTER_MS = 10_000;

export interface MainHeartbeatMonitor {
  /** Uma batida: manda ping se for hora; acusa main ocupado se o ping em voo estourou. */
  tick(): void;
  isBusy(): boolean;
  /** Para de notificar (respostas tardias são ignoradas). */
  dispose(): void;
}

export function createMainHeartbeatMonitor(options: {
  readonly ping: () => Promise<unknown>;
  readonly onBusyChange: (busy: boolean) => void;
  readonly now?: () => number;
  readonly pingEveryMs?: number;
  readonly busyAfterMs?: number;
}): MainHeartbeatMonitor {
  const now = options.now ?? (() => Date.now());
  const pingEveryMs = options.pingEveryMs ?? MAIN_HEARTBEAT_PING_EVERY_MS;
  const busyAfterMs = options.busyAfterMs ?? MAIN_BUSY_AFTER_MS;
  let inFlightSince: number | null = null;
  let lastPingAt: number | null = null;
  let busy = false;
  let disposed = false;

  const setBusy = (next: boolean): void => {
    if (disposed || busy === next) return;
    busy = next;
    options.onBusyChange(next);
  };
  const answered = (): void => {
    inFlightSince = null;
    setBusy(false);
  };

  return {
    tick() {
      if (disposed) return;
      const at = now();
      if (inFlightSince !== null) {
        if (at - inFlightSince >= busyAfterMs) setBusy(true);
        return;
      }
      if (lastPingAt !== null && at - lastPingAt < pingEveryMs) return;
      lastPingAt = at;
      inFlightSince = at;
      let pending: Promise<unknown>;
      try {
        pending = Promise.resolve(options.ping());
      } catch (error) {
        // Ponte quebrada de forma síncrona: não é o main que está lento.
        pending = Promise.reject(error);
      }
      pending.then(answered, answered);
    },
    isBusy: () => busy,
    dispose() {
      disposed = true;
    },
  };
}
