import { getAgentSessionInfo, orchWriteSession, tapSessionExit, tapSessionState } from '../pty/pty-manager';
import { readSessionOutput } from './pane-registry';

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
}

// Curadas e específicas: multi-palavra, só prompt de confirmação de boot.
const BOOT_PROMPT_PATTERNS: readonly BootPromptPattern[] = [
  { re: /do you trust (the|this) (files in this )?folder\??/i, label: 'folder-trust' },
  { re: /trust (this|the) (folder|workspace|directory)\??/i, label: 'folder-trust' },
  { re: /press (enter|return) to (continue|confirm|accept|proceed)/i, label: 'press-enter' },
  { re: /allow (telemetry|analytics|usage data)\?/i, label: 'telemetry-consent' },
];

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function matchBootPrompt(rawTail: string): string | null {
  if (!rawTail) return null;
  const plain = rawTail.replace(ANSI_RE, '');
  for (const pattern of BOOT_PROMPT_PATTERNS) {
    if (pattern.re.test(plain)) return pattern.label;
  }
  return null;
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
  tick(): void;
  watchedCount(): number;
}

export function createBootPromptWatchdog(
  deps: BootPromptWatchdogDeps,
): BootPromptWatchdog {
  const sessions = new Map<string, WatchedSession>();
  const log = deps.log ?? ((message: string) => console.info(message));

  return {
    trackSession(sessionId, paneId, adapterId, missionId) {
      if (!missionId) return; // pane do operador: nunca digita por ele.
      const existing = sessions.get(sessionId);
      if (existing) {
        existing.missionId = missionId;
        return;
      }
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
    tick() {
      const now = deps.now();
      for (const [sessionId, watch] of [...sessions.entries()]) {
        if (now - watch.firstSeenAt > BOOT_PROMPT_MAX_AGE_MS) {
          sessions.delete(sessionId);
          continue;
        }
        const label = matchBootPrompt(deps.readTail(sessionId));
        if (!label) {
          if (watch.promptTicks > 0 && now - watch.lastPromptAt > BOOT_PROMPT_TICK_MS * 2) {
            watch.promptTicks = 0; // prompt sumiu: reseta a estabilidade.
          }
          continue;
        }
        watch.promptTicks += 1;
        watch.lastPromptAt = now;
        if (watch.promptTicks < BOOT_PROMPT_REQUIRED_TICKS) continue;
        if (watch.attempts >= BOOT_PROMPT_MAX_ATTEMPTS) continue;
        watch.attempts += 1;
        watch.promptTicks = 0;
        const written = deps.write(sessionId, '\r');
        log(
          `[boot-prompt] Enter enviado em ${sessionId} (${label}, ` +
            `tentativa ${watch.attempts}/${BOOT_PROMPT_MAX_ATTEMPTS}` +
            `${written ? '' : ', write recusado'})`,
        );
      }
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

export function reconcileBootPromptWatchdog(): void {
  activeWatchdog?.tick();
}
