// Gate de montagem do boot paralelo: a navegação do renderer começa cedo (o
// documento sobe e o splash estático aparece), mas o React só monta quando o
// bootstrap terminou de registrar todo o IPC — a garantia anti-corrida que o
// deferRendererLoad dava, agora segurando o mount em vez da navegação.
// Bootstrap falho rejeita o gate: nenhum renderer parcial executa IPC.
import { WINDOW_CHANNELS } from '../shared/channels';
import { handleTrusted } from './security/trusted-ipc';

/** Teto duro do boot no Main: await pendurado no bootstrap cai no diálogo de erro e encerra. */
export const BOOT_READY_DEADLINE_MS = 90_000;

let resolveGate!: () => void;
let rejectGate!: (error: unknown) => void;
let settled = false;

const gate = new Promise<void>((resolve, reject) => {
  resolveGate = resolve;
  rejectGate = reject;
});
// O gate pode ficar pendurado até o fim do processo em cenários sem janela
// (smoke do main sem renderer): a rejeição nunca pode escapar como
// unhandledRejection por falta de consumidor.
void gate.catch(() => {});

export function isBootReadyPending(): boolean {
  return !settled;
}

/**
 * Enquanto o Main ainda não concluiu o bootstrap, o mount watchdog re-arma sem
 * tocar o renderer via executeJavaScript — até o teto de BOOT_READY_DEADLINE_MS.
 */
export function shouldRearmMountWatchdogForBootGate(
  startedAtMs: number,
  nowMs: number = Date.now(),
  ceilingMs: number = BOOT_READY_DEADLINE_MS,
): boolean {
  return !settled && nowMs - startedAtMs < ceilingMs;
}

export function resolveBootReady(): void {
  if (settled) return;
  settled = true;
  resolveGate();
}

export function rejectBootReady(error: unknown): void {
  if (settled) return;
  settled = true;
  rejectGate(error);
}

export async function withBootReadyDeadline<T>(
  work: () => Promise<T>,
  deadlineMs: number = BOOT_READY_DEADLINE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `boot:ready deadline exceeded after ${Math.round(deadlineMs / 1000)}s`,
      );
      rejectBootReady(error);
      reject(error);
    }, deadlineMs);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface BootFailureDialogDeps {
  readonly isShutdownSealed: () => boolean;
  readonly showErrorBox: (title: string, content: string) => void;
  readonly quitApp: () => void;
  readonly describeFailure?: (error: unknown) => string;
  readonly onLogError?: (error: unknown) => void;
  readonly onTraceFailure?: (reason: string) => void;
}

export function handleBootReadyFailure(
  error: unknown,
  deps: BootFailureDialogDeps,
): void {
  rejectBootReady(error);
  // Saída intencional (Cmd+W / fechar janela na splash) sela o shutdown em
  // paralelo ao bootstrap: não exiba diálogo de falha nem re-entre em quit.
  if (deps.isShutdownSealed()) {
    return;
  }
  deps.onLogError?.(error);
  const bootFailureReason = deps.describeFailure
    ? deps.describeFailure(error)
    : error instanceof Error
      ? error.message
      : String(error);
  deps.onTraceFailure?.(bootFailureReason);
  try {
    deps.showErrorBox(
      'NexusIDE não conseguiu inicializar',
      'O núcleo do aplicativo falhou antes de abrir a interface. ' +
        'Reinicie o Nexus; nenhum renderer parcial foi carregado.' +
        `\n\nMotivo: ${bootFailureReason}`,
    );
  } catch {
    // The process still exits instead of exposing a renderer with partial IPC.
  }
  deps.quitApp();
}

let registered = false;

/** Handler único; a janela o registra na criação, antes de qualquer navegação. */
export function registerBootReadyIpc(): void {
  if (registered) return;
  registered = true;
  handleTrusted(WINDOW_CHANNELS.bootReady, () => gate);
}

