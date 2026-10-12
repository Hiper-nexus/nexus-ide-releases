import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import {
  buildFailureQuitNotice,
  buildSlowQuitNotice,
} from "./app-quit-guarantee";

export interface ShutdownNoticeControllerDeps {
  readonly isShutdownComplete: () => boolean;
  readonly focusApp: () => void;
  /**
   * F-1255: `null` = o diálogo não pôde ser mostrado (no macOS, sem janela
   * para hospedar o sheet um app-modal seria runModal e prenderia o Main).
   * O controller não pode ficar pendurado nesse caso: o teto do quit segue
   * armado e decide sozinho.
   */
  readonly showMessageBox: (
    options: MessageBoxOptions,
  ) => Promise<MessageBoxReturnValue | null>;
  readonly revokeQuitAuthorization: () => void;
  readonly authorizeQuit: () => void;
  readonly requestQuit: () => void;
  readonly restartDockWatchdog: () => void;
  /** Prazo restante do teto inarredável; null quando não armado. */
  readonly remainingMs: () => number | null;
  /** Encerramento imediato pedido pelo operador (registrado como incidente). */
  readonly forceExit: (origin: "slow-notice" | "failure-notice") => void;
  /** Única revogação legítima da intenção de sair: decisão do operador. */
  readonly abandonQuit: () => void;
}

export interface ShutdownNoticeController {
  readonly showSlowNotice: () => void;
  readonly showFailure: (error: unknown) => void;
}

/**
 * Diálogos nativos do encerramento. Nenhum deles é espera aberta (diretiva
 * 06/08): sempre há prazo visível e sempre há o botão de forçar — a demora e
 * a falha viram registro, nunca refém. A intenção de sair só é revogada pela
 * escolha explícita do operador de manter o app aberto.
 */
export function createShutdownNoticeController(
  deps: ShutdownNoticeControllerDeps,
): ShutdownNoticeController {
  let slowPromptOpen = false;
  let failurePromptOpen = false;

  return {
    showSlowNotice(): void {
      if (slowPromptOpen || deps.isShutdownComplete()) return;
      slowPromptOpen = true;
      deps.focusApp();
      const notice = buildSlowQuitNotice({ remainingMs: deps.remainingMs() });
      void deps
        .showMessageBox({
          type: "info",
          title: notice.title,
          message: notice.message,
          detail: notice.detail,
          buttons: [...notice.buttons],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        .then((result) => {
          if (result && result.response === notice.forceButtonIndex) {
            deps.forceExit("slow-notice");
          }
        })
        .catch((error) => {
          console.warn("[main] slow shutdown notice failed:", error);
        })
        .finally(() => {
          slowPromptOpen = false;
        });
    },

    showFailure(error: unknown): void {
      console.error("[main] shutdown failed safely:", error);
      if (failurePromptOpen) return;
      failurePromptOpen = true;
      deps.focusApp();
      const notice = buildFailureQuitNotice({
        error,
        remainingMs: deps.remainingMs(),
      });
      void deps
        .showMessageBox({
          type: "error",
          title: notice.title,
          message: notice.message,
          detail: notice.detail,
          buttons: [...notice.buttons],
          defaultId: 1,
          cancelId: 2,
          noLink: true,
        })
        .then((result) => {
          failurePromptOpen = false;
          // Diálogo não mostrado: a intenção de sair continua de pé sob o
          // teto — nada é revogado nem autorizado por ausência de resposta.
          if (!result) return;
          const { response } = result;
          if (response === notice.forceButtonIndex) {
            deps.forceExit("failure-notice");
            return;
          }
          if (response === 1) {
            deps.authorizeQuit();
            deps.requestQuit();
            return;
          }
          // Manter aberto: a ÚNICA revogação legítima da intenção de sair.
          deps.revokeQuitAuthorization();
          deps.restartDockWatchdog();
          deps.abandonQuit();
        })
        .catch(() => {
          failurePromptOpen = false;
        });
    },
  };
}
