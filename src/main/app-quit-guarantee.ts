import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type {
  MessageBoxOptions,
  MessageBoxReturnValue,
} from "electron";

/**
 * Garantia estrutural de quit (diretiva do dono, 06/08): depois que o operador
 * pede para sair, o app SEMPRE encerra dentro do teto — falha de shutdown vira
 * registro, nunca veto. O defeito-raiz que este módulo enterra: o backstop de
 * app.exit era cancelado pelo próprio caminho de erro que ele protegia (o
 * .catch do shutdown limpava o timer), então a rede de segurança sumia
 * exatamente quando era necessária.
 */

export type QuitIncidentKind =
  | "ceiling-fired"
  | "force-button"
  | "sessions-unproven"
  | "reconciliation-incomplete"
  | "quit-abandoned-by-user"
  | "orphan-supervisor-swept";

export interface QuitIncidentInput {
  readonly kind: QuitIncidentKind;
  readonly sessionIds?: readonly string[];
  readonly detail?: string;
}

export type QuitIncidentRecorder = (incident: QuitIncidentInput) => void;

export const QUIT_INCIDENT_LOG_FILE = "shutdown-incidents.jsonl";

/**
 * Telemetria durável dos encerramentos que precisaram da rede de segurança.
 * Falha de registro nunca compete com o encerramento em si.
 */
export function createQuitIncidentFileRecorder(
  userDataPath: string,
  now: () => number = Date.now,
): QuitIncidentRecorder {
  return (incident) => {
    try {
      mkdirSync(userDataPath, { recursive: true });
      appendFileSync(
        path.join(userDataPath, QUIT_INCIDENT_LOG_FILE),
        `${JSON.stringify({ at: now(), ...incident })}\n`,
        "utf8",
      );
    } catch (error) {
      console.warn("[quit-guarantee] registro de incidente falhou:", error);
    }
  };
}

export interface UnclearableQuitCeiling {
  /** Arma o prazo. Idempotente enquanto armado: NUNCA reinicia o prazo. */
  arm(): void;
  /**
   * Única forma legítima de desarmar: o OPERADOR escolheu manter o app
   * aberto — a intenção de sair foi revogada por um humano, não por um erro.
   */
  abandonQuitByUser(detail?: string): void;
  /** ms restantes do prazo armado; null se não armado. */
  remainingMs(): number | null;
}

/**
 * Teto inarredável do quit (F-240): acima do orçamento inteiro do PTY
 * (APP_SHUTDOWN_PTY_TERMINATION: 5s term + 8s kill + 8s lag = 21s por sessão)
 * com sobra para as demais fases medidas pelo shutdown.
 */
export const QUIT_CEILING_MS = 45_000;

export function createUnclearableQuitCeiling(deps: {
  readonly ceilingMs: number;
  readonly exitApp: () => void;
  readonly record: QuitIncidentRecorder;
  readonly now?: () => number;
  /**
   * F-240: descreve a fase do shutdown em curso e as já concluídas para o
   * `detail` do incidente `ceiling-fired` (string curta, só rótulos/ms).
   */
  readonly describeProgress?: () => string;
}): UnclearableQuitCeiling {
  const now = deps.now ?? Date.now;
  let timer: NodeJS.Timeout | null = null;
  let armedAt: number | null = null;
  let fired = false;

  return Object.freeze({
    arm(): void {
      if (fired || timer !== null) return;
      armedAt = now();
      timer = setTimeout(() => {
        fired = true;
        const progress = deps.describeProgress?.();
        deps.record({
          kind: "ceiling-fired",
          detail:
            `quit excedeu o teto de ${deps.ceilingMs}ms` +
            (progress ? ` | ${progress}` : ""),
        });
        console.error(
          "[main] quit exceeded the hard ceiling; forcing exit to avoid a permanent hang",
        );
        deps.exitApp();
      }, deps.ceilingMs);
      timer.unref?.();
    },
    abandonQuitByUser(detail?: string): void {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      armedAt = null;
      deps.record({
        kind: "quit-abandoned-by-user",
        ...(detail ? { detail } : {}),
      });
    },
    remainingMs(): number | null {
      if (armedAt === null) return null;
      return Math.max(0, deps.ceilingMs - (now() - armedAt));
    },
  });
}

export interface QuitNotice {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly string[];
  readonly forceButtonIndex: number;
}

const FORCE_BUTTON = "Forçar encerramento agora";

function remainingSeconds(remainingMs: number | null): number | null {
  if (remainingMs === null) return null;
  return Math.ceil(remainingMs / 1_000);
}

/** O aviso de demora nunca é espera aberta: sempre prazo + saída. */
export function buildSlowQuitNotice(input: {
  readonly remainingMs: number | null;
}): QuitNotice {
  const seconds = remainingSeconds(input.remainingMs);
  return Object.freeze({
    title: "O NexusIDE ainda está encerrando",
    message:
      seconds === null
        ? "Aguardando a finalização segura dos serviços."
        : `Aguardando a finalização segura dos serviços — encerramento automático em até ${seconds}s.`,
    detail:
      "Os processos que não comprovarem encerramento a tempo serão finalizados " +
      "e registrados no diário de encerramento. Nada fica pendurado para sempre.",
    buttons: Object.freeze([FORCE_BUTTON, "Continuar aguardando"]),
    forceButtonIndex: 0,
  });
}

/** Falha de shutdown é registro acionável, nunca um beco: sempre há saída. */
export function buildFailureQuitNotice(input: {
  readonly error: unknown;
  readonly remainingMs: number | null;
}): QuitNotice {
  const reason =
    input.error instanceof Error ? input.error.message : String(input.error);
  const seconds = remainingSeconds(input.remainingMs);
  return Object.freeze({
    title: "O NexusIDE continua encerrando",
    message:
      seconds === null
        ? "A preparação segura para sair não foi concluída."
        : `A preparação segura para sair não foi concluída — encerramento automático em até ${seconds}s.`,
    detail:
      `${reason}\n\n` +
      "Forçar agora finaliza os processos restantes e registra cada um no " +
      "diário de encerramento; Tentar novamente repete a preparação segura.",
    buttons: Object.freeze([
      FORCE_BUTTON,
      "Tentar novamente",
      "Manter o NexusIDE aberto",
    ]),
    forceButtonIndex: 0,
  });
}

/** Subconjunto de BrowserWindow que o host do diálogo de quit precisa. */
export interface QuitDialogHostWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * F-1255: mostra o prompt de quit sem prender a main thread. No macOS um
 * `showMessageBox` sem janela-mãe é NSAlert runModal (bloqueia o Main); com
 * janela-mãe vira sheet. Por isso a janela principal é restaurada e trazida
 * à frente ANTES do sheet — um sheet numa janela minimizada seria invisível
 * e o quit travaria sem feedback. Sem nenhuma janela viva (ex.: logout/
 * desligamento do macOS) mantém o app-modal: quem pediu o quit é o operador.
 */
export async function showQuitConfirmationDialog<W extends QuitDialogHostWindow>(deps: {
  readonly options: MessageBoxOptions;
  readonly hostWindow: W | null | undefined;
  readonly showSheet: (
    window: W,
    options: MessageBoxOptions,
  ) => Promise<MessageBoxReturnValue | null>;
  readonly showAppModal: (
    options: MessageBoxOptions,
  ) => Promise<MessageBoxReturnValue>;
}): Promise<MessageBoxReturnValue> {
  const host = deps.hostWindow;
  if (host && !host.isDestroyed()) {
    if (host.isMinimized()) host.restore();
    if (!host.isVisible()) host.show();
    host.focus();
    const result = await deps.showSheet(host, deps.options);
    if (result) return result;
  }
  return deps.showAppModal(deps.options);
}

/**
 * Varredura de boot: supervisores órfãos do PRÓPRIO install (o lock de
 * instância única garante que, no boot, nenhum outro processo deste install
 * pode possuí-los — o supervisor roda disclaimed com ppid 1, então parentesco
 * não distingue vivo de órfão; o caminho do binário distingue o install).
 * Este é o acumulador que segurou o quit do dono: zumbis de 04/08 sem prova
 * de morte faziam toda tentativa de sair falhar.
 */
export function selectOrphanSupervisorPids(
  psOutput: string,
  resourcesPath: string,
): readonly number[] {
  const binaryPrefix = `${resourcesPath}/nexus-pty-supervisor`;
  const pids: number[] = [];
  for (const line of psOutput.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+\d+\s+(.*)$/u.exec(line);
    if (!match) continue;
    const command = match[2]!;
    if (
      command === binaryPrefix ||
      command.startsWith(`${binaryPrefix} `)
    ) {
      pids.push(Number(match[1]));
    }
  }
  return Object.freeze(pids);
}

export function sweepOrphanPtySupervisors(deps: {
  readonly resourcesPath: string;
  readonly listProcesses: () => string;
  readonly kill: (pid: number, signal: "SIGKILL") => void;
  readonly record: QuitIncidentRecorder;
}): readonly number[] {
  let psOutput: string;
  try {
    psOutput = deps.listProcesses();
  } catch (error) {
    console.warn("[quit-guarantee] varredura de órfãos indisponível:", error);
    return Object.freeze([]);
  }
  const swept: number[] = [];
  for (const pid of selectOrphanSupervisorPids(psOutput, deps.resourcesPath)) {
    try {
      // SIGKILL por contrato: o loop fail-closed do supervisor ignora SIGTERM.
      deps.kill(pid, "SIGKILL");
      swept.push(pid);
    } catch {
      // Processo já morreu entre o ps e o kill — nada a registrar.
    }
  }
  if (swept.length > 0) {
    deps.record({
      kind: "orphan-supervisor-swept",
      detail: `pids: ${swept.join(", ")}`,
    });
  }
  return Object.freeze(swept);
}
