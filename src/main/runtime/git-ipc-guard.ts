import { ipcMain, type IpcMainEvent } from 'electron';
import { trace } from '../observability/main-trace';
import { GitCommandError } from './git-command';

/**
 * Falha operacional do git (o processo não sobe, estoura o prazo, morre por
 * sinal ou lota o buffer) não é bug do app. Se ela escapa de um listener de IPC,
 * o Electron mostra o diálogo fatal "A JavaScript error occurred in the main
 * process" e a janela fica de luto. Aqui a falha é registrada e o listener
 * termina; qualquer outro erro é relançado, para bugs de programação continuarem
 * aparecendo como antes.
 */
export function isGitOperationalFailure(error: unknown): error is GitCommandError {
  return error instanceof GitCommandError;
}

/** Registra no trace e no console uma falha de git que o chamador contornou. */
export function reportGitFailure(where: string, error: GitCommandError): void {
  // O motivo real fica em `cause` (ETIMEDOUT, ENOENT, ENOBUFS...). Sinal sem
  // erro de spawn é morte por sinal.
  const cause = error.cause as NodeJS.ErrnoException | undefined;
  const reason = cause?.code ?? 'signal-or-exit';
  const subcommand = error.args[0] ?? 'unknown';
  trace({
    kind: 'git-ipc-failure',
    where,
    subcommand,
    reason,
    status: error.status,
  });
  console.warn(
    `[git-ipc] ${where}: git ${subcommand} não completou (${reason}); o passo seguiu sem esse resultado`,
  );
}

/** Envolve um listener: falha de git vira registro; o resto segue propagando. */
export function guardGitFailures<A extends unknown[]>(
  where: string,
  listener: (...args: A) => void,
): (...args: A) => void {
  return (...args: A) => {
    try {
      listener(...args);
    } catch (error) {
      if (!isGitOperationalFailure(error)) throw error;
      reportGitFailure(where, error);
    }
  };
}

/** `ipcMain.on` com a proteção contra falha de git já aplicada. */
export function onIpcGuarded(
  channel: string,
  listener: (event: IpcMainEvent, ...args: any[]) => void,
): void {
  ipcMain.on(channel, guardGitFailures(channel, listener));
}
