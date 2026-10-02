/**
 * F-735: espera a TUI terminar de ingerir uma colagem antes do Enter.
 *
 * O Codex no Windows recebe a colagem como teclas soltas (o ConPTY não
 * repassa o bracketed paste ao crossterm) e a ingere a ~0,5 ms por caractere
 * com a máquina ociosa. Medido em 02/10 no Codex 0.160: 2.000 caracteres →
 * 1,2 s; 4.500 → 2,3 s; 9.000 → 4,5 s. Enter que chega antes vira quebra de
 * linha DENTRO da colagem: o handoff ficava largado no composer e cada nova
 * tentativa colava outra cópia por cima ("[Pasted Content 4531 chars] #2").
 *
 * A partir de 1.000 caracteres o Codex só mostra `[Pasted Content N chars]`
 * quando aceitou a colagem inteira — é ESSE o sinal. Abaixo disso o Enter de
 * 500 ms já passava (950 caracteres, medido). No macOS o marcador chega junto
 * com a colagem e a espera é nula.
 */
import {
  getAgentSessionInfo,
  tapSessionData,
  tapSessionExit,
} from '../pty/pty-manager';
import { stripAnsi } from './pane-session-output';

/** O Codex troca a colagem pelo marcador a partir daqui. */
export const CODEX_LARGE_PASTE_CHARS = 1000;
/**
 * O diff do ratatui desenha espaços com movimento de cursor: sem os escapes,
 * o marcador chega como `PastedContent4531chars`.
 */
export const CODEX_PASTE_MARKER = /Pasted\s*Content\s*\d+\s*chars/i;
/** Folga entre o marcador e o Enter (o Codex aceitou com 0 ms; 150 é margem). */
export const PASTE_INGEST_GRACE_MS = 150;
/**
 * Teto da espera: 2 s + 1,5 ms por caractere (3× o ritmo medido com a máquina
 * ociosa — com muitos panes vivos a ingestão é mais lenta), no máximo 30 s.
 * Vencido o teto, o Enter sai assim mesmo: nunca é pior que o caminho antigo.
 */
const PASTE_INGEST_BASE_MS = 2_000;
const PASTE_INGEST_MS_PER_CHAR = 1.5;
export const PASTE_INGEST_MAX_MS = 30_000;
/** Só a saída nova interessa, e o marcador cabe com folga neste rabo. */
const PASTE_INGEST_TAIL_CHARS = 8_192;

export interface PasteIngestPlan {
  readonly marker: RegExp;
  readonly capMs: number;
}

export type PasteIngestOutcome = 'marker' | 'cap' | 'exit';

export interface PasteIngestWatch {
  /** Resolve no marcador, no teto ou na saída da sessão. */
  readonly done: Promise<PasteIngestOutcome>;
  /** Desarma sem resolver `done` (quem cancela não espera mais). */
  cancel(): void;
}

export function pasteIngestCapMs(pastedChars: number): number {
  return Math.min(
    PASTE_INGEST_MAX_MS,
    Math.round(PASTE_INGEST_BASE_MS + Math.max(0, pastedChars) * PASTE_INGEST_MS_PER_CHAR),
  );
}

/** Plano de espera para colar `pastedChars` caracteres neste adapter; null = Enter no tempo de sempre. */
export function pasteIngestPlan(
  adapterId: string | undefined,
  pastedChars: number,
): PasteIngestPlan | null {
  if (adapterId !== 'codex' || pastedChars < CODEX_LARGE_PASTE_CHARS) return null;
  return { marker: CODEX_PASTE_MARKER, capMs: pasteIngestCapMs(pastedChars) };
}

/** Mesmo plano, resolvendo o adapter pela sessão física (colagem curta nem consulta). */
export function pasteIngestPlanForSession(
  sessionId: string,
  pastedChars: number,
): PasteIngestPlan | null {
  if (pastedChars < CODEX_LARGE_PASTE_CHARS) return null;
  return pasteIngestPlan(getAgentSessionInfo(sessionId)?.adapterId, pastedChars);
}

/**
 * Arme ANTES de escrever a colagem: a TUI pode desenhar o marcador logo no
 * primeiro pedaço de saída. Só a saída escrita depois do arme conta, então um
 * marcador velho que já estava no composer não é lido como a colagem nova.
 */
export function watchPasteIngest(
  sessionId: string,
  plan: PasteIngestPlan,
): PasteIngestWatch {
  let tail = '';
  let settled = false;
  let resolveDone: (outcome: PasteIngestOutcome) => void = () => {};
  const done = new Promise<PasteIngestOutcome>((resolve) => {
    resolveDone = resolve;
  });
  let untapData: () => void = () => {};
  let untapExit: () => void = () => {};
  const disarm = () => {
    settled = true;
    untapData();
    untapExit();
    clearTimeout(timer);
  };
  const finish = (outcome: PasteIngestOutcome) => {
    if (settled) return;
    disarm();
    resolveDone(outcome);
  };
  untapData = tapSessionData((changedSessionId, data) => {
    if (changedSessionId !== sessionId || settled || data.length === 0) return;
    tail = (tail + data).slice(-PASTE_INGEST_TAIL_CHARS);
    if (plan.marker.test(stripAnsi(tail))) finish('marker');
  });
  untapExit = tapSessionExit((exitedSessionId) => {
    if (exitedSessionId === sessionId) finish('exit');
  });
  const timer = setTimeout(() => finish('cap'), plan.capMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    done,
    cancel: () => {
      if (!settled) disarm();
    },
  };
}
