import { type PeriodicTaskContext } from '../observability/periodic-task';
import { getAgentSessionInfo, orchWriteSession, tapSessionExit, tapSessionState } from '../pty/pty-manager';
import { readSessionOutput } from './pane-registry';
import { CSI_SEQUENCE_PATTERN } from '../../shared/ansi-escape-sequences';

/**
 * Boot-prompt watchdog (0.32.26): CLIs de agente que estréia num checkout
 * podem travar num prompt interativo de primeira execução — o Kimi pergunta
 * "Do you trust the files in this folder?" e espera um Enter que nenhum
 * humano vai dar num pane de missão; o worker morre na largada (print
 * 2026-08-17: "a etapa 02 (kimi) morreu no boot").
 *
 * Diferente do login-stuck (que só REPORTA login de provider), aqui o prompt
 * é uma confirmação da PRÓPRIA CLI sobre a pasta de trabalho do pane —
 * aceitar é seguro e é o que o operador faria. O watchdog aperta Enter:
 *   · só em sessões de MISSÃO (gate ctx tem missionId) — pane do operador é
 *     do operador;
 *   · só na janela de boot (primeiros BOOT_PROMPT_MAX_AGE_MS);
 *   · só com o prompt estável por 2 ticks (sem disparar em flicker);
 *   · no máximo BOOT_PROMPT_MAX_ATTEMPTS vezes por sessão.
 */

export const BOOT_PROMPT_TICK_MS = 4_000;
export const BOOT_PROMPT_MAX_AGE_MS = 5 * 60_000;
export const BOOT_PROMPT_MAX_ATTEMPTS = 2;
export const BOOT_PROMPT_REQUIRED_TICKS = 2;
/** Linhas de texto plano inspecionadas por tick. */
const TAIL_LINES = 40;

interface BootPromptPattern {
  readonly re: RegExp;
  readonly label: string;
  /** Tecla enviada (default Enter). ESC dispensa diálogos de sugestão. */
  readonly answer?: string;
  /** true = vale a sessão inteira, não só a janela de boot. */
  readonly midTurn?: boolean;
}

// Curadas e específicas: multi-palavra, só prompt de confirmação de boot.
// ORDEM IMPORTA: os padrões ESPECÍFICOS vêm primeiro — o diálogo de troca
// de modelo também contém "Press enter to confirm", e o padrão genérico
// responderia Enter (TROCANDO o modelo do operador por conta própria).
const BOOT_PROMPT_PATTERNS: readonly BootPromptPattern[] = [
  // Diálogo MID-TURN de rate-limit/troca de modelo (print do operador,
  // gate 0.62 19/08: "Switch to gpt-5.6-luna… Keep current model… Press
  // enter to confirm or esc to go back" congelou o worker para sempre).
  // Resposta segura é ESC — mantém o modelo que o operador escolheu.
  {
    re: /keep current model[\s\S]{0,200}press enter to confirm or esc/i,
    label: 'model-switch-dialog',
    answer: '\x1b',
    midTurn: true,
  },
  {
    re: /switch to [\w.-]+ for lo[\s\S]{0,300}keep current model/i,
    label: 'model-switch-dialog',
    answer: '\x1b',
    midTurn: true,
  },
  { re: /do you trust (the|this) (files in this |contents of this |authors of (the files in )?this )?(folder|directory|repository|workspace)\??/i, label: 'folder-trust' },
  { re: /trust (this|the) (folder|workspace|directory|repository)\??/i, label: 'folder-trust' },
  { re: /are you sure you want to run claude in this (directory|folder)\??/i, label: 'folder-trust' },
  { re: /press (enter|return) to (continue|confirm|accept|proceed)/i, label: 'press-enter' },
  { re: /allow (telemetry|analytics|usage data)\?/i, label: 'telemetry-consent' },
];

// F-1406: CSI do padrão compartilhado — a classe antiga [0-9;?]*[A-Za-z]
// deixava parâmetros privados (ESC[>4;0m) e intermediários no texto.
const ANSI_RE = CSI_SEQUENCE_PATTERN;

export interface BootPromptMatch {
  readonly label: string;
  readonly answer: string;
  readonly midTurn: boolean;
}

export function matchBootPromptPattern(rawTail: string): BootPromptMatch | null {
  if (!rawTail) return null;
  const plain = rawTail.replace(ANSI_RE, '');
  for (const pattern of BOOT_PROMPT_PATTERNS) {
    if (pattern.re.test(plain)) {
      return {
        label: pattern.label,
        answer: pattern.answer ?? '\r',
        midTurn: pattern.midTurn === true,
      };
    }
  }
  return null;
}

export function matchBootPrompt(rawTail: string): string | null {
  return matchBootPromptPattern(rawTail)?.label ?? null;
}

export interface BootPromptWatchdogDeps {
  now(): number;
  /** Texto plano do tail recente da sessão (mais novo no fim). */
  readTail(sessionId: string): string;
  /** Escreve no PTY da sessão (lane main-owned; devolve false se recusou). */
  write(sessionId: string, data: string): boolean;
  log?(message: string): void;
}

interface WatchedSession {
  sessionId: string;
  paneId: string;
  adapterId: string;
  missionId?: string;
  firstSeenAt: number;
  promptTicks: number;
  attempts: number;
  lastPromptAt: number;
}

export interface BootPromptWatchdog {
  trackSession(
    sessionId: string,
    paneId: string,
    adapterId: string,
    missionId: string | undefined,
  ): void;
  dropSession(sessionId: string): void;
  tick(context?: PeriodicTaskContext): void | Promise<void>;
  watchedCount(): number;
}

export function createBootPromptWatchdog(
  deps: BootPromptWatchdogDeps,
): BootPromptWatchdog {
  const sessions = new Map<string, WatchedSession>();
  const log = deps.log ?? ((message: string) => console.info(message));

  const tickSession = (watch: WatchedSession, now: number): void => {
    const sessionId = watch.sessionId;
        const match = matchBootPromptPattern(deps.readTail(sessionId));
        // Padrões de BOOT respeitam a janela de 5 min; diálogos MID-TURN
        // (rate-limit/troca de modelo) valem a sessão inteira — o do gate
        // 0.62 apareceu 20+ min depois do spawn e congelou o worker. O mapa
        // é limpo no exit da sessão (dropSession), não por idade.
        const inBootWindow =
          now - watch.firstSeenAt <= BOOT_PROMPT_MAX_AGE_MS;
        if (match && !match.midTurn && !inBootWindow) return;
        if (!match) {
          if (watch.promptTicks > 0 && now - watch.lastPromptAt > BOOT_PROMPT_TICK_MS * 2) {
            watch.promptTicks = 0; // prompt sumiu: reseta a estabilidade.
          }
          return;
        }
        watch.promptTicks += 1;
        watch.lastPromptAt = now;
        if (watch.promptTicks < BOOT_PROMPT_REQUIRED_TICKS) return;
        if (watch.attempts >= BOOT_PROMPT_MAX_ATTEMPTS) return;
        watch.attempts += 1;
        watch.promptTicks = 0;
        const written = deps.write(sessionId, match.answer);
        log(
          `[boot-prompt] ${match.answer === '\r' ? 'Enter' : 'ESC'} enviado ` +
            `em ${sessionId} (${match.label}, ` +
            `tentativa ${watch.attempts}/${BOOT_PROMPT_MAX_ATTEMPTS}` +
            `${written ? '' : ', write recusado'})`,
        );
  };

  return {
    trackSession(sessionId, paneId, adapterId, missionId) {
      if (!missionId) return; // pane do operador: nunca digita por ele.
      const existing = sessions.get(sessionId);
      if (existing && existing.paneId === paneId && existing.adapterId === adapterId && existing.missionId === missionId) return;
      sessions.set(sessionId, {
        sessionId,
        paneId,
        adapterId,
        missionId,
        firstSeenAt: deps.now(),
        promptTicks: 0,
        attempts: 0,
        lastPromptAt: 0,
      });
    },
    dropSession(sessionId) {
      sessions.delete(sessionId);
    },
    tick(context) {
      const now = deps.now();
      const snapshot = [...sessions.entries()];
      if (!context) {
        for (const [, watch] of snapshot) tickSession(watch, now);
        return;
      }
      return (async () => {
        for (const [sessionId, watch] of snapshot) {
          await context.checkpoint();
          if (sessions.get(sessionId) !== watch) continue;
          tickSession(watch, now);
        }
      })();
    },

    watchedCount() {
      return sessions.size;
    },
  };
}

// ── Instalação de produção (reconciler do coordenador) ────────────────────

let activeWatchdog: BootPromptWatchdog | null = null;
let untapExit: (() => void) | null = null;
let untapState: (() => void) | null = null;

export function installBootPromptWatchdog(): () => void {
  if (activeWatchdog) return () => {};
  activeWatchdog = createBootPromptWatchdog({
    now: () => Date.now(),
    readTail: (sessionId) => readSessionOutput(sessionId, TAIL_LINES),
    write: (sessionId, data) => orchWriteSession(sessionId, data, { markInputBusy: false }),
  });
  untapState = tapSessionState((sessionId) => {
    const info = getAgentSessionInfo(sessionId);
    if (!info || !info.paneId || !info.adapterId) return;
    activeWatchdog?.trackSession(
      sessionId,
      info.paneId,
      info.adapterId,
      info.missionId,
    );
  });
  untapExit = tapSessionExit((sessionId) => {
    activeWatchdog?.dropSession(sessionId);
  });
  return () => {
    untapState?.();
    untapState = null;
    untapExit?.();
    untapExit = null;
    activeWatchdog = null;
  };
}

export function reconcileBootPromptWatchdog(context?: PeriodicTaskContext): void | Promise<void> {
  return activeWatchdog?.tick(context);
}
