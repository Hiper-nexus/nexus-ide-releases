import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import { buildShutdownFailureNotice } from "./app-shutdown";

export interface ShutdownNoticeControllerDeps {
  readonly isShutdownComplete: () => boolean;
  readonly focusApp: () => void;
  readonly showMessageBox: (
    options: MessageBoxOptions,
  ) => Promise<MessageBoxReturnValue>;
  readonly revokeQuitAuthorization: () => void;
  readonly authorizeQuit: () => void;
  readonly requestQuit: () => void;
  readonly restartDockWatchdog: () => void;
}

export interface ShutdownNoticeController {
  readonly showSlowNotice: () => void;
  readonly showFailure: (error: unknown) => void;
}

/**
 * Owns native shutdown-dialog concurrency outside the main bootstrap module.
 * It never grants quit authority unless the operator explicitly asks to retry.
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
      void deps
        .showMessageBox({
          type: "info",
          title: "O NexusIDE ainda está encerrando",
          message: "Aguardando a finalização segura dos serviços.",
          detail:
            "O app continuará aberto enquanto confirma o encerramento físico " +
            "dos processos. Nenhum terminal será abandonado por um encerramento forçado.",
          buttons: ["Continuar aguardando"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
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
      deps.revokeQuitAuthorization();
      deps.restartDockWatchdog();
      if (failurePromptOpen) return;
      failurePromptOpen = true;
      deps.focusApp();
      const notice = buildShutdownFailureNotice(error);
      void deps
        .showMessageBox({
          type: "error",
          ...notice,
          buttons: ["Manter o NexusIDE aberto", "Tentar novamente"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        .then(({ response }) => {
          failurePromptOpen = false;
          if (response !== 1) return;
          deps.authorizeQuit();
          deps.requestQuit();
        })
        .catch(() => {
          failurePromptOpen = false;
        });
    },
  };
}
