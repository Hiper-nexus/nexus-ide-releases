import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { attachTerminalPathLinks } from './terminal-path-links';
import { TerminalGhostAssist } from './terminal-ghost-assist';
import '@xterm/xterm/css/xterm.css';
import type { PaneModel } from '../../shared/types';
import type { PaneParkRequest } from '../../shared/orch-types';
import { buildPtySpawnRequest } from './spawn-request';
import type { TerminalSettings } from '../../shared/settings-types';
import { DEFAULT_TERMINAL_SETTINGS } from '../../shared/settings-types';
import {
  setRestoredPanesHandler,
  setTerminalSnapshotProvider,
  useLayoutStore,
} from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { usePaneParkedStore } from '../state/pane-parked-store';
import { useOrchStore } from '../state/orch-store';
import { useToastStore } from '../state/toast-store';
import { getActiveWorkspacePath } from '../state/active-workspace';
import { filesFromClipboardData } from '../lib/mission-attachments';
import {
  clipboardAnnouncesPayload,
  describeDropWithoutFiles,
  describePasteWithoutFiles,
  droppedProjectContextPath,
  droppedUriRejectionMessage,
  embeddedImageFromHtml,
  fileFromEmbeddedImage,
  fileUrlForPath,
  pasteUrisFromClipboard,
  resolveDroppedMissionContextPath,
  resolveDropUris,
  toAbsoluteContextPath,
  type DroppedUri,
  type DroppedPayload,
} from '../lib/mission-shell-file-intake';
import { listPanes } from '../lib/split-tree';
import { cliPaneDisplayTitle, normalizePaneTitle } from '../lib/pane-title';
import {
  missionAwaitsOperatorReview,
  wasMissionRuntimeClosedByOperator,
} from '../../shared/mission-recovery-policy';
import { wasMissionLeftoverParked } from '../../shared/mission-leftover-isolation';
import { paneInputLane } from './pane-input-route';
import {
  clearPaneSpawnError,
  recordPaneSpawnError,
} from './pane-spawn-errors';
import {
  BLOCKED_RESUME_NOTICE,
  decideDeadPaneReviveRespawn,
  decideExitedPaneKey,
  decideTerminalMissionDeadPaneKey,
  decideOrchestratorProcessExit,
  decideStaleAuthorityRecovery,
  decideUnlockRetiredMissionPane,
  latestCivilianDeliverySummary,
  MISSION_HOLD_NOTICE,
  missionOwnedExitNotice,
  orchestratorOwnedExitLines,
  STALE_AUTHORITY_SYNC_NOTICE,
  STALE_AUTHORITY_UNLOCK_NOTICE,
  STANDALONE_HOLD_NOTICE,
  shouldInjectResumeContinuation,
  shouldInterruptBusyWorkerAfterMaestroTurnEnd,
  shouldKickMissionEngineOnDeadPaneKey,
  shouldPrintMissionPaneExitNotice,
  shouldReviveDeadMissionFromPane,
  terminalDeadPaneFastPathApplies,
} from './mission-owned-pane-policy';
import {
  DEAD_PANE_MISSION_RELIVED_NOTICE,
  DEAD_PANE_REVIVE_ATTEMPT_NOTICE,
  DEAD_PANE_REVIVE_CHECK_NOTICE,
  DEAD_PANE_REVIVE_COOLDOWN_NOTICE,
  DONE_MAESTRO_ADJUSTMENT_NOTICE,
  deadHelperPaneHistoryNotice,
  deadMaestroKeyRequestsAdjustment,
  deadPaneReviveCooldownNoticeDue,
  type TerminalMissionLink,
} from './mission-owned-pane-policy';
import { TERMINAL_THEMES } from '../styles/terminal-theme';
import {
  discardTerminalOutput,
  flushTerminalOutput,
  getTerminalOutputRuntimeSnapshot,
  pauseTerminalOutput,
  resumeTerminalOutput,
  writeTerminalOutput,
} from './terminal-output-scheduler';
import { TerminalInputVisibilityController } from './terminal-input-visibility';
import {
  submitPromptToPane as submitPanePrompt,
  submitPromptToPaneConfirmed as submitPanePromptConfirmed,
  submitPromptToPaneOperator as submitPanePromptOperator,
} from './pane-submit';
import { WebglLeasePool } from './webgl-lease';
import { resumeTerminalVisibilityBeforePaint } from './terminal-visibility-resume';
import { shouldAutoPinPaneAccount } from './pane-account-authority';
import {
  cliAcceptsContinuityPrompt,
  nextContinuityInjectionDelay,
  takePendingContinuity,
} from '../orch/stranded-mission-handoff';
import {
  createAdoptionRepaintTape,
  repaintAdoptedFrame,
} from './adoption-repaint';
import {
  SCROLLBACK_WIDTH_MISMATCH_NOTICE,
  SESSION_BOUNDARY_NOTICE,
  TERMINAL_INPUT_MODE_RESET,
  terminalBufferHasContent,
} from './session-boundary-notice';
import {
  canReplayScrollback,
  clampGridToUsableCols,
  escalateRefitReason,
  hostGridIsUsable,
  hostSlotIsMeasurable,
  shouldBouncePtyGridAfterAttach,
  shouldRepaintOnRefit,
  terminalGridChanged,
  terminalOutputPolicy,
  terminalScrollbackLines,
  type RefitReason,
} from './terminal-render-policy';
import { notifyPaneWorkspaceReveal } from '../lib/pane-intersection';
import { tuiWheelPageSequence } from './tui-wheel';
import { xtermWindowsPty } from '../lib/platform';

/**
 * Persistent terminal manager.
 *
 * Each pane gets ONE long-lived xterm instance + PTY, keyed by pane id and kept
 * in this module-level map. The layout tree only renders empty slots; on every
 * (re)mount a pane's React wrapper re-parents the SAME DOM node into its slot.
 * Because the terminal element is never recreated, splitting or closing panes
 * reshapes the grid without resetting any shell — the terminal survives the
 * DOM move. Disposal happens only via `reconcileHosts` when a pane truly
 * leaves the tree.
 */

interface Host {
  element: HTMLDivElement;
  paneId: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
  ro: ResizeObserver;
  sessionId: string | null;
  kind: 'shell' | 'cli-agent';
  /**
   * Hibernação de pane oculto (virtualização): em grids grandes o xterm de
   * um pane que saiu da tela é descartado e só o snapshot + o buffer de
   * output pendente ficam. `cols` guarda a largura do snapshot (o replay só
   * é legível na mesma geometria — ver pendingScrollbackCols).
   */
  virtualized: {
    cols: number;
    snapshot: string;
    pendingOutput: string;
  } | null;
  /** Relive do Maestro: não despejar [nexus] no PTY. */
  quietSpawn?: boolean;
  /** Spawn adiado até o slot ter caixa real (F-009). */
  spawnWhenMeasurable?: boolean;
  /**
   * Retentativa do spawn adiado. O ResizeObserver era o único gatilho para
   * retomar um spawn que esperava slot mensurável — e quando a grade de
   * terminais sai de `hidden` o fit pode falhar no mesmo frame (medida de
   * fonte ainda zero) e o tamanho depois fica estável: nenhum evento novo,
   * pane em branco para sempre (campo 09/09: pane aberto no Início).
   */
  deferredSpawnRetry?: ReturnType<typeof setTimeout>;
  /**
   * Teto do spawn adiado. O backoff sozinho não termina: um slot que NUNCA fica
   * mensurável (pane numa área que nunca é revelada) ficava reagendando de 2s
   * em 2s para sempre, em silêncio — timer vivo permanente e pane vazio sem
   * nenhuma pista para o operador. Passado o orçamento, desistimos ALTO.
   */
  deferredSpawnBudgetUntil?: number;
  /** Last grid already propagated to the PTY; avoids duplicate SIGWINCH. */
  reportedGrid: { cols: number; rows: number } | null;
  isVisible: boolean;
  /** False between reveal/failed measurement and the next successful fit. */
  gridReady: boolean;
  /** Last usable xterm grid remains valid for parsing while the host is detached. */
  hasFittedGrid: boolean;
  /** One-shot notice when agent is held pending user approval. */
  holdNoticeWritten?: boolean;
  /** Invalidates a late async spawn after recovery timeout/replacement. */
  spawnGeneration: number;
  opened: boolean;
  spawnStarted: boolean;
  /**
   * Sessão que o main avisou que vai encerrar para FECHAR o pane. O exit
   * dela não oferece shell nem religa: o closeRequest vem logo atrás.
   */
  closingSessionId?: string;
  /** Pane morto aguardando o closeRequest; teclas não viram shell. */
  awaitingDeliberateClose?: boolean;
  hibernated: boolean;
  /**
   * Estacionado: o workspace dono deste pane saiu de cena, mas o processo
   * continua vivo e o xterm guardado fora do DOM. `reconcileHosts` não
   * descarta um host estacionado; `attachHost` o recoloca na tela ao voltar.
   */
  parked: boolean;
  disposed: boolean;
  /** Keeps the live composer visible and repairs missed interactive paints. */
  inputVisibility: TerminalInputVisibilityController;
  ghostAssist?: TerminalGhostAssist;
  cleanups: Array<() => void>;
  /** Live WebGL addon while this host holds a lease from the pool. */
  webgl?: WebglAddon;
  /**
   * Scrollback salvo esperando a PRIMEIRA medição real do slot.
   *
   * O conteúdo foi serializado na largura que o terminal tinha quando o pane
   * foi salvo. Reescrevê-lo antes do fit joga tudo numa grade de 80 colunas: a
   * TUI do agente desenha caixas com posicionamento absoluto, então a moldura
   * cai por cima do resto da linha quebrada e o texto sai duplicado/entrelaçado
   * (`cCaude Codeev2.1.220h`, letras soltas empilhadas na borda direita). E
   * isso NÃO tem volta: reflow de resize não reconstrói o que foi escrito com
   * cursor absoluto. Por isso o replay espera a largura definitiva.
   */
  pendingScrollback?: string;
  /**
   * Largura em que `pendingScrollback` foi capturado. Esperar a largura
   * definitiva não basta: a fita já CARREGA a geometria antiga. Reescrever
   * 100 colunas de moldura numa grade de 76 produz exatamente o entrelaçamento
   * descrito acima. Quando as larguras não batem, o replay é descartado — um
   * pane limpo com a sessão viva atrás é melhor que histórico ilegível.
   */
  pendingScrollbackCols?: number;
  /**
   * The pane already shows (or is about to replay) content from a previous
   * session — persisted scrollback or an earlier live session in this same
   * xterm. A new session attaching to such a pane prints the
   * SESSION_BOUNDARY_NOTICE divider first; an empty first spawn never does.
   */
  hasVisibleContent?: boolean;
  /**
   * Aviso de cooldown do revive já impresso para ESTA janela
   * (`deadPaneReviveAt`): a tecla repetida dentro dos 15s fica muda; uma
   * janela nova (outro carimbo) pode avisar de novo (F-367).
   */
  deadPaneReviveNoticeWindowStart?: number;
  /**
   * Desbloqueio/revive de pane morto em voo (contador: o unlock encadeia o
   * revive). Teclas nesse intervalo são engolidas em silêncio — sem a
   * guarda, cada uma pagava um listMissions IPC (F-367).
   * `deadPaneKeyWorkSince` marca o início do lote: passados 20 s sem
   * resolução o trabalho é considerado pendurado e a guarda se libera (R1).
   */
  deadPaneKeyWorkInFlight?: number;
  deadPaneKeyWorkSince?: number;
  /**
   * F-213: início do ciclo de nascimento (primeira tentativa de spawn que
   * pode adiar por grade ou espera held). O `rendererWaitMs` do pedido mede
   * até `pty.spawn`; consumido (reset) quando o spawn efetivamente inicia.
   */
  spawnCycleStartMs?: number;
  /**
   * F-369: saída foi perdida ou truncada (backlog dropado / xterm
   * reidratado com fita cortada) — a TUI pode ter ficado com buracos.
   * Consumida no próximo resume visível: um bounce de grade manda a CLI
   * redesenhar a moldura inteira.
   */
  needsTuiRepaint?: boolean;
}

/**
 * Reescreve o scrollback salvo assim que o terminal tem a largura final.
 * Idempotente: só corre uma vez por host.
 */
function flushPendingScrollback(host: Host): void {
  const pending = host.pendingScrollback;
  if (!pending || host.disposed || !host.opened) return;
  const capturedCols = host.pendingScrollbackCols;
  delete host.pendingScrollback;
  delete host.pendingScrollbackCols;

  // Geometria diferente: a fita é irrecuperável. Descartar é a única saída
  // honesta — reflow não desfaz cursor absoluto.
  if (!canReplayScrollback(capturedCols, host.term.cols)) {
    host.term.write(SCROLLBACK_WIDTH_MISMATCH_NOTICE);
    return;
  }

  host.inputVisibility.follow();
  host.term.write(pending, () => {
    if (host.disposed || !host.inputVisibility.isFollowing) return;
    host.term.scrollToBottom();
    try {
      host.term.refresh(0, Math.max(0, host.term.rows - 1));
    } catch {
      // The next PTY write will paint after an early restore race.
    }
  });
}

function reportPaneResumeIncident(
  pane: PaneModel,
  code: 'stale-exact-id' | 'resume-fallback-failed',
  message: string,
  recovered: boolean,
): void {
  const record = {
    id: crypto.randomUUID(),
    action: 'pane_resume',
    code,
    message,
    paneId: pane.id,
    adapterId: pane.adapterId,
    recovered,
    occurredAt: Date.now(),
  };
  try {
    const key = 'nexus.runtime-incidents.v1';
    const previous = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    sessionStorage.setItem(
      key,
      JSON.stringify([...(Array.isArray(previous) ? previous : []), record].slice(-50)),
    );
  } catch {
    // Incident reporting must never break pane recovery.
  }
  window.nexus.voice.logVoice({
    level: recovered ? 'warn' : 'error',
    event: 'runtime.incident',
    msg: message,
    data: record,
  });
  useToastStore.getState().push(
    recovered ? 'warn' : 'error',
    recovered ? 'Doctor recuperando sessão do pane' : 'Falha ao retomar a sessão',
    message,
  );
}

// Chromium limita contextos WebGL por página (~8-16); um squad grande +
// respawns estourava o pool e os terminais mais antigos ficavam EM BRANCO.
// Os contextos são ALUGADOS por recência de foco (ver webgl-lease.ts): focar
// um pane no renderer DOM rouba o slot do detentor menos recente, então o
// que o usuário está olhando renderiza sempre em WebGL. O teto fica abaixo
// do limite do Chromium para absorver o lag de GC entre dispose e create.
const WEBGL_MAX = 8;
const webglPool = new WebglLeasePool(WEBGL_MAX);

/** Bind a host to the lease pool: how to load and unload its WebGL addon. */
function registerWebglLease(paneId: string, host: Host): void {
  webglPool.register(paneId, {
    activate: (): boolean => {
      if (host.disposed || !host.opened) return false;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webglPool.notifyLost(paneId);
          if (host.webgl === webgl) host.webgl = undefined;
          webgl.dispose();
          // A lost context can freeze the last canvas frame after xterm has
          // already parsed newer PTY bytes. Repaint on the fallback renderer;
          // the next focus/input can safely request a fresh lease without an
          // eager context-loss/recreate loop on unstable GPUs.
          requestAnimationFrame(() => {
            if (host.disposed || !host.opened) return;
            host.inputVisibility.repaintNow();
          });
        });
        host.term.loadAddon(webgl);
        host.webgl = webgl;
        return true;
      } catch {
        return false;
      }
    },
    deactivate: (): void => {
      const webgl = host.webgl;
      host.webgl = undefined;
      try {
        webgl?.dispose();
      } catch {
        // Addon already gone with the terminal.
      }
      try {
        // The DOM renderer repaints lazily; force a refresh so the evicted
        // pane doesn't sit stale until its next PTY write.
        host.term.refresh(0, Math.max(0, host.term.rows - 1));
      } catch {
        // Terminal not opened or already disposed.
      }
    },
  });
}

/**
 * Reveal/focus boundary for a live terminal.
 *
 * Reacquiring WebGL may change xterm's character metrics. Fit and propagate
 * the resulting grid before promoting any background output; otherwise a TUI
 * frame can be parsed against the transient DOM-renderer dimensions.
 */
function resumeVisibleHost(paneId: string, host: Host): boolean {
  const resumed = resumeTerminalVisibilityBeforePaint({
    resumeRenderer: () => webglPool.touch(paneId),
    fitVisibleGrid: () => fitHostGrid(host),
    propagateSize: () => propagateHostSize(host, { assert: true }),
    flushOutput: () => {
      resumeTerminalOutput(host.term);
      flushPendingScrollback(host);
      flushTerminalOutput(host.term);
    },
    repaint: () => host.inputVisibility.repaintNow(),
  });
  // F-369: depois do fit/propagação, com a grade já definitiva — o bounce
  // faz a CLI repintar por cima dos fragmentos da saída perdida.
  consumeTuiRepaint(host);
  return resumed;
}

const hosts = new Map<string, Host>();
const MAX_PERSISTED_SCROLLBACK = 256_000;

setTerminalSnapshotProvider((paneId) => {
  const host = hosts.get(paneId);
  if (!host || host.disposed) return undefined;
  if (host.virtualized) {
    return {
      data: host.virtualized.snapshot.slice(-MAX_PERSISTED_SCROLLBACK),
      cols: host.virtualized.cols,
    };
  }
  if (!host.opened) return undefined;
  try {
    flushTerminalOutput(host.term);
    return {
      data: host.serialize.serialize().slice(-MAX_PERSISTED_SCROLLBACK),
      cols: host.term.cols,
    };
  } catch {
    return undefined;
  }
});

// Notified when a pane's PTY sessionId is assigned or cleared. A session
// materializes ASYNCHRONOUSLY after spawn — not on a layout change — so this
// event is what lets consumers react without polling. It replaces three
// identical 150ms waitForSession copies AND the 1s syncPanes heartbeat.
type PaneSessionListener = (paneId: string, sessionId: string | null) => void;
const paneSessionListeners = new Set<PaneSessionListener>();

export function onPaneSessionChange(cb: PaneSessionListener): () => void {
  paneSessionListeners.add(cb);
  return () => paneSessionListeners.delete(cb);
}

/** Assign (or clear) a host's sessionId and notify subscribers. */
function setHostSession(
  host: Host,
  paneId: string,
  sessionId: string | null,
): void {
  host.sessionId = sessionId;
  if (sessionId) host.awaitingDeliberateClose = false;
  host.reportedGrid = sessionId
    ? { cols: host.term.cols, rows: host.term.rows }
    : null;
  for (const cb of [...paneSessionListeners]) {
    try {
      cb(paneId, sessionId);
    } catch {
      // A listener must never break the spawn/session path.
    }
  }
}

function propagateHostSize(
  host: Host,
  options?: { assert?: boolean },
): boolean {
  if (!host.sessionId) return false;
  const next = { cols: host.term.cols, rows: host.term.rows };
  // F-216: a asserção sai mesmo com grade igual ao reportedGrid — winsize
  // idêntico é no-op para a CLI, winsize divergente cura o drift e a TUI
  // fullscreen repinta sozinha.
  if (options?.assert !== true && !terminalGridChanged(host.reportedGrid, next)) {
    return false;
  }
  window.nexus.pty.resize(
    host.sessionId,
    next.cols,
    next.rows,
    options?.assert === true ? { assert: true } : undefined,
  );
  host.reportedGrid = next;
  return true;
}

const DEFAULT_FONT_STACK =
  '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Monaco, monospace';

// Live user settings (theme/font/shell) pushed in by the settings controller.
// New terminals read them at build time; applyTerminalSettings restyles the
// already-open ones.
let currentSettings: TerminalSettings = DEFAULT_TERMINAL_SETTINGS;

function fontFamilyOf(settings: TerminalSettings): string {
  return settings.fontFamily.trim() !== ''
    ? settings.fontFamily
    : DEFAULT_FONT_STACK;
}

function themeOf(settings: TerminalSettings) {
  return (
    TERMINAL_THEMES[settings.themeId] ??
    TERMINAL_THEMES[DEFAULT_TERMINAL_SETTINGS.themeId]
  ).theme;
}

/** Apply user settings: restyle every live terminal, remember for new ones. */
export function applyTerminalSettings(settings: TerminalSettings): void {
  currentSettings = settings;
  for (const [paneId, host] of hosts) {
    if (host.disposed || host.virtualized) continue;
    host.term.options.theme = themeOf(settings);
    host.term.options.fontFamily = fontFamilyOf(settings);
    host.term.options.fontSize = settings.fontSize;
    host.term.options.scrollback = terminalScrollbackLines(
      host.element.classList.contains('term-host--agent')
        ? 'cli-agent'
        : 'shell',
      settings.performanceMode,
    );
    if (settings.performanceMode === 'quality') {
      resumeTerminalOutput(host.term);
    } else if (!host.isVisible || document.visibilityState === 'hidden') {
      pauseTerminalOutput(host.term);
      webglPool.suspend(paneId);
    }
    try {
      // Force an immediate repaint — the WebGL renderer can otherwise defer
      // recoloring until the next data write.
      host.term.refresh(0, Math.max(0, host.term.rows - 1));
    } catch {
      // Terminal not opened yet.
    }
    try {
      if (fitHostGrid(host)) propagateHostSize(host);
    } catch {
      // Not measurable yet — the ResizeObserver will settle it.
    }
  }
}

// Agentes produzem o grosso do output e dominam custo de memória/pintura
// (pior ainda quando evictados para o renderer DOM), então recebem um buffer
// mais enxuto. O snapshot persistido de 256 KB não é afetado.
function buildTerminal(kind: 'shell' | 'cli-agent'): {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
} {
  const windowsPty = xtermWindowsPty();
  const term = new Terminal({
    fontFamily: fontFamilyOf(currentSettings),
    fontSize: currentSettings.fontSize,
    lineHeight: 1.2,
    cursorBlink: false,
    allowProposedApi: true,
    theme: themeOf(currentSettings),
    scrollback: terminalScrollbackLines(
      kind,
      currentSettings.performanceMode,
    ),
    // Alt+roda (modificador fixo do xterm 6) rola 5x mais rápido.
    fastScrollSensitivity: 5,
    // F-673: ConPTY no Windows (ver xtermWindowsPty).
    ...(windowsPty ? { windowsPty } : {}),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(serialize);
  attachTerminalPathLinks(term);
  return { term, fit, search, serialize };
}

export type RespawnMode =
  | 'same-account-resume'
  | 'cross-account-continuity';

/**
 * Strip ANSI CSI/OSC sequences for continuity pack excerpts (best-effort).
 */
function stripAnsiForExcerpt(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b./g, '');
}

/** Last N chars of xterm buffer for failover handoff (empty if host missing). */
export function getScrollbackExcerpt(paneId: string, max = 2_400): string {
  const host = hosts.get(paneId);
  if (!host || host.disposed || !host.opened) return '';
  try {
    flushTerminalOutput(host.term);
    const raw = host.serialize.serialize().slice(-max * 2);
    return stripAnsiForExcerpt(raw).slice(-max);
  } catch {
    return '';
  }
}

declare global {
  interface Window {
    __nexusGetScrollbackExcerpt?: typeof getScrollbackExcerpt;
  }
}
if (typeof window !== 'undefined') {
  window.__nexusGetScrollbackExcerpt = getScrollbackExcerpt;
}

/**
 * Missões que já receberam UMA retomada automática nesta sessão do renderer.
 *
 * O beco circular documentado no bootstrap: missão bloqueada → seal nulo →
 * spawn persistido recusado → pane morto → nova tentativa de spawn. A saída
 * sancionada é a retomada main-owned (re-arma para running e revalida tudo),
 * então a primeira recusa roteia para ela. Uma única vez por missão neste
 * renderer: se a retomada também não sustentar a missão, o coordenador
 * main-owned assume os retries técnicos com backoff; o renderer não cria um
 * segundo loop concorrente.
 */
const missionAutoResumeSpent = new Set<string>();
const missionRuntimeResumeInFlight = new Set<string>();
/**
 * Voo real 19/08: cada tecla num pane morto imprimia "tecla recebida —
 * revivendo a missão" e disparava retry-kickoff de novo (12+ linhas seguidas
 * sem mudança de estado). Uma tentativa por janela; teclas repetidas dentro
 * dela são no-op silencioso.
 */
const DEAD_PANE_REVIVE_COOLDOWN_MS = 15_000;
const deadPaneReviveAt = new Map<string, number>();

export function shouldAttemptDeadPaneRevive(
  missionId: string,
  now = Date.now(),
): boolean {
  const last = deadPaneReviveAt.get(missionId);
  if (last !== undefined && now - last < DEAD_PANE_REVIVE_COOLDOWN_MS) {
    return false;
  }
  deadPaneReviveAt.set(missionId, now);
  return true;
}

function missionReviveRecoveryCopy(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/pergunta do operador exige resposta/i.test(message)) {
    return 'A missão aguarda uma resposta. Responda no board da missão para continuar.';
  }
  if (/encerrada pelo operador/i.test(message)) {
    return 'Use Retomar no rail.';
  }
  return 'Use Retomar no rail.';
}

async function requestMissionRuntimeResume(
  missionId: string,
  operatorInitiated = false,
): Promise<void> {
  if (missionRuntimeResumeInFlight.has(missionId)) return;
  missionRuntimeResumeInFlight.add(missionId);
  try {
    // Missão CONCLUÍDA só reabre por decisão humana explícita, e SÓ ela pode
    // virar `resume`: retry-kickoff é o gatilho mecânico (watchdog, auto-cura
    // de grant) e o motor o recusa em missão selada. Sem `operatorInitiated`
    // uma missão pronta NUNCA é reaberta daqui — foi assim que abrir
    // "Terminais" relançava a missão sozinho (bug de campo 23/08).
    const row = useOrchStore
      .getState()
      .missions.find((mission) => mission.id === missionId);
    const leftover =
      row != null &&
      (wasMissionLeftoverParked(row) ||
        wasMissionRuntimeClosedByOperator(row));
    const done = missionOfPaneIsDoneById(missionId);
    if ((done || leftover) && !operatorInitiated) return;
    await window.nexus.mission.command({
      kind: done || leftover ? 'resume' : 'retry-kickoff',
      missionId,
    });
  } finally {
    missionRuntimeResumeInFlight.delete(missionId);
  }
}

/** Espelho local: a missão desta id está concluída? */
function missionOfPaneIsDoneById(missionId: string): boolean {
  return (
    useOrchStore.getState().missions.find((m) => m.id === missionId)?.status ===
    'done'
  );
}

/**
 * Tecla em pane morto de missão viva: revive a missão (retry-kickoff, que
 * respawna o orquestrador) e, em panes do renderer, religa a própria CLI na
 * mesma conta — o teclado volta a aceitar input no pane onde o operador
 * digitou (o trio "dona / pausado / cursor oco" era o beco sem saída).
 */
/**
 * Maestro VIVO da missão: pane com papel de coordenador ligado a ela, com
 * sessão PTY e estado utilizável. É quem decide se a tecla num pane de
 * worker morto vira retry-kickoff ou só um apontador para o pane certo —
 * kickoff numa missão com Maestro vivo respawnaria coordenação em cima de
 * coordenação (F-368).
 */
function liveMaestroPaneOfMission(missionId: string): PaneModel | null {
  const paneMissions = useOrchStore.getState().paneMissions;
  return (
    listPanes(useLayoutStore.getState().root).find(
      (candidate) =>
        candidate.role === 'orchestrator' &&
        (candidate.missionId ?? paneMissions[candidate.id]) === missionId &&
        getPaneSessionId(candidate.id) !== null &&
        paneState(candidate.id) !== 'exited' &&
        paneState(candidate.id) !== 'hibernated',
    ) ?? null
  );
}

/**
 * Guarda de tecla em pane morto (F-367): enquanto unlock/revive está em
 * voo, a próxima tecla é engolida em silêncio. Contador porque o unlock
 * encadeia o revive — o trabalho só acaba quando os dois terminam.
 */
function beginDeadPaneKeyWork(host: Host): void {
  if ((host.deadPaneKeyWorkInFlight ?? 0) === 0) {
    host.deadPaneKeyWorkSince = Date.now();
  }
  host.deadPaneKeyWorkInFlight = (host.deadPaneKeyWorkInFlight ?? 0) + 1;
}

function endDeadPaneKeyWork(host: Host): void {
  host.deadPaneKeyWorkInFlight = Math.max(
    0,
    (host.deadPaneKeyWorkInFlight ?? 1) - 1,
  );
  if (host.deadPaneKeyWorkInFlight === 0) host.deadPaneKeyWorkSince = undefined;
}

/**
 * R1: a guarda silencia teclas SÓ enquanto o trabalho está vivo de verdade.
 * Um IPC pendurado (listMissions sem resposta) não pode calar o pane para
 * sempre — passado o teto, a guarda se libera e a próxima tecla tenta de novo.
 */
const DEAD_PANE_KEY_WORK_STUCK_MS = 20_000;

function deadPaneKeyWorkActive(host: Host): boolean {
  if ((host.deadPaneKeyWorkInFlight ?? 0) <= 0) return false;
  if (
    Date.now() - (host.deadPaneKeyWorkSince ?? 0) >
    DEAD_PANE_KEY_WORK_STUCK_MS
  ) {
    host.deadPaneKeyWorkInFlight = 0;
    host.deadPaneKeyWorkSince = undefined;
    return false;
  }
  return true;
}

async function requestDeadMissionPaneRevive(
  pane: PaneModel,
  host: Host,
  missionId: string,
  operatorInitiated = false,
): Promise<void> {
  if (!shouldReviveDeadMissionFromPane({ operatorInitiated })) return;
  if (!shouldAttemptDeadPaneRevive(missionId)) {
    // Repetição dentro do cooldown: uma dica POR JANELA (o carimbo de
    // início é a chave) — antes cada tecla repetia a linha (F-367).
    const windowStart = deadPaneReviveAt.get(missionId);
    if (
      operatorInitiated &&
      deadPaneReviveCooldownNoticeDue({
        windowStart,
        lastNotifiedWindowStart: host.deadPaneReviveNoticeWindowStart,
      })
    ) {
      host.deadPaneReviveNoticeWindowStart = windowStart;
      host.term.writeln(
        `\r\n\x1b[36m${DEAD_PANE_REVIVE_COOLDOWN_NOTICE}\x1b[0m`,
      );
    }
    return;
  }
  // Segura a guarda de tecla enquanto o revive trabalha: unlock → revive
  // viram UMA ação para a próxima tecla.
  beginDeadPaneKeyWork(host);
  try {
    await runDeadMissionPaneRevive(pane, host, missionId, operatorInitiated);
  } finally {
    endDeadPaneKeyWork(host);
  }
}

async function runDeadMissionPaneRevive(
  pane: PaneModel,
  host: Host,
  missionId: string,
  operatorInitiated: boolean,
): Promise<void> {
  // Confirmação de recebimento ANTES do trabalho async (não é promessa de
  // aceite: recusa/falha ganham as linhas próprias abaixo). Sem isto, uma
  // tentativa lenta parece tecla morta. Helper morto não promete religar
  // NADA neste pane — só verifica a missão (F-368).
  if (operatorInitiated) {
    host.term.writeln(
      `\r\n\x1b[36m${
        pane.role === 'orchestrator'
          ? DEAD_PANE_REVIVE_ATTEMPT_NOTICE
          : DEAD_PANE_REVIVE_CHECK_NOTICE
      }\x1b[0m`,
    );
  }
  try {
    // Pergunta pendente: não faz o remote call que vira erro vermelho no
    // terminal. A missão só volta quando o operador responde no board.
    const snapshot = await window.nexus.mission
      .snapshot(missionId)
      .catch(() => null);
    if (
      snapshot?.question &&
      snapshot.allowedActions.includes('answer-question')
    ) {
      host.term.writeln(
        '\r\n\x1b[36m[nexus] missão aguarda uma resposta. ' +
          'Responda no board para continuar; este pane fica como histórico.\x1b[0m',
      );
      return;
    }
    // Fala DEPOIS do aceite: anunciar "revivendo…" antes da cerca do main
    // recusar (missão encerrada pelo operador) lia como promessa quebrada —
    // sucesso ganha UMA linha, recusa ganha só a linha acionável do catch.
    if (
      deadMaestroKeyRequestsAdjustment({
        isOrchestrator: pane.role === 'orchestrator',
        missionDone: missionOfPaneIsDoneById(missionId),
      })
    ) {
      // Só o resume: o main religa o Maestro (noutro pane) esperando o
      // ajuste. Religar também aqui criaria dois Maestros na missão.
      await requestMissionRuntimeResume(missionId, operatorInitiated);
      host.term.writeln(`\r\n\x1b[36m${DONE_MAESTRO_ADJUSTMENT_NOTICE}\x1b[0m`);
      return;
    }
    if (
      !shouldKickMissionEngineOnDeadPaneKey({
        isOrchestrator: pane.role === 'orchestrator',
      })
    ) {
      reliveOrchestratorCli(pane, host, true);
      return;
    }
    const reviveRespawn = decideDeadPaneReviveRespawn({
      missionOwnsPane: isMainControlledMissionPane(pane.id, pane),
      hasOrchRequestId: pane.orchRequestId !== undefined,
      isOrchestrator: pane.role === 'orchestrator',
    });
    if (reviveRespawn === 'main-only') {
      // O agente DESTE pane encerrou, mas a missão pode seguir com o
      // Maestro vivo noutro leaf. Relançar o kickoff mataria essa
      // coordenação — aponta onde escrever e fica como histórico (F-368).
      const liveMaestro = liveMaestroPaneOfMission(missionId);
      if (liveMaestro) {
        host.term.writeln(
          `\r\n\x1b[36m${deadHelperPaneHistoryNotice(liveMaestro.title)}\x1b[0m`,
        );
        // R2: o aviso de histórico já encerra a conversa DESTA janela — sem o
        // carimbo, a próxima tecla caía no ramo de cooldown e imprimia
        // "tentativa recente em curso…" sem tentativa nenhuma em andamento.
        host.deadPaneReviveNoticeWindowStart = deadPaneReviveAt.get(missionId);
        return;
      }
    }
    await requestMissionRuntimeResume(missionId, operatorInitiated);
    if (reviveRespawn === 'same-pane-resume') {
      host.term.writeln(
        '\r\n\x1b[36m[nexus] religando o Maestro neste pane — a missão segue aberta para revisão.\x1b[0m',
      );
      respawnWithResume(
        pane,
        '[nexus] pane religado na mesma conta — a missão segue em curso.',
        { mode: 'same-account-resume' },
      );
    } else {
      // Worker / grant: o main respawna noutro leaf e este vira histórico.
      // A linha sai DEPOIS do comando aceito — antes, "o Maestro abre em
      // outro pane" era impresso mesmo quando o main não fazia nada
      // visível (F-368).
      host.term.writeln(`\r\n\x1b[36m${DEAD_PANE_MISSION_RELIVED_NOTICE}\x1b[0m`);
    }
  } catch (error) {
    if (!operatorInitiated) return;
    const message = error instanceof Error ? error.message : String(error);
    host.term.writeln(
      `\r\n\x1b[31m[nexus] revival da missão falhou: ${message}. ` +
        `${missionReviveRecoveryCopy(error)}\x1b[0m`,
    );
  }
}

async function routeBlockedMissionToResume(
  host: Host,
  missionId: string,
  options: { readonly manual?: boolean } = {},
): Promise<boolean> {
  // A cota de UMA tentativa vale só para o caminho automático; um clique do
  // operador é decisão nova e sempre pode tentar de novo.
  if (!options.manual && missionAutoResumeSpent.has(missionId)) return false;
  missionAutoResumeSpent.add(missionId);
  try {
    const missions = await window.nexus.orch.listMissions();
    const mission = missions.find((candidate) => candidate.id === missionId);
    if (!mission || mission.status !== 'blocked') return false;
    host.term.writeln(`\r\n\x1b[36m${BLOCKED_RESUME_NOTICE}\x1b[0m`);
    const { reopenMission } = await import('../orch/mission-reopen');
    const resumed = await reopenMission(mission);
    if (!resumed.ok) {
      host.term.writeln(
        `\r\n\x1b[31m[nexus] retomada recusada: ${resumed.error ?? 'motivo desconhecido'}\x1b[0m`,
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure cli-agent panes pin a vault account before spawn so failover and
 * multi-account isolation always know which credential is in use.
 */
async function ensurePaneAccountPin(
  pane: PaneModel,
): Promise<string | undefined> {
  if (pane.kind !== 'cli-agent' || !pane.adapterId) return pane.accountId;
  if (pane.accountId) return pane.accountId;
  try {
    const accounts = await window.nexus.accounts.list();
    const forAdapter = accounts.filter((a) => a.adapterId === pane.adapterId);
    const pick =
      forAdapter.find((a) => a.active && a.hasCredential && !a.onCooldown) ??
      forAdapter.find((a) => a.hasCredential && !a.onCooldown) ??
      forAdapter.find((a) => a.hasCredential);
    if (!pick) return undefined;
    useLayoutStore.getState().setAccountId(pane.id, pick.id);
    return pick.id;
  } catch {
    return undefined;
  }
}

function setupGhostAssist(host: Host, cwd?: string): void {
  if (host.ghostAssist) {
    try {
      host.ghostAssist.dispose();
    } catch {}
    host.ghostAssist = undefined;
  }
  const ga = new TerminalGhostAssist({
    terminal: host.term,
    screenElement: host.element,
    context: {
      getCwd: () => cwd || listPanes(useLayoutStore.getState().root).find((p) => p.id === host.paneId)?.cwd || '',
      getShell: () => '',
    },
    writeToPty: (chunk) => {
      if (host.sessionId) {
        window.nexus.pty.write(host.sessionId, chunk);
      }
    },
    localLookup: async (prefix) => {
      if (!host.sessionId || !window.nexus?.terminalBlock?.suggest) return null;
      try {
        const r = await window.nexus.terminalBlock.suggest({
          sessionId: host.sessionId,
          paneId: host.paneId,
          prefix,
          limit: 1,
        });
        return r.suggestions?.[0]?.command ?? null;
      } catch {
        return null;
      }
    },
  });
  host.ghostAssist = ga;
  host.cleanups.push(() => {
    ga.dispose();
    if (host.ghostAssist === ga) host.ghostAssist = undefined;
  });
}

function startSpawn(
  pane: PaneModel,
  host: Host,
  resume = false,
  resumeLatestOnly = false,
  continuityPack?: string,
  restorePersistedAuthority = false,
  skipContinuation = false,
): Promise<string | null> {
  const quietSpawn = host.quietSpawn === true;
  host.quietSpawn = false;
  const generation = host.spawnGeneration + 1;
  host.spawnGeneration = generation;
  host.spawnStarted = true;
  host.hibernated = false;
  // Qualquer spawn novo (Acordar, Reiniciar, digitar no pane dormindo) supera
  // o "estacionado" — é o único ponto por onde todo respawn deste pane passa.
  usePaneParkedStore.getState().clearParked(pane.id);
  useSessionStateStore.getState().setPaneState(pane.id, 'spawning');
  const pack = continuityPack ?? takePendingContinuity(pane.id);
  return (async (): Promise<string | null> => {
    try {
      // F-213: fases do renderer até o pty.spawn — espera de grade (intenção
      // de nascer → slot mensurável), espera held do gate de restore e a
      // pinagem de conta. `spawnCycleStartMs` é consumido aqui: uma retomada
      // posterior começa um ciclo novo.
      const spawnBeganAt = Date.now();
      const cycleStartMs = host.spawnCycleStartMs ?? spawnBeganAt;
      host.spawnCycleStartMs = undefined;
      const gridWaitMs = Math.max(0, spawnBeganAt - cycleStartMs);
      const heldSince = heldSpawnSinceMs.get(pane.id);
      heldSpawnSinceMs.delete(pane.id);
      const heldMs =
        heldSince !== undefined ? Math.max(0, spawnBeganAt - heldSince) : 0;
      const missionId =
        pane.missionId ?? useOrchStore.getState().paneMissions[pane.id];
      // Account absence is also sealed authority. Renderer-side vault
      // discovery is reserved for manual panes; every mission/orchestration
      // spawn must preserve the exact account Main selected (including none).
      const accountPinAt = Date.now();
      const accountId = shouldAutoPinPaneAccount(pane, missionId)
        ? await ensurePaneAccountPin(pane)
        : pane.accountId;
      const accountPinMs = Date.now() - accountPinAt;
      if (host.disposed || host.spawnGeneration !== generation) return null;
      const spawnCallAt = Date.now();
      const res = await window.nexus.pty.spawn(
        buildPtySpawnRequest({
          pane,
          cols: host.term.cols,
          rows: host.term.rows,
          // Panes always live inside the active workspace: restored panes from
          // older sessions (or the fresh initial tree) may lack a cwd — they
          // must open in the workspace folder, never the user's home.
          cwd: pane.cwd ?? getActiveWorkspacePath() ?? undefined,
          shell:
            pane.kind === 'shell' && currentSettings.shell !== ''
              ? currentSettings.shell
              : undefined,
          resume,
          resumeLatestOnly,
          restorePersistedAuthority,
          // paneId estável (layout persistido): com resume, o main retoma a
          // sessão de provider CAPTURADA deste pane (`--resume <id>`).
          accountId: accountId ?? pane.accountId,
          missionId,
          rendererWaitMs:
            pane.kind === 'cli-agent'
              ? Math.min(
                  600_000,
                  Math.max(0, Math.round(spawnCallAt - cycleStartMs)),
                )
              : undefined,
        }),
      );
      const spawnRpcMs = Date.now() - spawnCallAt;
      if (pane.kind === 'cli-agent') {
        console.info('[pane-birth]', {
          paneId: pane.id,
          gridWaitMs,
          accountPinMs,
          heldMs,
          spawnRpcMs,
        });
      }
      if (host.disposed || host.spawnGeneration !== generation) {
        if (res.ok) window.nexus.pty.kill(res.sessionId);
        return null;
      }
      if (!res.ok) {
        const isPersistedMissionAuthorityRefresh =
          /persisted mission pane authority/i.test(res.error);
        if (isPersistedMissionAuthorityRefresh) {
          // Uma sync. O spawn que já era restorePersistedAuthority — ou a
          // cota de auto-resume gasta — NÃO dispara outra onda: era o loop
          // que aposentava o único pane do Maestro e deixava o teclado mudo.
          host.spawnStarted = false;
          // Missão terminal não precisa de resume/sync/unlock: sem este guard
          // o fim de turno de uma missão JÁ concluída entrava na máquina de
          // restore e despejava sync-notice → unlock → shell em cascata.
          if (missionId && (await missionTerminalAuthoritative(missionId))) {
            useSessionStateStore.getState().setPaneState(pane.id, 'exited');
            return null;
          }
          console.warn(
            `[mission-restore] stale pane ${pane.id} was not restarted:`,
            res.error,
          );
          const action = missionId
            ? decideStaleAuthorityRecovery({
                restorePersistedAuthority,
                autoResumeAlreadySpent: missionAutoResumeSpent.has(missionId),
              })
            : 'unlock-keyboard';
          if (action === 'sync-once' && missionId) {
            host.term.writeln(
              `\r\n\x1b[36m${STALE_AUTHORITY_SYNC_NOTICE}\x1b[0m`,
            );
            void routeBlockedMissionToResume(host, missionId).then(
              (resumed) => {
                if (!resumed && !host.disposed) {
                  void unlockRetiredMissionPane(pane, host);
                }
              },
            );
          } else {
            void unlockRetiredMissionPane(pane, host);
          }
          useSessionStateStore.getState().setPaneState(pane.id, 'exited');
          return null;
        }
        host.spawnStarted = false;
        recordPaneSpawnError(pane.id, res.error);
        // Spent orch tokens leave a permanent dead pane on Reiniciar — drop
        // them. E o operador NÃO é o garbage collector do grant: com missão
        // conhecida, a autoridade fresca é reemitida SOZINHA pelo mesmo
        // retry-kickoff do teclado (cooldown de 15s evita loop). Pedir "use
        // Reiniciar de novo" era atrito puro (voo real 19/08).
        if (
          pane.orchRequestId &&
          /unknown or expired|orchestration spawn request/i.test(res.error)
        ) {
          useLayoutStore.getState().clearOrchRequestId(pane.id);
          const liveMaestro = missionId
            ? liveMaestroPaneOfMission(missionId)
            : null;
          if (liveMaestro) {
            // Grant órfão de um pane cujo Maestro está VIVO: o retry-kickoff
            // automático respawnaria a coordenação que já existe. Este pane
            // é histórico — aponta onde escrever (F-368).
            host.term.writeln(
              `\r\n\x1b[36m${deadHelperPaneHistoryNotice(liveMaestro.title)}\x1b[0m`,
            );
            useSessionStateStore.getState().setPaneState(pane.id, 'exited');
            return null;
          }
          if (missionId && shouldAttemptDeadPaneRevive(missionId)) {
            host.term.writeln(
              '\r\n\x1b[36m[nexus] autoridade de spawn expirou — reemitindo e ' +
                'religando a missão sozinho…\x1b[0m',
            );
            useSessionStateStore.getState().setPaneState(pane.id, 'exited');
            void requestMissionRuntimeResume(missionId).catch((error) => {
              if (!host.disposed) {
                host.term.writeln(
                  `\r\n\x1b[33m[nexus] religamento automático falhou — ` +
                    `${missionReviveRecoveryCopy(error)}\x1b[0m`,
                );
              }
            });
            return null;
          }
          host.term.writeln(
            '\r\n\x1b[33m[nexus] token de spawn expirado limpo — Reiniciar ' +
              'já usa autoridade nova.\x1b[0m',
          );
          useSessionStateStore.getState().setPaneState(pane.id, 'exited');
          return null;
        }
        host.term.writeln(
          `\r\n\x1b[31m[nexus] failed to start: ${res.error}\x1b[0m`,
        );
        useSessionStateStore.getState().setPaneState(pane.id, 'exited');
        return null;
      }
      if (pane.kind === 'cli-agent' && !missionId && res.accountId) {
        // The renderer's early account-list request may fail. Persist only the
        // account actually selected by Main so resume cannot choose a sibling.
        // Mission account bindings are persisted by Main's sealed pane store.
        useLayoutStore.getState().setAccountId(pane.id, res.accountId);
      }
      setHostSession(host, pane.id, res.sessionId);
      if (res.cwd) useLayoutStore.getState().setPaneCwd(pane.id, res.cwd);
      clearPaneSpawnError(pane.id);
      const spawnedAt = Date.now();
      // Session boundary: a NEW session attaching to a pane that already shows
      // content (restored scrollback, respawn in the same xterm) gets a divider
      // so dead-session output cannot blend into the live one. Adopted sessions
      // are the same live process continuing — no boundary — and a first spawn
      // of an empty pane stays clean.
      if (
        !res.adopted &&
        (host.hasVisibleContent ||
          terminalBufferHasContent(host.term.buffer.active))
      ) {
        // A sessão anterior pode ter morrido com mouse-tracking/paste-mode
        // ligados — desliga os modos de input ANTES do divisor, senão o novo
        // shell recebe cada movimento de mouse como ^[[<35;…M.
        host.term.write(TERMINAL_INPUT_MODE_RESET);
        if (!quietSpawn) host.term.writeln(SESSION_BOUNDARY_NOTICE);
      }
      host.hasVisibleContent = true;
      if (resume && !res.adopted && !quietSpawn) {
        // Teste do silêncio (0.62): só fala no pane o que explica um estado
        // SURPREENDENTE (histórico sumiu / conversa aproximada). Sucesso
        // exato é o esperado — reasseguramento vai pro log, não pra tela.
        if (res.resumeMode === 'exact') {
          console.log(`[nexus] sessão exata recuperada para o pane ${pane.id}`);
        } else {
          const message = missionId && res.resumeMode === 'fresh-context'
            ? '[nexus] a sessão anterior não está disponível — a missão continuará em contexto novo.'
            : '[nexus] nova conversa: não há uma sessão anterior confirmada para este pane.';
          host.term.writeln(`\r\n\x1b[33m${message}\x1b[0m`);
        }
      }

      host.cleanups.push(
        window.nexus.pty.onStateChange(res.sessionId, (state) => {
          useSessionStateStore.getState().setPaneState(pane.id, state);
        }),
      );

      // Adoption keeps a bounded copy of what it paints: the reset below
      // erases the frame and main cannot re-serve it (its replay window is
      // unacked-only). See adoption-repaint.ts.
      let adoptionTape = res.adopted ? createAdoptionRepaintTape() : null;

      if (!host.ghostAssist && pane.kind === 'shell') {
        setupGhostAssist(host, pane.cwd);
      }

      // Shared output scheduler: focused pane is latency-sensitive (immediate
      // write); hidden panes queue with a bounded backlog so concurrent agent
      // floods cannot pin the renderer. See terminal-output-scheduler.ts.
      host.cleanups.push(
        window.nexus.pty.onData(res.sessionId, (data) => {
          adoptionTape?.retain(data);
          host.ghostAssist?.ingestPtyData(data);
          if (host.virtualized) {
            // Pane hibernado: xterm descartado; reter saída no buffer do
            // estado e sair antes do scheduler (o ring do main cobre o resto).
            host.virtualized.pendingOutput = (
              host.virtualized.pendingOutput + data
            ).slice(-HIBERNATE_PENDING_OUTPUT_CHARS);
            return;
          }
          const paneVisible = host.isVisible && !host.parked;
          if (!host.gridReady && paneVisible && document.visibilityState !== 'hidden') {
            resumeVisibleHost(pane.id, host);
          }
          const policy = terminalOutputPolicy({
            kind: pane.kind,
            isFocused:
              useLayoutStore.getState().focusedPaneId === pane.id,
            isPaneVisible: paneVisible,
            isDocumentVisible: document.visibilityState !== 'hidden',
            isGridReady: host.gridReady || (!paneVisible && host.hasFittedGrid),
            performanceMode: currentSettings.performanceMode,
          });
          writeTerminalOutput(host.term, data, {
            ...policy,
            onParsed: () => {
              if (!host.disposed) host.inputVisibility.onOutputParsed();
            },
            // F-369: backlog dropado = quadro da TUI com buraco. Visível, o
            // bounce vai no próximo frame, depois do aviso drenar; oculto, a
            // flag espera o resumeVisibleHost do reveal.
            onBackgroundBacklogDropped: () => {
              if (host.disposed || host.virtualized) return;
              if (host.kind !== 'cli-agent') return;
              host.needsTuiRepaint = true;
              if (
                host.isVisible &&
                !host.parked &&
                document.visibilityState !== 'hidden'
              ) {
                requestAnimationFrame(() => {
                  if (host.disposed || !host.opened) return;
                  flushTerminalOutput(host.term);
                  consumeTuiRepaint(host);
                });
              }
            },
          });
        }),
      );
      host.cleanups.push(() => discardTerminalOutput(host.term));
      host.cleanups.push(
        window.nexus.pty.onExit(res.sessionId, ({ exitCode }) => {
          flushTerminalOutput(host.term);
          const failedExactResume =
            resume &&
            res.resumeMode === 'exact' &&
            exitCode !== 0 &&
            Date.now() - spawnedAt < 10_000;
          if (failedExactResume) {
            const message = missionId
              ? 'Falha ao retomar a sessão desta missão. Retome a missão pelo card.'
              : 'Falha ao retomar a sessão. Abra + Pane e selecione o agente para iniciar uma nova conversa.';
            reportPaneResumeIncident(pane, 'stale-exact-id', message, false);
            host.term.writeln(`\r\n\x1b[31m[nexus] ${message}\x1b[0m`);
          }
          setHostSession(host, pane.id, null);
          // Latch solto: sem isto o host fica em exited eterno e o teclado
          // morre em silêncio (onData early-return quando sessionId=null).
          host.spawnStarted = false;
          // Linha própria com \r\n em ambos os lados: o aviso de backlog 2 MB
          // pode cair no meio do buffer e colar "process exited" com "output
          // because the backlog…" (print do operador 2026-08-07 HiperGO).
          useSessionStateStore.getState().setPaneState(pane.id, 'exited');
          // TUI morta com mouse-tracking ligado deixaria o xterm emitindo
          // SGR de mouse como input durante a fase "digite qualquer tecla".
          host.term.write(TERMINAL_INPUT_MODE_RESET);
          const deliberateClose = host.closingSessionId === res.sessionId;
          host.closingSessionId = undefined;
          if (terminalShutdownNoticeMode) {
            // Shutdown: o aviso único do grid já falou; banner por pane é
            // ruído (bug I).
          } else if (deliberateClose) {
            awaitDeliberatePaneClose(host);
          } else if (
            decideOrchestratorProcessExit({
              isOrchestrator: pane.role === 'orchestrator',
              exitCode,
            }) === 'relive-cli-quietly'
          ) {
            // Fim de turno: a CLI sai sozinha. Religa no mesmo xterm, sem
            // mural [nexus]; o quadro/rail avisa. Workers ainda Working
            // recebem interrupt na lane do operador (F-006/F-007).
            reliveOrchestratorCli(pane, host);
            const liveMissionId = missionIdOfPane(pane.id, pane);
            if (liveMissionId) {
              interruptBusyMissionWorkers(liveMissionId, pane.id);
            }
          } else if (
            !shouldPrintMissionPaneExitNotice(exitCode) &&
            (missionStillOwnsPane(pane.id, pane) ||
              missionOfPaneIsDone(pane.id, pane))
          ) {
            // Exit 0 de missão: pane fica como histórico vivo. Sem recado.
          } else if (missionStillOwnsPane(pane.id, pane)) {
            if (pane.role === 'orchestrator') {
              const crashMissionId = missionIdOfPane(pane.id, pane);
              const orch = useOrchStore.getState();
              const summary = crashMissionId
                ? latestCivilianDeliverySummary({
                    missionId: crashMissionId,
                    resultSummary: orch.missions.find(
                      (candidate) => candidate.id === crashMissionId,
                    )?.result?.summary,
                    handoffs: orch.handoffs,
                  })
                : null;
              const lines = orchestratorOwnedExitLines({
                exitCode,
                deliverySummary: summary,
              });
              lines.forEach((line, index) => {
                host.term.writeln(
                  `${index === 0 ? '\r\n' : ''}\x1b[33m${line}\x1b[0m`,
                );
              });
            } else {
              host.term.writeln(
                `\r\n\x1b[33m${missionOwnedExitNotice(exitCode)}\x1b[0m`,
              );
            }
          } else if (missionId && exitCode === 0) {
            void (async () => {
              const terminal = await missionTerminalAuthoritative(missionId);
              if (host.disposed || terminal) return;
              host.term.writeln(
                `\r\n\x1b[90m[nexus] process exited (code ${exitCode})\x1b[0m`,
              );
              host.term.writeln(
                '\x1b[36m[nexus] sessão encerrada. Digite qualquer tecla para abrir um shell neste pane.\x1b[0m',
              );
            })();
          } else {
            host.term.writeln(
              `\r\n\x1b[90m[nexus] process exited (code ${exitCode})\x1b[0m`,
            );
            host.term.writeln(
              '\x1b[36m[nexus] sessão encerrada. Digite qualquer tecla para abrir um shell neste pane.\x1b[0m',
            );
          }
        }),
      );
      if (res.adopted) {
        if (res.state) {
          useSessionStateStore.getState().setPaneState(pane.id, res.state);
        }
        // Listener installation must precede the pull: headless output may
        // already exist and must paint immediately, not wait for the preload
        // recovery backstop.
        void window.nexus.pty.replay(res.sessionId);
        // O replay foi desenhado na grade do spawn headless (120 colunas);
        // reescrito num xterm mais estreito ele vira lixo permanente no
        // scrollback. Depois do replay: zera o terminal e força SIGWINCH
        // duplo — o TUI fullscreen repinta o quadro inteiro na largura real.
        const adoptedSessionId = res.sessionId;
        setTimeout(() => {
          if (host.disposed || host.sessionId !== adoptedSessionId) return;
          try {
            host.term.reset();
            const cols = host.term.cols;
            const rows = host.term.rows;
            window.nexus.pty.resize(adoptedSessionId, cols, Math.max(2, rows - 1));
            window.nexus.pty.resize(adoptedSessionId, cols, rows);
            host.reportedGrid = { cols, rows };
          } catch {
            // Repintura é cosmética; a sessão continua íntegra sem ela.
          }
          // Backstop (viewport preto, voo real 05/08): o reset acima APAGA o
          // frame e confia no SIGWINCH duplo para o TUI repintar. Quando o
          // provider ignora o par de resizes (debounce/tamanho final idêntico),
          // o pane orq fica permanentemente vazio com a sessão viva. Se nada
          // pintou após a janela de graça, reescrevemos a fita LOCAL do que já
          // foi pintado — pedir replay ao main de novo é no-op provado (a
          // janela dele só guarda o não-confirmado, já esgotado no 1º replay).
          setTimeout(() => {
            const tape = adoptionTape;
            adoptionTape = null;
            if (host.disposed || host.sessionId !== adoptedSessionId) return;
            if (!tape) return;
            const outcome = repaintAdoptedFrame({
              hasContent: terminalBufferHasContent(host.term.buffer.active),
              tape: tape.read(),
              write: (data) => host.term.write(data),
            });
            tape.clear();
            if (outcome !== 'already-painted') {
              console.warn(
                `[nexus] adopted pane ${pane.id} vazio pós-reset — repaint ${outcome}`,
              );
            }
          }, 1_200);
        }, 350);
      }

      // After mount: inject either same-account continue or cross-account pack.
      // Cross-account always injects (fresh session). Same-account resume only
      // when the adapter actually restored something. Never type into /login.
      const shouldInjectContinue = shouldInjectResumeContinuation({
        quietSpawn,
        hasContinuityPack: Boolean(pack),
        resume,
        adopted: Boolean(res.adopted),
        resumeMode: res.resumeMode,
        skipContinuation,
      });
      if (shouldInjectContinue) {
        const resumedSessionId = res.sessionId;
        let attempt = 0;
        let cancelled = false;
        const tryInject = () => {
          if (cancelled || host.disposed || host.sessionId !== resumedSessionId) {
            return;
          }
          const decision = nextContinuityInjectionDelay({
            attempt,
            cliReady: cliAcceptsContinuityPrompt(getScrollbackExcerpt(pane.id)),
          });
          if (decision.action === 'abandon') {
            host.term.writeln(
              '\r\n\x1b[33m[nexus] continuidade adiada: a CLI ainda não está pronta ' +
                '(login ou confirmação na tela). Responda o que ela pede e retome; ' +
                'se for login, abra + Pane com outra conta.\x1b[0m',
            );
            return;
          }
          if (decision.action === 'wait') {
            attempt += 1;
            const waitTimer = setTimeout(tryInject, decision.waitMs);
            host.cleanups.push(() => {
              cancelled = true;
              clearTimeout(waitTimer);
            });
            return;
          }
          const role = pane.role === 'orchestrator' ? 'orchestrator' : 'agent';
          const continuation =
            pack ??
            (`Continue the current mission from exactly where you stopped as the ${role}. ` +
              'Preserve existing context and execute the next pending step now.');
          if (
            submitPanePrompt(pane.id, continuation, {
              getSessionId: getPaneSessionId,
              write: (sessionId, data) => window.nexus.pty.write(sessionId, data),
              writeConfirmed: (sessionId, data) =>
                window.nexus.pty.writeConfirmed(sessionId, data),
              schedule: (callback, delayMs) => setTimeout(callback, delayMs),
            })
          ) {
            host.term.writeln(
              pack
                ? '\r\n\x1b[36m[nexus] handoff multi-conta submetido (sessão nova nesta conta).\x1b[0m'
                : '\r\n\x1b[36m[nexus] continuidade submetida automaticamente ao agente.\x1b[0m',
            );
          }
        };
        const continuationTimer = setTimeout(tryInject, 1_800);
        host.cleanups.push(() => {
          cancelled = true;
          clearTimeout(continuationTimer);
        });
      }
      const input = host.term.onData((data) => {
        // xterm does not locally echo: the PTY/TUI sends the visible composer
        // back. Return to live output before the key leaves the renderer.
        host.inputVisibility.onUserInput();
        if (host.opened) webglPool.touch(pane.id);
        flushTerminalOutput(host.term);

        // Terminal ghost assist: accept completion on Right Arrow or Tab, dismiss on Escape
        if (host.ghostAssist) {
          if (data === '\x1b[C' || data === '\t') {
            if (host.ghostAssist.tryAcceptGhost()) {
              return;
            }
          } else if (data === '\x1b[1;3C' || data === '\x1bf') {
            if (host.ghostAssist.tryAcceptGhostWord()) {
              return;
            }
          } else if (data === '\x1b') {
            if (host.ghostAssist.state.visibleTail()) {
              host.ghostAssist.dismiss('escape_key');
              return;
            }
          }
          host.ghostAssist.ingestUserInput(data);
        }

        if (!host.sessionId) {
          if (host.awaitingDeliberateClose) return;
          // Unlock/revive em voo: a tecla seguinte não paga outro IPC nem
          // repete aviso — engolida em silêncio até a ação atual terminar
          // (ou até o teto de 20 s estourar num IPC pendurado — R1).
          if (deadPaneKeyWorkActive(host)) return;
          // Pós-missão (ou pane sem vínculo): estado preso nunca silencia a
          // tecla. Missão viva ou desconhecida segue pela rota antiga, com
          // todas as proteções.
          //
          // Duas guardas da rota antiga valem aqui também, e F-347 é o que
          // acontece quando elas faltam:
          //
          //   1. `missionStillOwnsPane` — done SEM carimbo do humano ainda é
          //      revisão, então o coordenador continua dono do pane (F-108).
          //      `terminalMissionLinkOf` responde 'done' para os dois casos,
          //      aprovado e aguardando revisão, e os dois predicados discordam
          //      exatamente onde importa. Sem esta guarda, uma tecla num pane de
          //      worker de missão concluída-não-aprovada apagava
          //      `paneMissions[pane.id]` de forma irreversível pela UI, antes de
          //      o humano revisar.
          //   2. `paneState !== 'hibernated'` — um pane hibernado tem botão de
          //      acordar ("Use ☀ para acordar") e não é estado preso; virar
          //      shell nu na primeira tecla destrói o snapshot sem necessidade.
          //
          // O que sobra é o caso que esta rota existe para cobrir: missão
          // terminal que já não é dona do pane, com estado que a rota antiga
          // silenciaria. O predicado é puro e testado em
          // mission-owned-pane-policy.test.ts.
          const terminalLink = terminalMissionLinkOf(pane);
          if (
            terminalDeadPaneFastPathApplies({
              link: terminalLink,
              paneState: paneState(pane.id),
              missionOwns: missionStillOwnsPane(pane.id, pane),
            })
          ) {
            const terminalAction = decideTerminalMissionDeadPaneKey({
              spawnStarted: host.spawnStarted,
              keepReviewChannel:
                terminalLink === 'done' && pane.role === 'orchestrator',
            });
            if (terminalAction === 'resume-keyboard') {
              beginDeadPaneKeyWork(host);
              void unlockRetiredMissionPane(pane, host, {
                operatorInitiated: true,
              }).finally(() => endDeadPaneKeyWork(host));
            } else if (terminalAction === 'reclaim-shell') {
              beginDeadPaneKeyWork(host);
              void reclaimExitedPaneAsShell(pane, host, {
                ignoreMissionOwnership: terminalLink !== 'none',
              }).finally(() => endDeadPaneKeyWork(host));
            }
            return;
          }
          const keyAction = decideExitedPaneKey({
            hasSession: false,
            spawnStarted: host.spawnStarted,
            paneState: paneState(pane.id),
            missionOwns: missionStillOwnsPane(pane.id, pane),
            spawnHeld: heldSpawnPanes.has(pane.id),
            doneOrchestrator:
              pane.role === 'orchestrator' &&
              missionOfPaneIsDone(pane.id, pane),
          });
          if (keyAction === 'resume-keyboard') {
            beginDeadPaneKeyWork(host);
            void unlockRetiredMissionPane(pane, host, {
              operatorInitiated: true,
            }).finally(() => endDeadPaneKeyWork(host));
          } else if (keyAction === 'reclaim-shell') {
            beginDeadPaneKeyWork(host);
            void reclaimExitedPaneAsShell(pane, host).finally(() =>
              endDeadPaneKeyWork(host),
            );
          }
          return;
        }
        // Pane governado (missão OU papel de orquestração sem missão) não
        // aceita escrita crua do renderer — a posse é do main. O teclado do
        // operador entra pedindo, não escrevendo: sem esse desvio a tecla era
        // descartada em silêncio e o terminal parecia morto. O vínculo vem do
        // orchStore quando o pane restaurado chega sem ele.
        if (paneInputLane(pane, missionId) === 'operator') {
          sendOperatorInputOrNotify(pane.id, host.sessionId, data);
          return;
        }
        window.nexus.pty.write(host.sessionId, data);
      });
      host.cleanups.push(() => input.dispose());
      return res.sessionId;
    } catch (err) {
      if (host.disposed || host.spawnGeneration !== generation) return null;
      host.spawnStarted = false;
      const message = err instanceof Error ? err.message : String(err);
      recordPaneSpawnError(pane.id, message);
      if (/persisted mission pane authority/i.test(message)) {
        console.warn(
          `[mission-restore] stale pane ${pane.id} threw authority error:`,
          message,
        );
        void unlockRetiredMissionPane(pane, host);
        useSessionStateStore.getState().setPaneState(pane.id, 'exited');
        return null;
      }
      host.term.writeln(
        `\r\n\x1b[31m[nexus] failed to start: ${message}\x1b[0m`,
      );
      useSessionStateStore.getState().setPaneState(pane.id, 'exited');
      return null;
    }
  })();
}

/**
 * Debounced fit-on-resize. An interactive split drag (or a pane re-parenting
 * the terminal) fires the ResizeObserver in a tight burst; calling
 * fit()+pty.resize on each frame floods the child with SIGWINCH and thrashes
 * the renderer (the resize storm Maestri hit). Coalesce to one fit after the
 * last resize.
 *
 * 150ms (era 60ms): a mudança de colunas dispara reflow do scrollback INTEIRO e
 * recalcula a posição da viewport — com muitos panes e scrollback grande isso é
 * o custo dominante, não o desenho. O Orca mede o mesmo caminho e documenta um
 * reflow de 10k linhas travando o renderer por 500ms-2s no Windows; eles também
 * usam 150ms. A 60ms cada pane grande refazia esse trabalho ~2,5x mais vezes por
 * rajada. O atraso continua imperceptível para arrastar splitter.
 */
const RESIZE_DEBOUNCE_MS = 150;
/** waitForSession: dá tempo do PaneLeaf attachar e medir o slot. */
const HEADLESS_SPAWN_FALLBACK_MS = 200;

/**
 * O ÚNICO jeito de medir a grade de um host.
 *
 * `fit.fit()` sozinho deixa a grade encolher até 2 colunas (o próprio FitAddon
 * clampa em `Math.max(2, …)`), e num pane estreito isso faz a linha de status
 * de qualquer TUI quebrar — e o `\r` seguinte passar a descer de linha, subindo
 * lixo permanente. Ver `clampGridToUsableCols` para a medição completa.
 *
 * POR ISSO usamos `proposeDimensions()` em vez de `fit.fit()`: `fit()` já
 * aplica um `term.resize()` físico na largura estreita medida, e um segundo
 * `resize()` para o piso clampado reflowaria o buffer DUAS vezes na mesma
 * passada (F-356). Uma TUI de cursor absoluto (Codex) não sobrevive a esse
 * reflow intermediário — colunas altas do frame já pintado são cortadas no
 * ciclo largo→estreito e o reflow de volta não as traz de volta, mesmo a
 * grade final acabando idêntica à original. `proposeDimensions()` só mede;
 * o clamp decide o alvo FINAL antes do único `resize()` físico.
 *
 * Envolver o fit num só lugar garante que nenhum dos caminhos de resize (observer
 * por host, refit global, reveal, spawn) escape da regra.
 */
function fitHostGrid(host: Host): boolean {
  host.gridReady = false;
  if (host.element.clientWidth <= 0 || host.element.clientHeight <= 0) return false;
  try {
    const proposed = host.fit.proposeDimensions();
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows) ||
        proposed.cols <= 0 || proposed.rows <= 0) return false;
    const grid = clampGridToUsableCols({
      cols: proposed.cols,
      rows: proposed.rows,
      hasSession: host.sessionId != null,
    });
    if (grid.cols !== host.term.cols || grid.rows !== host.term.rows) {
      host.term.resize(grid.cols, grid.rows);
    }
    host.gridReady = true;
    host.hasFittedGrid = true;
  } catch {
    // Hidden slot, unloaded font or a disposed terminal: retry after layout.
    return false;
  }
  return true;
}

function settleHostGrid(host: Host): boolean {
  if (
    !hostSlotIsMeasurable({
      clientWidth: host.element.clientWidth,
      clientHeight: host.element.clientHeight,
    })
  ) {
    return false;
  }
  try {
    if (!fitHostGrid(host)) return false;
  } catch {
    return false;
  }
  return hostGridIsUsable({ cols: host.term.cols, rows: host.term.rows });
}

const DEFERRED_SPAWN_RETRY_MIN_MS = 250;
const DEFERRED_SPAWN_RETRY_MAX_MS = 2_000;
/**
 * Orçamento total do spawn adiado. Com o backoff saturando em 2s, 60s dá ~30
 * tentativas — folga de sobra para um slot que só demora a ser medido (aba
 * abrindo, fonte carregando) e curto o bastante para o operador não ficar
 * olhando um pane vazio sem explicação.
 */
const DEFERRED_SPAWN_BUDGET_MS = 60_000;

function clearDeferredSpawnRetry(host: Host): void {
  if (host.deferredSpawnRetry === undefined) return;
  clearTimeout(host.deferredSpawnRetry);
  host.deferredSpawnRetry = undefined;
}

/**
 * Desistência ALTA: o pane mostra o motivo em vez de ficar vazio para sempre.
 * Espelha o caminho de falha de spawn, que já escreve "[nexus] failed to start".
 */
function abandonDeferredSpawn(host: Host): void {
  clearDeferredSpawnRetry(host);
  host.spawnWhenMeasurable = false;
  host.deferredSpawnBudgetUntil = undefined;
  console.warn(
    `[terminal] spawn adiado abandonado após ${DEFERRED_SPAWN_BUDGET_MS / 1000}s sem slot mensurável`,
  );
  try {
    host.term.writeln(
      '\r\n\x1b[33m[nexus] o pane não pôde ser medido para iniciar o terminal.\x1b[0m',
    );
  } catch {
    // Terminal já descartado — o console.warn acima ainda registra o caso.
  }
}

/**
 * Enquanto o spawn estiver adiado, tenta de novo num relógio próprio com
 * backoff (250ms → 2s). Barato — um timer por host adiado — e transforma
 * "nunca nasce" em "nasce assim que o slot for mensurável".
 *
 * Com teto: passado {@link DEFERRED_SPAWN_BUDGET_MS} sem sucesso, para e avisa.
 */
function armDeferredSpawnRetry(host: Host, delayMs: number): void {
  clearDeferredSpawnRetry(host);
  host.deferredSpawnRetry = setTimeout(() => {
    host.deferredSpawnRetry = undefined;
    if (host.disposed || host.spawnStarted || host.hibernated) return;
    if (!host.spawnWhenMeasurable) return;
    if (Date.now() >= (host.deferredSpawnBudgetUntil ?? 0)) {
      abandonDeferredSpawn(host);
      return;
    }
    tryDeferredSpawn(host);
    if (host.spawnWhenMeasurable && !host.spawnStarted) {
      armDeferredSpawnRetry(
        host,
        Math.min(delayMs * 2, DEFERRED_SPAWN_RETRY_MAX_MS),
      );
    }
  }, delayMs);
}

function beginPaneSpawn(pane: PaneModel, host: Host): void {
  if (host.spawnStarted || host.hibernated || host.disposed) return;
  // F-213: a primeira tentativa marca o nascimento do ciclo — a espera de
  // grade mensurável e a pausa held entram no rendererWaitMs do pedido.
  host.spawnCycleStartMs ??= Date.now();
  if (heldSpawnPanes.has(pane.id)) return;
  if (!settleHostGrid(host)) {
    host.spawnWhenMeasurable = true;
    if (host.deferredSpawnRetry === undefined) {
      // Orçamento novo a cada ciclo de adiamento: um reveal posterior pode
      // re-armar legitimamente, e aí a contagem velha não pode condená-lo.
      host.deferredSpawnBudgetUntil = Date.now() + DEFERRED_SPAWN_BUDGET_MS;
      armDeferredSpawnRetry(host, DEFERRED_SPAWN_RETRY_MIN_MS);
    }
    return;
  }
  host.spawnWhenMeasurable = false;
  host.deferredSpawnBudgetUntil = undefined;
  clearDeferredSpawnRetry(host);
  const firstIntent = consumeFirstSpawnIntent(pane.id);
  void startSpawn(
    pane,
    host,
    firstIntent.resume,
    false,
    undefined,
    firstIntent.restorePersistedAuthority,
  );
}

function bouncePtyGrid(host: Host): void {
  if (!host.sessionId) return;
  const cols = host.term.cols;
  const rows = host.term.rows;
  if (cols < 2 || rows < 1) return;
  window.nexus.pty.resize(host.sessionId, cols, Math.max(2, rows - 1));
  window.nexus.pty.resize(host.sessionId, cols, rows);
  host.reportedGrid = { cols, rows };
}

/**
 * F-216: "Redesenhar tela" do toolbar — refaz o fit, reasserta o winsize
 * (o trace pty-grid-drift do Main registra se havia divergência), bounceia
 * a grade para a TUI fullscreen repintar e refresca as linhas visíveis.
 * No-op sem sessão viva, com o pane descartado ou estacionado.
 */
export function repaintPaneTui(paneId: string): void {
  const host = hosts.get(paneId);
  if (
    !host ||
    host.disposed ||
    host.parked ||
    host.virtualized ||
    !host.sessionId
  ) {
    return;
  }
  try {
    fitHostGrid(host);
  } catch {
    // Não mensurável agora — asserção/bounce abaixo usam a grade atual.
  }
  propagateHostSize(host, { assert: true });
  bouncePtyGrid(host);
  try {
    host.term.refresh(0, Math.max(0, host.term.rows - 1));
  } catch {
    // Terminal ainda não aberto ou descartado no meio do caminho.
  }
}

/**
 * F-369: consome `needsTuiRepaint` quando o host tem condições reais de
 * redesenho — agente CLI com sessão viva, pane na tela e grade medida.
 * Sem isso a flag fica para o resume seguinte (rehydrate sem fit ainda
 * não sabe a geometria); com elas o bounce é one-shot e a flag limpa.
 */
function consumeTuiRepaint(host: Host): void {
  if (!host.needsTuiRepaint) return;
  if (
    host.disposed ||
    host.virtualized ||
    host.kind !== 'cli-agent' ||
    !host.sessionId ||
    !host.opened ||
    host.parked ||
    !host.isVisible ||
    !host.gridReady
  ) {
    return;
  }
  host.needsTuiRepaint = false;
  bouncePtyGrid(host);
}

function tryDeferredSpawn(host: Host): void {
  if (
    !host.spawnWhenMeasurable ||
    host.spawnStarted ||
    host.hibernated ||
    host.disposed
  ) {
    return;
  }
  const pane = listPanes(useLayoutStore.getState().root).find(
    (candidate) => candidate.id === host.paneId,
  );
  if (!pane) return;
  beginPaneSpawn(pane, host);
}

function makeResizeObserver(paneId: string, host: Host): ResizeObserver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new ResizeObserver(() => {
    if (host.disposed || !host.opened) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (host.disposed || !host.opened) return;
      if (useLayoutStore.getState().focusedPaneId === paneId) {
        resumeVisibleHost(paneId, host);
        tryDeferredSpawn(host);
        return;
      }
      try {
        if (!fitHostGrid(host)) {
          tryDeferredSpawn(host);
          return;
        }
      } catch {
        tryDeferredSpawn(host);
        return;
      }
      // Primeira medição real do slot: é aqui que o replay pendente entra, já
      // na largura certa.
      flushPendingScrollback(host);
      propagateHostSize(host);
      if (host.isVisible && document.visibilityState !== 'hidden') resumeTerminalOutput(host.term);
      // F-369: pane reidratado visível mas SEM foco também merece o bounce —
      // não pode depender de resumeVisibleHost (que só roda no foco).
      consumeTuiRepaint(host);
      tryDeferredSpawn(host);
    }, RESIZE_DEBOUNCE_MS);
  });
}

/**
 * Re-measure every live terminal. Repaint é POR MOTIVO (shouldRepaintOnRefit):
 * resize de janela só repinta pane cuja grade realmente mudou; mudança de
 * escala repinta todos. Antes o refresh era incondicional — N panes parados
 * viravam N repaints de pixels idênticos a cada resize (forma do bug de GPU
 * do Overclock: 1 pane 5%, 24 panes 84%).
 */
function refitAllHosts(reason: RefitReason): void {
  for (const host of hosts.values()) {
    if (host.disposed || !host.opened || host.virtualized) continue;
    const before = { cols: host.term.cols, rows: host.term.rows };
    try {
      if (!fitHostGrid(host)) continue;
    } catch {
      continue; // Not measurable right now; the ResizeObserver will settle it.
    }
    const gridChanged =
      host.term.cols !== before.cols || host.term.rows !== before.rows;
    if (gridChanged) flushPendingScrollback(host);
    propagateHostSize(host);
    if (host.isVisible && document.visibilityState !== 'hidden') resumeTerminalOutput(host.term);
    // F-369: consume o repaint pendente de TODOS os hosts refeitos — inclusive
    // o reidratado visível sem foco, que nunca passa por resumeVisibleHost.
    consumeTuiRepaint(host);
    tryDeferredSpawn(host);
    if (!shouldRepaintOnRefit({ reason, gridChanged })) continue;
    try {
      host.term.refresh(0, Math.max(0, host.term.rows - 1));
    } catch {
      // The next PTY write repaints.
    }
  }
}

let refitAllTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRefitReason: RefitReason | null = null;

/**
 * Fit SÍNCRONO para rodar dentro de um `useLayoutEffect`.
 *
 * O React já comitou o DOM mas o browser ainda NÃO pintou — o container já tem
 * a largura nova, então o fit mede certo. Pelo caminho debounced o terminal
 * ficaria com as colunas ANTIGAS por todo o debounce (150ms), o que aparece
 * como um flash de grade errada quando a sidebar/rail abre e os panes esticam.
 *
 * Cancela o refit agendado: quando este roda, aquele vira trabalho repetido
 * (Orca descreve o mesmo par — bypass pré-paint + debounce que vira no-op).
 */
export function refitAllPanesBeforePaint(): void {
  // NÃO descartar um motivo pendente mais caro: `display-scale` exige repaint de
  // TODOS os panes (o glifo mudou sem a grade mudar — shouldRepaintOnRefit). Se
  // um refit desses estava agendado e um layout-change chega antes, rodar só
  // 'layout-change' e zerar o pendente deixaria os terminais desenhados no DPR
  // antigo. Escalar preserva o motivo mais forte.
  const pending = pendingRefitReason;
  if (refitAllTimer) {
    clearTimeout(refitAllTimer);
    refitAllTimer = null;
  }
  pendingRefitReason = null;
  refitAllHosts(
    pending ? escalateRefitReason(pending, 'layout-change') : 'layout-change',
  );
}

function scheduleRefitAll(reason: RefitReason): void {
  pendingRefitReason = escalateRefitReason(pendingRefitReason, reason);
  if (refitAllTimer) clearTimeout(refitAllTimer);
  refitAllTimer = setTimeout(() => {
    refitAllTimer = null;
    const effective = pendingRefitReason ?? reason;
    pendingRefitReason = null;
    refitAllHosts(effective);
  }, RESIZE_DEBOUNCE_MS);
}

/**
 * Zoom (Cmd +/-) e trocas de escala/monitor mudam o devicePixelRatio SEM
 * necessariamente alterar o box dos panes — o ResizeObserver por host nunca
 * dispara e a grade cols/rows fica congelada no tamanho antigo. Observa o
 * próprio DPR (a media query casa UM ratio específico, então precisa ser
 * recriada após cada mudança) mais um resize de janela como backstop.
 */
function watchDisplayScale(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('resize', () => scheduleRefitAll('window-resize'));
  if (typeof window.matchMedia !== 'function') return;
  let media: MediaQueryList | null = null;
  const onChange = (): void => {
    scheduleRefitAll('display-scale');
    rebind();
  };
  const rebind = (): void => {
    media?.removeEventListener('change', onChange);
    media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    media.addEventListener('change', onChange);
  };
  rebind();
}
watchDisplayScale();

useLayoutStore.subscribe((next, prev) => {
  if (
    next.root !== prev.root ||
    next.maximizedPaneId !== prev.maximizedPaneId
  ) {
    scheduleRefitAll('layout-change');
  }
});

/**
 * Abaixo deste número de hosts vivos NADA é hibernado: o custo por pane é
 * pequeno (medido 09/09: ~10-15MB/pane RSS, heap 53MB com 32 panes) e o
 * risco não se paga. Acima, panes OCULTOS trocam o xterm por snapshot.
 */
export const HIBERNATE_MIN_LIVE_HOSTS = 24;

/** Saída PTY retida enquanto o pane hiberna (chars; ~64KB por pane). */
export const HIBERNATE_PENDING_OUTPUT_CHARS = 64_000;

export interface HibernationDecision {
  readonly liveHosts: number;
  readonly isPaneVisible: boolean;
  readonly isParked: boolean;
  readonly opened: boolean;
  readonly disposed: boolean;
  readonly hasSession: boolean;
  readonly spawnPending: boolean;
}

/** Pura — unit-testada. Hiberna só grid grande, pane oculto e já spawned. */
export function shouldHibernateHost(input: HibernationDecision): boolean {
  return (
    input.liveHosts >= HIBERNATE_MIN_LIVE_HOSTS &&
    !input.isPaneVisible &&
    !input.isParked &&
    input.opened &&
    !input.disposed &&
    input.hasSession &&
    !input.spawnPending
  );
}

function liveHostCount(): number {
  let live = 0;
  for (const host of hosts.values()) {
    if (!host.disposed) live += 1;
  }
  return live;
}

/**
 * Descarta o xterm de um pane oculto e guarda snapshot + buffer de saída.
 * O PTY (main) segue vivo; o host.term vira um xterm NOVO e não-aberto, então
 * todo guard existente (`!host.opened`, pendingScrollback, replay por fit)
 * passa a valer na reidratação — a mesma trilha do restore de layout.
 */
function virtualizeHost(host: Host): void {
  if (host.disposed || host.virtualized) return;
  if (host.ghostAssist) {
    try {
      host.ghostAssist.dispose();
    } catch {}
    host.ghostAssist = undefined;
  }
  let snapshot = '';
  let cols = host.term.cols;
  try {
    snapshot = host.serialize.serialize().slice(-MAX_PERSISTED_SCROLLBACK);
    cols = host.term.cols;
    host.term.dispose();
  } catch {
    return; // terminal em estado ímpar — não hibernar é seguro
  }
  webglPool.suspend(host.paneId);
  const built = buildTerminal(host.kind);
  host.term = built.term;
  host.fit = built.fit;
  host.search = built.search;
  host.serialize = built.serialize;
  host.inputVisibility = new TerminalInputVisibilityController({
    term: host.term,
    classList: host.element.classList,
  });
  host.opened = false;
  host.reportedGrid = null;
  host.hasFittedGrid = false;
  host.virtualized = { cols, snapshot, pendingOutput: '' };
}

/** Reidrata um pane hibernado que voltou à tela. */
function rehydrateHost(host: Host): void {
  const state = host.virtualized;
  if (!state || host.disposed) return;
  host.virtualized = null;
  host.pendingScrollback = state.snapshot;
  host.pendingScrollbackCols = state.cols;
  host.hasVisibleContent = true;
  try {
    host.term.open(host.element);
  } catch {
    return;
  }
  host.opened = true;
  registerWebglLease(host.paneId, host);
  wireHostTerminalListeners(host);
  if (host.kind === 'shell') {
    setupGhostAssist(host);
  } else if (host.kind === 'cli-agent') {
    // F-369: snapshot + fita truncada + replay não reconstroem molduras de
    // TUI — o bounce de grade sai no primeiro resume com a grade medida.
    host.needsTuiRepaint = true;
  }
  // Flush do snapshot acontece no primeiro fit (largura definitiva); o output
  // retido entra depois dele, e o ring do main cobre o que estourar o buffer.
  requestAnimationFrame(() => {
    if (host.disposed || !host.opened) return;
    flushPendingScrollback(host);
    if (state.pendingOutput.length > 0) {
      writeTerminalOutput(host.term, state.pendingOutput, {
        foreground: true,
        latencySensitive: true,
      });
    }
    if (host.sessionId) void window.nexus.pty.replay(host.sessionId).catch(() => {});
  });
}

// F-568: um CLI (Codex/Claude/Grok) reescreve o título OSC a cada frame do
// próprio spinner, dezenas de vezes por segundo. Sem isto, cada frame
// reflui o toolbar (chip de título muda de largura) — normaliza o glifo de
// status para fora do texto, propaga só quando o título limpo MUDA, e
// coalesce rajadas num único write por TITLE_THROTTLE_MS (trailing).
const TITLE_THROTTLE_MS = 250;

interface PaneTitleThrottleState {
  lastApplied: string | null;
  pendingTitle: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const titleThrottleState = new WeakMap<Host, PaneTitleThrottleState>();

function applyIncomingPaneTitle(host: Host, rawTitle: string): void {
  const { title } = normalizePaneTitle(rawTitle);
  if (!title) return;
  const pane = listPanes(useLayoutStore.getState().root).find(
    (candidate) => candidate.id === host.paneId,
  );
  const display =
    pane?.kind === 'cli-agent'
      ? cliPaneDisplayTitle(pane.adapterId, title)
      : title;
  if (!display) return;

  let state = titleThrottleState.get(host);
  if (!state) {
    state = { lastApplied: null, pendingTitle: null, timer: null };
    titleThrottleState.set(host, state);
    host.cleanups.push(() => {
      if (state!.timer !== null) clearTimeout(state!.timer);
    });
  }
  if (display === state.lastApplied) return;

  state.pendingTitle = display;
  if (state.timer !== null) return;
  state.timer = setTimeout(() => {
    state!.timer = null;
    const next = state!.pendingTitle;
    state!.pendingTitle = null;
    if (next && next !== state!.lastApplied) {
      state!.lastApplied = next;
      useLayoutStore.getState().setTitle(host.paneId, next);
    }
  }, TITLE_THROTTLE_MS);
}

function wireHostTerminalListeners(host: Host): void {
  host.term.onTitleChange((title) => applyIncomingPaneTitle(host, title));
  host.term.onScroll((viewportY) => {
    host.inputVisibility.onScroll(viewportY, host.term.buffer.active.baseY);
  });
}

function createShellHost(pane: PaneModel): Host {
  const element = document.createElement('div');
  element.className = 'term-host';

  const { term, fit, search, serialize } = buildTerminal('shell');
  const inputVisibility = new TerminalInputVisibilityController({
    term,
    classList: element.classList,
  });

  const host: Host = {
    element,
    paneId: pane.id,
    term,
    fit,
    search,
    serialize,
    ro: null as unknown as ResizeObserver,
    sessionId: null,
    // createHostForKind só rota shell/cli-agent; browser nunca cria host.
    kind: pane.kind as 'shell' | 'cli-agent',
    virtualized: null,
    reportedGrid: null,
    isVisible: true,
    gridReady: false,
    hasFittedGrid: false,
    spawnGeneration: 0,
    opened: false,
    spawnStarted: false,
    hibernated: false,
    parked: false,
    disposed: false,
    inputVisibility,
    cleanups: [],
  };

  host.ro = makeResizeObserver(pane.id, host);
  host.ro.observe(element);

  term.onTitleChange((title) => applyIncomingPaneTitle(host, title));
  term.onScroll((viewportY) => {
    host.inputVisibility.onScroll(viewportY, host.term.buffer.active.baseY);
  });
  element.addEventListener('mousedown', () => {
    // Clicking INTO the terminal is the operator taking it: a structural
    // placeholder stops being a vacancy here, so the layout invariant can
    // never reclaim a shell someone is actually working in.
    useLayoutStore.getState().claimStructuralPlaceholder(pane.id);
    useLayoutStore.getState().focus(pane.id);
    // Clicking an already-focused pane produces no store transition. Touch
    // the renderer explicitly so a recovered context cannot remain stale.
    focusHost(pane.id);
  });
  wireInteractions(host);
  return host;
}

/** Build a cli-agent host. The backing terminal is the same as a shell host but
 *  the spawn request routes through the adapter registry in the main process. */
function createCliAgentHost(pane: PaneModel): Host {
  const element = document.createElement('div');
  element.className = 'term-host term-host--agent';

  const { term, fit, search, serialize } = buildTerminal('cli-agent');
  const inputVisibility = new TerminalInputVisibilityController({
    term,
    classList: element.classList,
  });

  const host: Host = {
    element,
    paneId: pane.id,
    term,
    fit,
    search,
    serialize,
    ro: null as unknown as ResizeObserver,
    sessionId: null,
    // createHostForKind só rota shell/cli-agent; browser nunca cria host.
    kind: pane.kind as 'shell' | 'cli-agent',
    virtualized: null,
    reportedGrid: null,
    isVisible: true,
    gridReady: false,
    hasFittedGrid: false,
    spawnGeneration: 0,
    opened: false,
    spawnStarted: false,
    hibernated: false,
    parked: false,
    disposed: false,
    inputVisibility,
    cleanups: [],
  };

  host.ro = makeResizeObserver(pane.id, host);
  host.ro.observe(element);

  term.onTitleChange((title) => applyIncomingPaneTitle(host, title));
  term.onScroll((viewportY) => {
    host.inputVisibility.onScroll(viewportY, host.term.buffer.active.baseY);
  });
  element.addEventListener('mousedown', () => {
    useLayoutStore.getState().focus(pane.id);
    focusHost(pane.id);
  });
  wireInteractions(host, true);

  useSessionStateStore.getState().setPaneState(pane.id, 'spawning');
  return host;
}

/** Shell-quote a path only if it contains characters that need it. */
function shellQuote(p: string): string {
  return /[\s'"\\$`(){}[\]!*?&;|<>]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p;
}

function hostBaseDir(host: Host): string | null {
  const paneCwd = listPanes(useLayoutStore.getState().root).find(
    (p) => p.id === host.paneId,
  )?.cwd;
  return paneCwd || getActiveWorkspacePath();
}

/** Escreve no PTY o caminho já estagiado/relativo, como um path digitado. */
function injectStagedPath(host: Host, stagedPath: string): void {
  if (!host.sessionId) return;
  const fullPath = toAbsoluteContextPath(hostBaseDir(host), stagedPath);
  window.nexus.pty.write(host.sessionId, `${shellQuote(fullPath)} `);
}

/**
 * Copy a pasted/dropped blob into the workspace mission-context dir, inject
 * its path. Path-first (F-582): um File com caminho real FORA do projeto não
 * passa pelo cap de 14 MB do renderer — o main faz o stream do `file://`
 * (256 MiB). Sem caminho (blob do clipboard) cai na rota base64 de sempre.
 */
async function injectDroppedFile(host: Host, file: File): Promise<void> {
  try {
    const baseDir = hostBaseDir(host);
    const absolutePath = window.nexus.files.pathForFile(file);
    if (absolutePath) {
      const relative = baseDir
        ? droppedProjectContextPath(baseDir, file)
        : null;
      if (relative) {
        injectStagedPath(host, relative);
        return;
      }
      const result = await window.nexus.files.importDroppedUri(
        fileUrlForPath(absolutePath),
      );
      if (result.ok && result.path) {
        if (!host.sessionId) {
          // Cópia ok; sessão morta — não reusar a recusa de intake.
          useToastStore.getState().push(
            'warn',
            'Pane sem sessão ativa',
            `"${file.name || 'anexo'}" foi copiado, mas este pane não tem processo ativo para recebê-lo. Reabra o agente e cole de novo.`,
          );
          return;
        }
        injectStagedPath(host, result.path);
        return;
      }
      useToastStore.getState().push(
        'warn',
        'Arquivo não colado no terminal',
        result.error ?? `"${file.name || 'anexo'}" não pôde ser copiado para a missão.`,
      );
      return;
    }
    const resolved = await resolveDroppedMissionContextPath(
      baseDir,
      file,
    );
    if (resolved.ok) {
      if (!host.sessionId) {
        // Cópia ok; sessão morta — não reusar a recusa de intake.
        useToastStore.getState().push(
          'warn',
          'Pane sem sessão ativa',
          `"${file.name || 'anexo'}" foi copiado, mas este pane não tem processo ativo para recebê-lo. Reabra o agente e cole de novo.`,
        );
        return;
      }
      injectStagedPath(host, resolved.path);
      return;
    }
    // "Não cola e não mostra" (screenshot 2026-08-18): arquivo que o intake
    // recusa morria em silêncio — o operador colava e NADA acontecia. Um
    // aviso toast diz o quê e o porquê sem escrever lixo no pane do agente.
    // Desde 19/08 o pane aceita QUALQUER tipo; só tamanho/falha física recusa.
    // F-582: o motivo real sai no toast e no console (nunca conteúdo).
    const reason = resolved.error;
    console.warn(
      '[terminal] intake recusou',
      { name: file.name, size: file.size },
      reason,
    );
    useToastStore.getState().push(
      'warn',
      'Arquivo não colado no terminal',
      reason,
    );
  } catch {
    // Ignore — a failed drop should never break the terminal.
  }
}

/**
 * F-582: o pasteboard do sistema guarda arquivos copiados no Finder/Explorer
 * como referências (`public.file-url`/`FileNameW`) que o Chromium não expõe
 * ao evento. O Main lê só os endereços; cada `file://` segue a rota de
 * `importDroppedUri` (stream local, 256 MiB). Sem endereço nenhum, o toast
 * explica o que chegou — como o drop já fazia.
 */
async function pasteFromSystemClipboard(
  host: Host,
  transfer: DataTransfer | null,
): Promise<void> {
  // DataTransfer morre com o evento — fotografa tipos e dados ANTES do await.
  const types = Array.from(transfer?.types ?? []);
  const data: Record<string, string> = {};
  for (const type of types) {
    try {
      data[type] = transfer?.getData(type) ?? '';
    } catch {
      data[type] = '';
    }
  }
  const snapshot: DroppedPayload = {
    types,
    getData: (type: string) => data[type] ?? '',
    files: transfer?.files,
  };
  try {
    const { uris } = await window.nexus.files.clipboardFileUris();
    if (uris.length > 0) {
      for (const uri of uris) {
        void injectDroppedUri(host, { kind: 'file', uri });
      }
      return;
    }
    useToastStore.getState().push(
      'warn',
      'Nada foi colado no terminal',
      describePasteWithoutFiles(snapshot),
    );
  } catch {
    // O paste já foi interceptado: ficar mudo repetiria o F-582 — avisa que a
    // consulta ao pasteboard do sistema falhou (sem detalhes internos).
    console.warn('[terminal] pasteboard lookup failed');
    useToastStore.getState().push(
      'warn',
      'Nada foi colado no terminal',
      'Não foi possível consultar a área de transferência do sistema. Salve a mídia no disco e copie/arraste do Finder.',
    );
  }
}

/**
 * Drop que chegou sem `File`, só com o endereço (WhatsApp, Fotos, um link do
 * navegador): o main lê o `file://` ou baixa o http(s) e devolve o caminho
 * estagiado em mission-context, que entra no pane como um drop do Finder.
 * Uma recusa vira toast com o motivo do main; nada é escrito no pane.
 */
async function injectDroppedUri(host: Host, dropped: DroppedUri): Promise<void> {
  try {
    if (dropped.kind === 'url') {
      useToastStore.getState().push('info', 'Baixando link para a missão…', {
        detail: dropped.uri,
        dedupeKey: 'terminal-drop-download',
      });
    }
    const result = await window.nexus.files.importDroppedUri(dropped.uri);
    if (result.ok && result.path) {
      if (!host.sessionId) {
        // Cópia ok; sessão morta — não reusar a recusa de intake.
        useToastStore.getState().push(
          'warn',
          'Pane sem sessão ativa',
          dropped.kind === 'url'
            ? 'O link foi baixado, mas este pane não tem processo ativo para recebê-lo. Reabra o agente e cole de novo.'
            : 'O arquivo foi copiado, mas este pane não tem processo ativo para recebê-lo. Reabra o agente e cole de novo.',
        );
        return;
      }
      injectStagedPath(host, result.path);
      return;
    }
    useToastStore.getState().push(
      'warn',
      dropped.kind === 'url' ? 'Link não baixado' : 'Arquivo não colado no terminal',
      result.error ?? droppedUriRejectionMessage(dropped),
    );
  } catch {
    // Ignore — a failed drop should never break the terminal.
  }
}

/**
 * Make a terminal fully operable: copy the selection (⌘/Ctrl+C when text is
 * selected), paste text (native xterm) or an image (saved to disk, path
 * injected), and accept drag-and-dropped files (real path injected as if
 * typed). Nothing here can break the terminal — every branch is guarded.
 */
function wireInteractions(host: Host, sendJumpKeyOnScroll = false): void {
  const { element, term } = host;

  // 0.76.45: digitar num pane estacionado acorda — mesmo gesto do botão
  // "Acordar". Listener persistente e independente do onData por-spawn (que
  // markPaneParked descarta): só dispara enquanto o pane está em
  // usePaneParkedStore, então nunca compete com a digitação normal.
  term.onData(() => {
    if (!usePaneParkedStore.getState().parked.has(host.paneId)) return;
    const pane = listPanes(useLayoutStore.getState().root).find(
      (candidate) => candidate.id === host.paneId,
    );
    if (pane) wakeHost(pane);
  });

  // TUI (alternate screen, Grok/Claude/Codex): wheel → PageUp/PageDown no PTY.
  // Shell/log (normal buffer): xterm continua rolando o viewport.
  element.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      const page = tuiWheelPageSequence({
        bufferType: term.buffer.active.type,
        deltaY: event.deltaY,
      });
      if (page && host.sessionId) {
        event.preventDefault();
        event.stopPropagation();
        window.nexus.pty.write(host.sessionId, page);
        return;
      }
      requestAnimationFrame(() => {
        if (host.disposed) return;
        host.inputVisibility.onScroll(
          term.buffer.active.viewportY,
          term.buffer.active.baseY,
        );
      });
    },
    { passive: false },
  );

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'c' && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      return false; // handled — don't send ^C to the pty
    }
    // ⌘+End / ⌘+↓ — "descer até a última mensagem" (macOS não tem tecla End
    // física; o ctrl+End que o TUI do Claude anuncia fica inalcançável).
    if (e.metaKey && (e.key === 'End' || e.key === 'ArrowDown')) {
      term.scrollToBottom();
      if (sendJumpKeyOnScroll && host.sessionId) {
        window.nexus.pty.write(host.sessionId, '\x1b[1;5F');
      }
      return false;
    }
    return true;
  });

  // F-582: o paste espelha o drop — qualquer tipo de arquivo, depois
  // text/uri-list/DownloadURL, imagem embutida no HTML e por fim o pasteboard
  // do sistema via Main. text/plain NUNCA é interceptado: uma URL ou caminho
  // colado como texto continua sendo digitado no terminal.
  element.addEventListener(
    'paste',
    (e: ClipboardEvent) => {
      const transfer = e.clipboardData;
      const files = filesFromClipboardData(transfer, { anyKind: true });
      if (files.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        for (const file of files) void injectDroppedFile(host, file);
        return;
      }
      const uris = pasteUrisFromClipboard(transfer);
      if (uris.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        for (const dropped of uris) void injectDroppedUri(host, dropped);
        return;
      }
      // F-526: WhatsApp e apps Electron colam a imagem só como HTML com
      // data:URI (sem item file). Materializa e segue a mesma rota.
      const embedded = embeddedImageFromHtml(
        transfer?.getData('text/html'),
      );
      const embeddedFile = embedded ? fileFromEmbeddedImage(embedded) : null;
      if (embeddedFile) {
        e.preventDefault();
        e.stopPropagation();
        void injectDroppedFile(host, embeddedFile);
        return;
      }
      if (!clipboardAnnouncesPayload(transfer?.types ?? [])) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      void pasteFromSystemClipboard(host, transfer);
    },
    true,
  );

  element.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  element.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) {
      for (const file of files) void injectDroppedFile(host, file);
      return;
    }
    // Apps nativos entregam mídia como PROMESSA de arquivo, e quando o
    // Chromium não a materializa `files` vem vazia — mas o `text/uri-list`
    // costuma vir: o main ainda consegue ler o `file://` ou baixar o link.
    const { accepted } = resolveDropUris(e.dataTransfer);
    if (accepted.length > 0) {
      for (const dropped of accepted) void injectDroppedUri(host, dropped);
      return;
    }
    // F-526: WhatsApp e apps Electron sem promessa materializada entregam o
    // HTML com a imagem embutida (data:URI). Extrai e injeta como file.
    const embedded = embeddedImageFromHtml(e.dataTransfer?.getData('text/html'));
    const embeddedFile = embedded ? fileFromEmbeddedImage(embedded) : null;
    if (embeddedFile) {
      void injectDroppedFile(host, embeddedFile);
      return;
    }
    // Silêncio aqui tornava "não suportado" indistinguível de "quebrado".
    // Diga o que chegou.
    useToastStore.getState().push(
      'warn',
      'Nada foi solto no terminal',
      describeDropWithoutFiles(e.dataTransfer),
    );
  });
}

/**
 * Build the backing host for a pane, dispatched on its session kind.
 */
function createHostForKind(pane: PaneModel): Host {
  switch (pane.kind) {
    case 'cli-agent':
      return createCliAgentHost(pane);
    case 'shell':
    default:
      return createShellHost(pane);
  }
}

export function getOrCreateHost(pane: PaneModel): Host {
  const existing = hosts.get(pane.id);
  if (existing) return existing;
  const host = createHostForKind(pane);
  hosts.set(pane.id, host);
  return host;
}

/**
 * Move a pane's terminal into `slot`, opening + spawning on first attach.
 * Idempotent: re-parenting the same node is a no-op move for xterm.
 */
export function attachHost(pane: PaneModel, slot: HTMLElement): void {
  const host = getOrCreateHost(pane);
  slot.appendChild(host.element);
  if (host.parked) {
    // De volta do estacionamento: mesmo xterm, mesma sessão. O lease de WebGL
    // foi devolvido ao estacionar; o bounce de grade logo abaixo cobre a
    // largura que mudou enquanto o pane estava fora da tela.
    unparkHost(pane.id, host);
    if (host.opened) registerWebglLease(pane.id, host);
  }

  if (!host.opened) {
    host.term.open(host.element);
    // NUNCA reescrever o scrollback antes da largura definitiva: o replay fica
    // pendente e o flush acontece no primeiro fit bem-sucedido (aqui embaixo ou
    // no ResizeObserver, quando o slot ainda não é mensurável neste frame).
    if (pane.terminalScrollback) {
      host.pendingScrollback = pane.terminalScrollback;
      host.pendingScrollbackCols = pane.terminalScrollbackCols;
      // Latched at assignment: flushPendingScrollback drops the pending copy
      // before xterm finishes parsing it, so a fast spawn must still see the
      // restored content and print the session boundary divider.
      host.hasVisibleContent = true;
    }
    host.opened = true;
    registerWebglLease(pane.id, host);
  }

  const beforeGrid = host.reportedGrid;
  if (useLayoutStore.getState().focusedPaneId !== pane.id) {
    try {
      if (fitHostGrid(host)) {
        flushPendingScrollback(host);
        propagateHostSize(host);
      }
    } catch {
      // Slot not measurable yet; the ResizeObserver will retry.
    }
  }
  // Headless spawn (waitForSession) pinta a TUI em 80×24. No attach, se a
  // grade real mudou, bounce SIGWINCH — o mesmo truque da adoption.
  if (
    shouldBouncePtyGridAfterAttach({
      hasSession: Boolean(host.sessionId),
      gridChanged: terminalGridChanged(beforeGrid, {
        cols: host.term.cols,
        rows: host.term.rows,
      }),
    })
  ) {
    bouncePtyGrid(host);
  }
  // The focused path is completed by focusHost in the caller's next layout
  // effect. Keeping it there avoids duplicate fit/SIGWINCH while preserving
  // resume → fit → flush before the browser paints.

  if (!host.spawnStarted && !host.hibernated) {
    if (heldSpawnPanes.has(pane.id)) {
      // Restored mission agent waiting for explicit user approval.
      useSessionStateStore.getState().setPaneState(pane.id, 'hibernated');
      if (host.opened && !host.holdNoticeWritten) {
        host.holdNoticeWritten = true;
        try {
          const missionOwned = Boolean(
            pane.missionId ?? useOrchStore.getState().paneMissions[pane.id],
          );
          host.term.writeln(
            `\r\n${missionOwned ? MISSION_HOLD_NOTICE : STANDALONE_HOLD_NOTICE}`,
          );
        } catch {
          // xterm may not be ready; ignore.
        }
      }
      return;
    }
    beginPaneSpawn(pane, host);
  }
}

/**
 * Bug I (2026-08-17): fechar o app com missão ativa derrubava todos os
 * panes de uma vez e CADA um imprimia "process exited" + "a missão ainda é
 * dona deste pane" (+ toasts de incidente) — uma parede de avisos sem
 * informação nova. No shutdown o grid inteiro recebe UM aviso calmo e os
 * banners por pane ficam suprimidos: a missão continua no rail e o boot
 * seguinte ressuscita (resurrection, 0.32.24).
 */
let terminalShutdownNoticeMode = false;

export function setTerminalShutdownNoticeMode(): void {
  if (terminalShutdownNoticeMode) return;
  terminalShutdownNoticeMode = true;
  const message =
    '\r\n\x1b[36m[nexus] encerrando o app — as missões continuam no rail ' +
    'e retomam sozinhas no próximo boot.\x1b[0m';
  for (const host of hosts.values()) {
    if (host.disposed || host.virtualized) continue;
    try {
      host.term.writeln(message);
    } catch {
      // apresentação é best-effort no shutdown
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', setTerminalShutdownNoticeMode);
}

/**
 * Panes flagged here spawn their FIRST session with the adapter's resume
 * flags (claude --resume etc.). Consumed on spawn — transient by design, so
 * the flag never persists into the saved layout. Used by the mission reopen
 * flow: mark before setPanes(), and every restored CLI continues its
 * previous conversation.
 */
/**
 * Intenção única de primeira-spawn por pane. resume+restore simultâneos são
 * rejeitados pelo main (fence em main-owned-agent-spawn) e o login do Codex
 * provou que os dois marcadores conviviam — pane morto com erro vermelho.
 * Slot único: a última intenção vence, ambiguidade é estruturalmente
 * impossível. Nunca persiste no layout salvo.
 */
type FirstSpawnIntent = 'resume' | 'restore';
const firstSpawnIntent = new Map<string, FirstSpawnIntent>();
/** Restored agents held until the user confirms resume (no silent auto-work). */
const heldSpawnPanes = new Set<string>();
/** F-213: quando cada pane entrou no held — mede a espera da aprovação. */
const heldSpawnSinceMs = new Map<string, number>();

function markFirstSpawnIntent(paneId: string, intent: FirstSpawnIntent): void {
  firstSpawnIntent.set(paneId, intent);
}

/**
 * Consome a intenção (one-shot) no formato do payload de spawn. Usado pelos
 * dois pontos de primeira-spawn; exportado para teste.
 */
export function consumeFirstSpawnIntent(paneId: string): {
  readonly resume: boolean;
  readonly restorePersistedAuthority: boolean;
} {
  const intent = firstSpawnIntent.get(paneId);
  firstSpawnIntent.delete(paneId);
  return {
    resume: intent === 'resume',
    restorePersistedAuthority: intent === 'restore',
  };
}

export function markResumeOnSpawn(paneId: string): void {
  // Intentional resume (reopen mission / user confirmed) always clears a hold.
  heldSpawnPanes.delete(paneId);
  markFirstSpawnIntent(paneId, 'resume');
  kickHeldSpawnIfReady(paneId);
}

function unlockExitedSessionlessHost(paneId: string): void {
  const host = hosts.get(paneId);
  if (
    !host ||
    host.disposed ||
    host.sessionId !== null ||
    paneState(paneId) !== 'exited'
  ) {
    return;
  }
  host.spawnGeneration += 1;
  host.cleanups.forEach((cleanup) => cleanup());
  host.cleanups = [];
  host.spawnStarted = false;
  host.hibernated = false;
}

/**
 * Explicit mission reopen may target a host whose previous spawn failed before
 * a PTY session was assigned. That host intentionally keeps `spawnStarted`
 * latched so ordinary React remounts cannot create an automatic retry loop,
 * but the latch must not also reject a deliberate "Retomar missão" action.
 *
 * A live session is never touched here: main remains the only authority that
 * can adopt or replace a physical mission process. We only reset a renderer
 * host that has no session and is already in a terminal `exited` state.
 */
export function prepareMissionPaneResume(paneId: string): void {
  unlockExitedSessionlessHost(paneId);
  markResumeOnSpawn(paneId);
}

/** Pause spawn for a restored agent until the user approves (or reopens). */
export function holdSpawnUntilApproved(paneId: string): void {
  heldSpawnPanes.add(paneId);
  heldSpawnSinceMs.set(paneId, Date.now());
  firstSpawnIntent.delete(paneId);
}

export function isSpawnHeld(paneId: string): boolean {
  return heldSpawnPanes.has(paneId);
}

/** Forget every renderer-local spawn intent before pruning an orphan leaf. */
export function discardPaneSpawnState(paneId: string): void {
  heldSpawnPanes.delete(paneId);
  heldSpawnSinceMs.delete(paneId);
  firstSpawnIntent.delete(paneId);
  useSessionStateStore.getState().clearPaneState(paneId);
}

/**
 * Release held agents after the restore gate. `resume:true` continues the
 * previous CLI conversation; `resume:false` drops the hold and leaves panes
 * paused (user must retomar no rail).
 */
export function releaseHeldSpawns(
  paneIds: readonly string[],
  opts: { resume: boolean },
): void {
  for (const paneId of paneIds) {
    // Always drop the hold flag even if it was already cleared — callers may
    // re-release after a coalesced prompt.
    heldSpawnPanes.delete(paneId);
    if (opts.resume) {
      const host = hosts.get(paneId);
      // Layout restore is intentionally observed from both the store and App.
      // Never leave a latent resume flag behind when the first observer already
      // adopted or started this pane.
      if (host?.spawnStarted || host?.sessionId) continue;
      markFirstSpawnIntent(paneId, 'resume');
      kickHeldSpawnIfReady(paneId);
    } else {
      // UI/session marker only — do NOT set host.hibernated or kickHeldSpawn
      // would refuse a later explicit resume.
      useSessionStateStore.getState().setPaneState(paneId, 'hibernated');
    }
  }
}

function kickHeldSpawnIfReady(paneId: string): void {
  if (heldSpawnPanes.has(paneId)) return;
  const host = hosts.get(paneId);
  if (!host || host.disposed || host.spawnStarted) return;
  // Host may have been soft-paused via session state without host.hibernated;
  // clear host flag so intentional resume always works.
  host.hibernated = false;
  const pane = listPanesFromLayout().find((p) => p.id === paneId);
  if (!pane || pane.kind !== 'cli-agent') return;
  beginPaneSpawn(pane, host);
}

function listPanesFromLayout(): readonly PaneModel[] {
  return listPanes(useLayoutStore.getState().root);
}

/** Mark a missing mission pane to start fresh with its persisted authority. */
export function markPersistedAuthorityOnSpawn(paneId: string): void {
  markFirstSpawnIntent(paneId, 'restore');
  heldSpawnPanes.delete(paneId);
  unlockExitedSessionlessHost(paneId);
  kickHeldSpawnIfReady(paneId);
}

// Conservative fallback until restore-agents-gate installs the product policy.
// The installed handler auto-resumes main-owned mission panes and asks only for
// standalone agents.
setRestoredPanesHandler((panes) => {
  for (const pane of panes) {
    // Missão não entra no hold cego: o gate real auto-retoma ou o teclado
    // destrava. Segurar orq/worker aqui era o limbo "Confirme o diálogo"
    // sem diálogo.
    if (
      pane.kind === 'cli-agent' &&
      !pane.missionId &&
      pane.role !== 'orchestrator' &&
      pane.role !== 'worker'
    ) {
      holdSpawnUntilApproved(pane.id);
    }
  }
});

export function focusHost(paneId: string): void {
  for (const [id, host] of hosts) {
    if (host.disposed) continue;
    host.term.options.cursorBlink = id === paneId && !host.hibernated;
  }
  const host = hosts.get(paneId);
  if (!host || host.disposed) return;
  if (host.opened) {
    // Focus recency drives the WebGL lease, then the visibility contract
    // settles its grid before promoting any queued background output.
    resumeVisibleHost(paneId, host);
  }
  host.term.focus();
}

/**
 * Settings/Missions hide the terminal workspace with `display:none`. Coming
 * back, IntersectionObserver often stays silent (F-603) so the live pane
 * looks gone until a split retriggers layout. Force slot CSS + host
 * visibility and a synchronous refit that always repaints (WebGL canvases
 * go blank under display:none even when the host stayed "visible").
 */
export function revealTerminalHostsAfterWorkspaceShow(): void {
  notifyPaneWorkspaceReveal();
  for (const [paneId, host] of hosts) {
    if (host.disposed) continue;
    if (!host.isVisible) {
      setHostVisibility(paneId, true);
      continue;
    }
    if (host.opened && !host.virtualized) refreshHost(paneId);
  }
  if (refitAllTimer) {
    clearTimeout(refitAllTimer);
    refitAllTimer = null;
  }
  const pending = pendingRefitReason;
  pendingRefitReason = null;
  refitAllHosts(
    pending ? escalateRefitReason(pending, 'workspace-reveal') : 'workspace-reveal',
  );
}

export function setHostVisibility(paneId: string, isVisible: boolean): void {
  const host = hosts.get(paneId);
  if (!host || host.disposed || host.isVisible === isVisible) return;
  host.isVisible = isVisible;
  if (!isVisible) {
    if (currentSettings.performanceMode === 'adaptive') {
      pauseTerminalOutput(host.term);
      webglPool.suspend(paneId);
    }
    host.term.options.cursorBlink = false;
    if (
      shouldHibernateHost({
        liveHosts: liveHostCount(),
        isPaneVisible: false,
        isParked: host.parked,
        opened: host.opened,
        disposed: host.disposed,
        hasSession: host.sessionId !== null,
        spawnPending:
          host.spawnWhenMeasurable === true ||
          !host.spawnStarted ||
          heldSpawnPanes.has(paneId),
      })
    ) {
      virtualizeHost(host);
    }
    return;
  }
  if (host.virtualized) {
    rehydrateHost(host);
    return;
  }
  if (!host.opened) return;
  host.gridReady = false;
  // Grade PRIMEIRO, scheduler depois: `resumeTerminalOutput` só destrava o
  // dreno de fundo — o dreno em si corre no timer próprio do scheduler
  // (`scheduleDrain`), então destravar antes do fit do reveal deixava o
  // backlog livre para pintar contra a grade ANTIGA (medida enquanto o pane
  // estava oculto), correndo contra o fit síncrono do rAF (F-356). Adiar o
  // destravamento para dentro do próprio rAF, depois do refit, fecha essa
  // corrida: o timer do dreno só pode disparar depois que este callback (e o
  // fit síncrono que ele faz) já terminou.
  requestAnimationFrame(() => {
    if (host.disposed || !host.opened || !host.isVisible) return;
    refreshHost(paneId);
  });
}

function handleDocumentVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    if (currentSettings.performanceMode !== 'adaptive') return;
    for (const [paneId, host] of hosts) {
      if (host.disposed) continue;
      pauseTerminalOutput(host.term);
      webglPool.suspend(paneId);
      host.term.options.cursorBlink = false;
    }
    return;
  }
  const focusedPaneId = useLayoutStore.getState().focusedPaneId;
  for (const [paneId, host] of hosts) {
    if (host.disposed || !host.isVisible) continue;
    host.gridReady = false;
    requestAnimationFrame(() => {
      if (host.disposed || !host.opened || !host.isVisible || document.visibilityState === 'hidden') return;
      if (paneId === focusedPaneId) focusHost(paneId);
      else refreshHost(paneId);
    });
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', handleDocumentVisibilityChange);
}

// F-370: no macOS o window.ts desliga o backgroundThrottling — a página
// segue 'visible' ao voltar de outro app e `visibilitychange` NUNCA
// dispara, deixando os panes sem o repaint do retorno. O 'focus' da
// janela é o equivalente real nessa plataforma; rajadas (focus trap,
// Mission Control) coalescem num único rAF.
let focusRefreshScheduled = false;
function handleWindowFocus(): void {
  if (focusRefreshScheduled) return;
  focusRefreshScheduled = true;
  requestAnimationFrame(() => {
    focusRefreshScheduled = false;
    if (document.visibilityState === 'hidden') return;
    const focusedPaneId = useLayoutStore.getState().focusedPaneId;
    for (const [paneId, host] of hosts) {
      if (
        host.disposed ||
        !host.opened ||
        !host.isVisible ||
        host.parked ||
        host.virtualized
      ) {
        continue;
      }
      // R8: voltar ao app NUNCA move o foco do DOM — um textarea/dialog que o
      // operador estava usando não pode perdê-lo para um terminal. O cursor
      // do pane focado volta a piscar pela option, sem term.focus().
      host.term.options.cursorBlink =
        paneId === focusedPaneId && !host.hibernated;
      refreshHost(paneId);
    }
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', handleWindowFocus);
}

/** Stop compositor work for a terminal that lost focus or left live view. */
export function blurHost(paneId: string): void {
  const host = hosts.get(paneId);
  if (!host || host.disposed) return;
  host.term.options.cursorBlink = false;
}

/**
 * Force a repaint when a pane becomes visible again (e.g., after
 * IntersectionObserver detects it re-entered the viewport). This ensures
 * the terminal content is up-to-date after being hidden.
 */
export function refreshHost(paneId: string): void {
  const host = hosts.get(paneId);
  if (!host || host.disposed || !host.opened) return;
  // Refit, release queued output and repaint only when the slot is measurable.
  resumeVisibleHost(paneId, host);
}

export interface TerminalRendererPerformanceSnapshot {
  readonly performanceMode: TerminalSettings['performanceMode'];
  readonly hosts: number;
  readonly visibleHosts: number;
  readonly activeWebglLeases: number;
  readonly queuedTerminals: number;
  readonly queuedChars: number;
  readonly pendingParseChars: number;
  readonly droppedBacklogs: number;
}

export function terminalRendererPerformanceSnapshot(): TerminalRendererPerformanceSnapshot {
  const output = getTerminalOutputRuntimeSnapshot();
  let visibleHosts = 0;
  for (const host of hosts.values()) {
    if (!host.disposed && host.isVisible) visibleHosts += 1;
  }
  return {
    performanceMode: currentSettings.performanceMode,
    hosts: [...hosts.values()].filter((host) => !host.disposed).length,
    visibleHosts,
    activeWebglLeases: webglPool.activeLeases,
    queuedTerminals: output.queuedTerminalCount,
    queuedChars: output.queuedChars,
    pendingParseChars: output.pendingParseChars,
    droppedBacklogs: output.droppedBacklogCount,
  };
}

/**
 * Rola o pane até a última mensagem e devolve o foco.
 *
 * Dois níveis de scroll coexistem: o scrollback do xterm E o transcript
 * interno de TUIs como o Claude Code (o pill "Jump to bottom (ctrl+End)").
 * Para panes de agente enviamos também a sequência do ctrl+End (CSI 1;5F)
 * ao PTY — é o atalho que o próprio TUI anuncia, inalcançável em teclados
 * Mac sem tecla End. Shells comuns não recebem a sequência (viraria lixo
 * no prompt).
 */
export function scrollPaneToBottom(paneId: string, sendJumpKey = false): void {
  const host = hosts.get(paneId);
  if (!host || host.disposed || !host.opened) return;
  flushTerminalOutput(host.term);
  host.inputVisibility.follow();
  host.term.scrollToBottom();
  if (sendJumpKey && host.sessionId) {
    window.nexus.pty.write(host.sessionId, '\x1b[1;5F');
  }
  host.term.focus();
}

function missionIdOfPane(paneId: string, pane?: PaneModel): string | undefined {
  const resolved =
    pane ??
    listPanes(useLayoutStore.getState().root).find(
      (candidate) => candidate.id === paneId,
    );
  return (
    resolved?.missionId ?? useOrchStore.getState().paneMissions[paneId]
  );
}

/**
 * Missão AINDA viva (running/blocked) é dona do pane. Missão done/failed — ou
 * vínculo órfão — libera o pane ao operador: caso contrário o processo morto
 * deixa teclado no-op para sempre (HiperGO 2026-08-07: exit code 0 + backlog
 * 2 MB, terminal "não deixa digitar").
 */
/**
 * Pane de missão CONCLUÍDA: o exit é vitória, não morte. "process exited /
 * digite qualquer tecla" fazia o pós-Pronto parecer velório (operador 20/08:
 * "só bug na tela" com a missão fechada e as respostas visíveis).
 */
function missionOfPaneIsDone(paneId: string, pane?: PaneModel): boolean {
  const resolved =
    pane ??
    listPanes(useLayoutStore.getState().root).find(
      (candidate) => candidate.id === paneId,
    );
  const missionId = missionIdOfPane(paneId, resolved);
  if (!missionId) return false;
  const mission = useOrchStore
    .getState()
    .missions.find((candidate) => candidate.id === missionId);
  return mission?.status === 'done';
}

function missionStillOwnsPane(paneId: string, pane?: PaneModel): boolean {
  const resolved =
    pane ??
    listPanes(useLayoutStore.getState().root).find(
      (candidate) => candidate.id === paneId,
    );
  const missionId = missionIdOfPane(paneId, resolved);
  if (!missionId) return false;
  const mission = useOrchStore
    .getState()
    .missions.find((candidate) => candidate.id === missionId);
  // Vínculo órfão (missão sumiu do store) ou missão terminal APROVADA:
  // operador reclama. Done sem carimbo do humano ainda é revisão — o
  // coordenador continua dono do pane (F-108).
  if (!mission) return false;
  if (mission.status === 'running' || mission.status === 'blocked') return true;
  return missionAwaitsOperatorReview(mission);
}

function terminalMissionLinkOf(pane: PaneModel): TerminalMissionLink {
  const missionId = missionIdOfPane(pane.id, pane);
  if (!missionId) return 'none';
  const orch = useOrchStore.getState();
  const legacy = orch.missions.find((m) => m.id === missionId);
  const summary = orch.missionSummaries.find((m) => m.id === missionId);
  if (legacy?.status === 'done' || summary?.state === 'completed') {
    return 'done';
  }
  if (legacy?.status === 'failed' || summary?.state === 'failed') {
    return 'failed';
  }
  return 'live-or-unknown';
}

/** Os dois espelhos locais: status cru do SQLite + projeção canônica. */
function missionStoresSayTerminal(missionId: string): boolean {
  const orch = useOrchStore.getState();
  const legacy = orch.missions.find((m) => m.id === missionId);
  if (legacy?.status === 'done' || legacy?.status === 'failed') return true;
  const summary = orch.missionSummaries.find((m) => m.id === missionId);
  return summary?.state === 'completed' || summary?.state === 'failed';
}

/**
 * Corrida done×exit: o término persiste no main e o broadcast é assíncrono,
 * então no instante do exit NENHUM espelho local pode ter visto o done —
 * era aí que um pane de missão concluída caía no banner genérico "process
 * exited / digite qualquer tecla" e na cascata de restore (sync-once →
 * unlock → shell) em vez do fecho verde. Uma leitura autoritativa decide;
 * falha/timeout ⇒ false (comportamento anterior).
 */
async function missionTerminalAuthoritative(
  missionId: string,
): Promise<boolean> {
  if (missionStoresSayTerminal(missionId)) return true;
  try {
    const snapshot = await Promise.race([
      window.nexus.mission.snapshot(missionId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
    ]);
    const state = (snapshot as { state?: string } | null)?.state;
    return state === 'completed' || state === 'failed';
  } catch {
    return false;
  }
}

function isMainControlledMissionPane(
  paneId: string,
  pane?: PaneModel,
): boolean {
  return missionStillOwnsPane(paneId, pane);
}

/**
 * Após exit limpo de agente de missão já terminal: vira shell no mesmo xterm
 * para o operador poder digitar de novo sem fechar o pane / abrir outro.
 */
async function reclaimExitedPaneAsShell(
  pane: PaneModel,
  host: Host,
  options: { readonly ignoreMissionOwnership?: boolean } = {},
): Promise<void> {
  if (host.disposed || host.sessionId || host.spawnStarted) return;
  if (
    !options.ignoreMissionOwnership &&
    missionStillOwnsPane(pane.id, pane)
  ) {
    return;
  }
  // The input subscription from the exited session deliberately remains live
  // long enough to receive the key that reaches this recovery path. It must
  // be removed before the replacement shell installs its own subscription;
  // otherwise the same xterm forwards every subsequent key once per past
  // session (for example, `c` becomes `cc` or `ccc`).
  host.spawnGeneration += 1;
  host.cleanups.forEach((cleanup) => cleanup());
  host.cleanups = [];
  host.spawnStarted = true;
  try {
    host.term.writeln(
      '\r\n\x1b[36m[nexus] abrindo shell neste pane…\x1b[0m',
    );
    const shellPane = useLayoutStore
      .getState()
      .reclaimAsOperatorShell(pane.id);
    useOrchStore.setState((s) => {
      if (!(pane.id in s.paneMissions)) return s;
      const next = { ...s.paneMissions };
      delete next[pane.id];
      return { paneMissions: next };
    });
    if (!shellPane || shellPane.kind !== 'shell') {
      throw new Error('layout did not convert pane to shell');
    }
    host.spawnStarted = false;
    void startSpawn(shellPane, host, false, false);
  } catch (error) {
    host.spawnStarted = false;
    const message = error instanceof Error ? error.message : String(error);
    try {
      host.term.writeln(
        `\r\n\x1b[31m[nexus] não foi possível abrir shell: ${message}\x1b[0m`,
      );
    } catch {
      // best effort
    }
  }
}

/**
 * Pane aposentado / pausado com missão viva: deixa em pausa honesta SEM
 * transformar em shell enquanto a missão ainda está ativa. Só converte para
 * shell quando a missão foi concluída/falhou ou não existe mais.
 *
 * BUG corrigido: a versão anterior transformava SEMPRE em shell, mesmo com
 * missão running, fazendo o rail mentir "Trabalhando" enquanto o pane virava
 * um shell comum. O operador via mensagens contraditórias e perdia o histórico
 * do agente. Agora: missão ativa = pane pausado preservado, missão encerrada =
 * pode virar shell.
 */
export async function unlockRetiredMissionPane(
  pane: PaneModel,
  host?: Host,
  options?: { readonly operatorInitiated?: boolean },
): Promise<void> {
  heldSpawnPanes.delete(pane.id);
  const target = host ?? hosts.get(pane.id);
  const missionId =
    pane.missionId ?? useOrchStore.getState().paneMissions[pane.id];

  let missionStatus:
    | 'pending'
    | 'running'
    | 'blocked'
    | 'done'
    | 'failed'
    | undefined;
  let lookupFailed = false;
  if (missionId) {
    const local = useOrchStore
      .getState()
      .missions.find((mission) => mission.id === missionId);
    try {
      const missions = await window.nexus.orch.listMissions();
      missionStatus = missions.find((mission) => mission.id === missionId)
        ?.status;
    } catch {
      if (local) {
        missionStatus = local.status;
      } else {
        lookupFailed = true;
      }
    }
  }

  const disposition = decideUnlockRetiredMissionPane({
    missionStatus,
    lookupFailed,
    isOrchestrator: pane.role === 'orchestrator',
    operatorInitiated: options?.operatorInitiated === true,
  });

  // Histórico: nem revive nem vira shell. É o estado do pane do coordenador
  // de uma missão pronta enquanto o operador só está OLHANDO — abrir
  // "Terminais" não pode relançar a missão.
  if (disposition === 'keep-history') {
    useSessionStateStore.getState().setPaneState(pane.id, 'exited');
    if (target && !target.disposed) target.spawnStarted = false;
    return;
  }

  if (target && !target.disposed) {
    if (target.sessionId) return;
    target.spawnStarted = false;

    if (disposition === 'keep-paused') {
      // Overclock: posse ≠ hibernar. Exit 0 deixa o pane exited e o teclado
      // pede retry-kickoff — o trio "dona / pausado / cursor oco" era o beco.
      target.hibernated = false;
      useSessionStateStore.getState().setPaneState(pane.id, 'exited');
      if (
        missionId &&
        shouldReviveDeadMissionFromPane({
          operatorInitiated: options?.operatorInitiated === true,
        })
      ) {
        void requestDeadMissionPaneRevive(
          pane,
          target,
          missionId,
          true,
        );
      }
      return;
    }

    target.hibernated = false;
    try {
      target.term.writeln(`\r\n\x1b[33m${STALE_AUTHORITY_UNLOCK_NOTICE}\x1b[0m`);
    } catch {
      // Presentation is best effort; the shell spawn is the unlock.
    }
    useSessionStateStore.getState().setPaneState(pane.id, 'exited');
    await reclaimExitedPaneAsShell(pane, target, {
      ignoreMissionOwnership: true,
    });
    return;
  }

  if (disposition === 'keep-paused') {
    useSessionStateStore.getState().setPaneState(pane.id, 'exited');
    if (
      missionId &&
      shouldReviveDeadMissionFromPane({
        operatorInitiated: options?.operatorInitiated === true,
      })
    ) {
      void requestMissionRuntimeResume(missionId, true);
    }
    return;
  }

  // Missão encerrada: vira shell no layout para o attach não
  // respawnar o cli-agent órfão e deixar a grade morta de novo.
  useLayoutStore.getState().reclaimAsOperatorShell(pane.id);
  useOrchStore.setState((s) => {
    if (!(pane.id in s.paneMissions)) return s;
    const next = { ...s.paneMissions };
    delete next[pane.id];
    return { paneMissions: next };
  });
  useSessionStateStore.getState().clearPaneState(pane.id);
}

function reportMainOwnedLifecycleOnly(host: Host, action: string): void {
  const message =
    `O pane pertence a uma missão. ${action} exige encerramento físico ` +
    'confirmado pelo processo principal.';
  try {
    host.term.writeln(`\r\n\x1b[33m[nexus] ${message}\x1b[0m`);
  } catch {
    // Terminal presentation is best effort; the denial already happened.
  }
  useToastStore.getState().push(
    'warn',
    'Ação de missão bloqueada',
    message,
  );
}

const ORCH_RELIVE_COOLDOWN_MS = 8_000;
const MAX_AUTO_ORCH_RELIVES = 2;
const orchReliveAt = new Map<string, number>();
const orchReliveCount = new Map<string, number>();

export type OrchAutoReliveGate = 'allow' | 'cooldown' | 'exhausted';

/**
 * Teto do religamento automático do Maestro (anti-loop de crash). Puro para
 * teste: 'cooldown' é transiente e silencioso; 'exhausted' exige voz — o
 * chamador anuncia que o automático pausou e que a tecla religa.
 */
export function orchAutoReliveGate(input: {
  readonly now: number;
  readonly lastReliveAt: number | undefined;
  readonly autoReliveCount: number;
  readonly cooldownMs?: number;
  readonly maxAutoRelives?: number;
}): OrchAutoReliveGate {
  const cooldownMs = input.cooldownMs ?? ORCH_RELIVE_COOLDOWN_MS;
  const maxAutoRelives = input.maxAutoRelives ?? MAX_AUTO_ORCH_RELIVES;
  if (
    input.lastReliveAt !== undefined &&
    input.now - input.lastReliveAt < cooldownMs
  ) {
    return 'cooldown';
  }
  if (input.autoReliveCount >= maxAutoRelives) return 'exhausted';
  return 'allow';
}

/**
 * Maestro no turn-end: a CLI saiu sozinha. Religa a mesma conversa no
 * mesmo xterm, sem banner e sem retry-kickoff (F-006/F-008).
 */
function reliveOrchestratorCli(
  pane: PaneModel,
  host: Host,
  operatorInitiated = false,
): void {
  if (host.disposed) return;
  const now = Date.now();
  if (!operatorInitiated) {
    const gate = orchAutoReliveGate({
      now,
      lastReliveAt: orchReliveAt.get(pane.id),
      autoReliveCount: orchReliveCount.get(pane.id) ?? 0,
    });
    if (gate === 'cooldown') return;
    if (gate === 'exhausted') {
      // Lei do Maestro sempre falável: o automático pausou, mas o pane
      // nunca some em silêncio — a tecla religa (caminho do operador, sem
      // teto) e a missão continua no Quadro.
      try {
        host.term.writeln(
          '\r\n\x1b[33m[nexus] o Maestro saiu e o religamento automático ' +
            'pausou após 2 tentativas — digite aqui para religar e pedir ' +
            'ajustes; a missão continua no Quadro.\x1b[0m',
        );
      } catch {
        // best effort
      }
      return;
    }
    orchReliveCount.set(pane.id, (orchReliveCount.get(pane.id) ?? 0) + 1);
  }
  orchReliveAt.set(pane.id, now);

  host.cleanups.forEach((fn) => fn());
  host.cleanups = [];
  if (host.sessionId) window.nexus.pty.kill(host.sessionId);
  setHostSession(host, pane.id, null);
  host.spawnStarted = false;
  host.hibernated = false;
  host.quietSpawn = true;

  const spawnPane = pane.orchRequestId
    ? (() => {
        useLayoutStore.getState().clearOrchRequestId(pane.id);
        const { orchRequestId: _drop, ...rest } = pane;
        return rest as PaneModel;
      })()
    : pane;
  // A missão aponta a sessão que acabou de morrer: depois do respawn ela
  // precisa ser religada à sessão nova, senão fica em leader-drift para
  // sempre (o orquestrador trabalha e as entregas não chegam a ele).
  const missionId =
    pane.missionId ?? useOrchStore.getState().paneMissions[pane.id];
  void startSpawn(spawnPane, host, true).then((sessionId) => {
    if (!sessionId || !missionId || host.disposed) return;
    void rebindRelivedOrchestrator(missionId, pane.id, sessionId);
  });
}

/**
 * Reconecta a missão à sessão NOVA do orquestrador e espelha a liderança no
 * layout — o mesmo IPC + espelho do rebind do orch-bridge: a estrela nunca
 * antecede o Main. Falha deixa o quadro em leader-drift como fallback.
 */
async function rebindRelivedOrchestrator(
  missionId: string,
  paneId: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const rebound = await window.nexus.orch.rebindMissionOrchestrator(
      missionId,
      sessionId,
    );
    if (!rebound.ok) {
      console.warn(
        `[leader-drift] o main recusou religar a missão ${missionId} à sessão ${sessionId}`,
      );
      return false;
    }
    // Só depois do rebind durável o renderer pode afirmar quem lidera.
    useOrchStore.getState().bindPaneMission(paneId, missionId);
    const { reflectLeadershipFromMissions } = await import(
      '../orch/leadership-reflect'
    );
    reflectLeadershipFromMissions(useOrchStore.getState().missions);
    return true;
  } catch (error) {
    console.warn(`[leader-drift] rebind da missão ${missionId} falhou:`, error);
    return false;
  }
}

/**
 * «Religar a missão ao Maestro» do Quadro: o orquestrador já está vivo numa
 * sessão nova (relive) e a missão ainda aponta a que morreu. Responde o
 * resultado para a UI orientar o próximo passo — Retomar quando não há
 * Maestro vivo, Reiniciar quando o Main recusa.
 */
export async function rebindLiveMaestroOfMission(
  missionId: string,
): Promise<'rebound' | 'no-live-maestro' | 'refused'> {
  const maestro = liveMaestroPaneOfMission(missionId);
  const sessionId = maestro ? getPaneSessionId(maestro.id) : null;
  if (!maestro || !sessionId) return 'no-live-maestro';
  const rebound = await rebindRelivedOrchestrator(
    missionId,
    maestro.id,
    sessionId,
  );
  return rebound ? 'rebound' : 'refused';
}

function interruptBusyMissionWorkers(
  missionId: string,
  exceptPaneId: string,
): void {
  const orch = useOrchStore.getState();
  const paneMissions = orch.paneMissions;
  const states = useSessionStateStore.getState().paneStates;
  const missionHandoffs = orch.handoffs.filter(
    (handoff) => handoff.missionId === missionId,
  );
  const hasSuccessHandoff = missionHandoffs.some(
    (handoff) => handoff.status === 'success' || handoff.status === 'partial',
  );
  const hasQueuedHandoffs = missionHandoffs.some(
    (handoff) =>
      handoff.deliveryState === 'queued' ||
      handoff.deliveryState === 'submitted',
  );
  for (const pane of listPanes(useLayoutStore.getState().root)) {
    if (pane.id === exceptPaneId) continue;
    const paneMission = pane.missionId ?? paneMissions[pane.id];
    if (paneMission !== missionId) continue;
    if (
      !shouldInterruptBusyWorkerAfterMaestroTurnEnd({
        workerIsOrchestrator: pane.role === 'orchestrator',
        paneState: states.get(pane.id),
        hasSuccessHandoff,
        hasQueuedHandoffs,
      })
    ) {
      continue;
    }
    const sessionId = getPaneSessionId(pane.id);
    if (!sessionId) continue;
    void window.nexus.orch.sendPaneOperatorInput({
      sessionId,
      data: '\x03',
    });
  }
}

/**
 * Re-spawn a cli-agent pane in the SAME xterm (scrollback preserved).
 * - same-account-resume: adapter --resume / --continue
 * - cross-account-continuity: fresh session + continuity pack (no exact resume
 *   of another account's provider session id)
 */
export function respawnWithResume(
  pane: PaneModel,
  note = '[nexus] reiniciando a CLI e verificando a sessão anterior…',
  options?: {
    mode?: RespawnMode;
    continuityPack?: string;
    /** Auth same-account: resume the process, never type into /login. */
    skipContinuation?: boolean;
  },
): void {
  const host = hosts.get(pane.id);
  if (!host || host.disposed) return;
  if (isMainControlledMissionPane(pane.id, pane)) {
    // Sessão morta: Reiniciar é retomar teclado, não outra sync que aposenta
    // o único leaf. Missão bloqueada com processo vivo segue o bootstrap.
    if (!host.sessionId) {
      void unlockRetiredMissionPane(pane, host);
      return;
    }
    const missionId =
      pane.missionId ?? useOrchStore.getState().paneMissions[pane.id];
    void (async () => {
      const routed = missionId
        ? await routeBlockedMissionToResume(host, missionId, { manual: true })
        : false;
      if (!routed) {
        void unlockRetiredMissionPane(pane, host);
      }
    })();
    return;
  }
  host.cleanups.forEach((fn) => fn());
  host.cleanups = [];
  if (host.sessionId) window.nexus.pty.kill(host.sessionId);
  setHostSession(host, pane.id, null);
  host.spawnStarted = false;
  host.hibernated = false;
  host.term.writeln(`\r\n\x1b[33m${note}\x1b[0m`);
  // User-driven restart: never re-claim a spent orchspawn token. Authority
  // comes from resume/persisted pane or direct workspace scope.
  const spawnPane =
    pane.orchRequestId
      ? (() => {
          useLayoutStore.getState().clearOrchRequestId(pane.id);
          const { orchRequestId: _drop, ...rest } = pane;
          return rest as PaneModel;
        })()
      : pane;
  const cross = options?.mode === 'cross-account-continuity';
  void startSpawn(
    spawnPane,
    host,
    !cross,
    false,
    cross ? options?.continuityPack : undefined,
    false,
    options?.skipContinuation === true,
  );
}

export function hibernateHost(paneId: string): boolean {
  const host = hosts.get(paneId);
  if (!host || host.disposed) return false;
  if (isMainControlledMissionPane(paneId)) {
    reportMainOwnedLifecycleOnly(host, 'Hibernar');
    return false;
  }
  host.cleanups.forEach((fn) => fn());
  host.cleanups = [];
  host.spawnGeneration += 1;
  if (host.sessionId) window.nexus.pty.kill(host.sessionId);
  host.spawnStarted = false;
  host.hibernated = true;
  host.term.options.cursorBlink = false;
  useSessionStateStore.getState().setPaneState(paneId, 'hibernated');
  setHostSession(host, paneId, null);
  try {
    host.term.writeln(
      '\r\n\x1b[36m[nexus] pane dormindo — processo encerrado, buffer preservado. Use ☀ para acordar.\x1b[0m',
    );
  } catch {
    // Terminal may not be open yet.
  }
  return true;
}

export function wakeHost(pane: PaneModel): boolean {
  const host = hosts.get(pane.id);
  if (!host || host.disposed || host.sessionId) return false;
  if (pane.kind === 'browser') return false;
  if (isMainControlledMissionPane(pane.id, pane)) {
    void unlockRetiredMissionPane(pane, host);
    return true;
  }
  host.hibernated = false;
  host.spawnStarted = false;
  try {
    host.term.writeln('\r\n\x1b[36m[nexus] acordando pane…\x1b[0m');
  } catch {
    // Terminal may not be open yet.
  }
  useSessionStateStore.getState().setPaneState(pane.id, 'spawning');
  void startSpawn(pane, host, pane.kind === 'cli-agent');
  return true;
}

/**
 * 0.76.45: main → renderer via orch:pane.parkRequest. O guardian estacionou
 * este pane por ociosidade (ou pressão de memória) e já encerrou a sessão
 * PTY antes de mandar isto — o renderer só reflete: mantém o scrollback,
 * descarta os listeners do spawn morto (mesmo gesto de `hibernateHost`, para
 * o próximo `startSpawn` não herdar um onData duplicado) e marca o pane em
 * `usePaneParkedStore` (cabeçalho "Dormindo" + botão "Acordar" no toolbar).
 * Acordar reusa `wakeHost` — mesmo caminho do Dormir/Acordar manual.
 */
export function markPaneParked(request: PaneParkRequest): void {
  const host = hosts.get(request.paneId);
  if (!host || host.disposed) return;
  if (host.sessionId === request.sessionId) {
    setHostSession(host, request.paneId, null);
  }
  host.cleanups.forEach((fn) => fn());
  host.cleanups = [];
  host.spawnStarted = false;
  host.hibernated = true;
  host.term.options.cursorBlink = false;
  usePaneParkedStore.getState().markParked(request.paneId, {
    sessionId: request.sessionId,
    parkedAt: request.parkedAt,
    reason: request.reason,
  });
  const reasonLabel =
    request.reason === 'memory-pressure' ? 'pressão de memória' : 'ociosidade';
  try {
    host.term.writeln(
      `\r\n\x1b[36m[nexus] pane estacionado (${reasonLabel}) — processo encerrado, ` +
        'buffer preservado. Use ☀ ou digite para acordar.\x1b[0m',
    );
  } catch {
    // Terminal pode não estar aberto ainda.
  }
}

/** The live PTY session id backing a pane, or null if not spawned yet. */
/** Aviso do main: esta sessão vai ser encerrada para fechar o pane. */
export function markPaneClosingDeliberately(
  paneId: string,
  sessionId: string,
): void {
  const host = hosts.get(paneId);
  if (host && host.sessionId === sessionId) host.closingSessionId = sessionId;
}

/**
 * Se o closeRequest não chegar (término falhou depois do exit, escopo mudou),
 * o pane não pode ficar mudo para sempre: volta ao convite normal de shell.
 */
export const DELIBERATE_CLOSE_FALLBACK_MS = 5_000;

function awaitDeliberatePaneClose(host: Host): void {
  host.awaitingDeliberateClose = true;
  host.term.writeln('\r\n\x1b[90m[nexus] pane encerrado; fechando.\x1b[0m');
  setTimeout(() => {
    if (host.disposed || !host.awaitingDeliberateClose) return;
    host.awaitingDeliberateClose = false;
    if (host.sessionId || host.spawnStarted) return;
    host.term.writeln(
      '\x1b[36m[nexus] sessão encerrada. Digite qualquer tecla para abrir um shell neste pane.\x1b[0m',
    );
  }, DELIBERATE_CLOSE_FALLBACK_MS);
}

export function getPaneSessionId(paneId: string): string | null {
  return hosts.get(paneId)?.sessionId ?? null;
}

/**
 * Sessão que pode receber DIGITAÇÃO do renderer. Um host estacionado é de
 * outro workspace: a sessão continua viva, mas texto de ditado, anexo ou
 * Jarvis que chegue a ele depois de uma troca de projeto mistura um
 * workspace no outro sem ninguém ver (campo 23/09).
 */
function typingSessionId(paneId: string): string | null {
  if (hosts.get(paneId)?.parked) {
    console.warn(`[terminal] digitação recusada: ${paneId} está estacionado em outro workspace`);
    return null;
  }
  return getPaneSessionId(paneId);
}

// Cold CLI start under Seatbelt pays for the signed-helper handshake and the
// sandbox profile before the PTY reports a session. 20s expired on machines
// that were merely slow, turning "still starting" into "failed".
const SESSION_WAIT_TIMEOUT_MS = 60_000;

/**
 * Resolve with a pane's PTY session id once it materializes, or null on
 * timeout. A newly created operator shell can be waiting behind Settings, so
 * this starts its backing host headlessly; navigation and focus remain with
 * the caller until the real session event arrives.
 */
export function waitForSession(
  paneId: string,
  timeoutMs = SESSION_WAIT_TIMEOUT_MS,
): Promise<string | null> {
  const existing = getPaneSessionId(paneId);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      unsub();
      clearTimeout(timer);
      resolve(value);
    };
    const unsub = onPaneSessionChange((id, sessionId) => {
      if (id === paneId && sessionId) finish(sessionId);
    });
    const timer = setTimeout(() => finish(getPaneSessionId(paneId)), timeoutMs);
    const pane = listPanes(useLayoutStore.getState().root).find(
      (candidate) => candidate.id === paneId,
    );
    // Subscribe first, then spawn: a fast PTY used to resolve before
    // onPaneSessionChange was attached, so waitForSession sat until timeout
    // even with a live session. Headless spawn: mission cli-agent panes used
    // to wait for PaneLeaf attachHost; empty #root timed out as session=none.
    if (
      pane &&
      pane.isStructuralPlaceholder !== true &&
      !heldSpawnPanes.has(pane.id)
    ) {
      const host = getOrCreateHost(pane);
      if (!host.spawnStarted && !host.hibernated) {
        beginPaneSpawn(pane, host);
        if (!host.spawnStarted) {
          // Give visible leaves time to measure their real grid. An opened
          // xterm can still be hidden (Settings/Missions) and must start too.
          const generation = host.spawnGeneration;
          setTimeout(() => {
            if (
              host.disposed ||
              host.spawnStarted ||
              host.hibernated ||
              host.spawnGeneration !== generation ||
              heldSpawnPanes.has(pane.id) ||
              !listPanes(useLayoutStore.getState().root).some(
                (candidate) => candidate.id === pane.id,
              )
            ) {
              return;
            }
            // Preserve the actual visible size; hidden hosts use their
            // initial grid until attach/ResizeObserver can fit them.
            settleHostGrid(host);
            host.spawnWhenMeasurable = false;
            const firstIntent = consumeFirstSpawnIntent(pane.id);
            void startSpawn(
              pane,
              host,
              firstIntent.resume,
              false,
              undefined,
              firstIntent.restorePersistedAuthority,
            );
          }, HEADLESS_SPAWN_FALLBACK_MS);
        }
      }
    }
  });
}

function paneState(paneId: string) {
  return useSessionStateStore.getState().paneStates.get(paneId);
}

/** Wait until a specific replacement PTY is alive and has reached first idle. */
export function waitForHealthyPaneSession(
  paneId: string,
  expectedPreviousSessionId?: string,
  timeoutMs = 75_000,
): Promise<string | null> {
  const current = getPaneSessionId(paneId);
  if (
    current &&
    current !== expectedPreviousSessionId &&
    paneState(paneId) === 'idle'
  ) {
    return Promise.resolve(current);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (sessionId: string | null): void => {
      if (settled) return;
      settled = true;
      unsubscribeSession();
      unsubscribeState();
      clearTimeout(timer);
      resolve(sessionId);
    };
    const inspect = (): void => {
      const sessionId = getPaneSessionId(paneId);
      const state = paneState(paneId);
      if (!sessionId || sessionId === expectedPreviousSessionId) return;
      if (state === 'exited') {
        finish(null);
        return;
      }
      if (state === 'idle') finish(sessionId);
    };
    const unsubscribeSession = onPaneSessionChange((id) => {
      if (id === paneId) inspect();
    });
    const unsubscribeState = useSessionStateStore.subscribe(inspect);
    const timer = setTimeout(() => finish(null), timeoutMs);
    inspect();
  });
}

/** Session identity + renderer lifecycle check used immediately before ACK. */
export function isPaneSessionHealthy(
  paneId: string,
  sessionId: string,
): boolean {
  const state = paneState(paneId);
  return (
    getPaneSessionId(paneId) === sessionId &&
    state !== 'exited' &&
    state !== 'hibernated' &&
    state !== 'spawning'
  );
}

/** Cancel the current recovery generation and kill only its replacement PTY. */
export function cancelPaneRecovery(
  paneId: string,
  sessionId?: string,
): void {
  const host = hosts.get(paneId);
  if (!host || host.disposed) return;
  if (sessionId && host.sessionId && host.sessionId !== sessionId) return;
  host.spawnGeneration += 1;
  host.cleanups.forEach((cleanup) => cleanup());
  host.cleanups = [];
  const current = host.sessionId;
  if (current && (!sessionId || current === sessionId)) {
    window.nexus.pty.kill(current);
    setHostSession(host, paneId, null);
  }
  host.spawnStarted = false;
  useSessionStateStore.getState().setPaneState(paneId, 'exited');
}

/**
 * Replace one existing mission pane with a fresh provider conversation while
 * preserving stable pane identity and persisted main-process authority.
 */
export async function respawnMissionPaneFresh(
  pane: PaneModel,
  expectedSessionId?: string,
  timeoutMs = 75_000,
  recoveryRequestId?: string,
): Promise<string> {
  const host = hosts.get(pane.id);
  if (!host || host.disposed) throw new Error('mission pane host is unavailable');
  const current = host.sessionId;
  if (
    (expectedSessionId && current && current !== expectedSessionId) ||
    (!expectedSessionId && current)
  ) {
    throw new Error('mission pane session changed before recovery');
  }

  host.cleanups.forEach((cleanup) => cleanup());
  host.cleanups = [];
  if (current) window.nexus.pty.kill(current);
  setHostSession(host, pane.id, null);
  host.spawnStarted = false;
  host.hibernated = false;
  host.term.writeln(
    '\r\n\x1b[33m[nexus] contexto degradado — iniciando uma sessão limpa…\x1b[0m',
  );
  const spawnPaneBase = pane.orchRequestId
    ? (() => {
        useLayoutStore.getState().clearOrchRequestId(pane.id);
        const { orchRequestId: _drop, ...rest } = pane;
        return rest as PaneModel;
      })()
    : pane;
  const spawnPane = recoveryRequestId
    ? { ...spawnPaneBase, orchRequestId: recoveryRequestId }
    : spawnPaneBase;
  const startedAt = Date.now();
  const spawnPromise = startSpawn(
    spawnPane,
    host,
    false,
    false,
    undefined,
    true,
  );
  const spawned = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    void spawnPromise.then((sessionId) => {
      clearTimeout(timer);
      resolve(sessionId);
    });
  });
  if (!spawned) {
    cancelPaneRecovery(pane.id);
    throw new Error('fresh pane spawn timed out or failed');
  }
  const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
  const healthy = await waitForHealthyPaneSession(
    pane.id,
    expectedSessionId,
    remaining,
  );
  if (!healthy || healthy !== spawned) {
    cancelPaneRecovery(pane.id, spawned);
    throw new Error('fresh pane session did not become healthy');
  }
  return healthy;
}

const INPUT_REFUSAL_NOTICE_THROTTLE_MS = 2_000;
const inputRefusalNoticeAt = new Map<string, number>();

function sendOperatorInputOrNotify(
  paneId: string,
  sessionId: string,
  data: string,
): void {
  void window.nexus.orch.sendPaneOperatorInput({ sessionId, data }).then(
    async (accepted) => {
      if (accepted) return;
      // Fallback: pane direto do operador (role `user`) aceita escrita crua, e
      // o paste bracketed é recusado na lane do operador de propósito. O
      // recibo CONFIRMADO é a única forma de saber que o main aceitou — o
      // `pty.write` cru é fire-and-forget (send) e devolvia `undefined`, então
      // uma recusa real caía no vazio e a tecla sumia sem aviso.
      let wrote = false;
      try {
        wrote = await window.nexus.pty.writeConfirmed(sessionId, data);
      } catch {
        // PTY pode estar encerrado fisicamente
      }
      if (wrote) return;
      const target = hosts.get(paneId);
      if (!target || target.disposed) return;
      // Uma recusa POR RAJADA, não por tecla: digitação corrida e eventos de
      // mouse SGR viravam dezenas de linhas iguais ("centenas de erro",
      // operador 20/08) — o aviso afogava o próprio conteúdo do pane.
      const now = Date.now();
      const last = inputRefusalNoticeAt.get(paneId) ?? 0;
      if (now - last < INPUT_REFUSAL_NOTICE_THROTTLE_MS) return;
      inputRefusalNoticeAt.set(paneId, now);
      try {
        target.term.writeln(
          '\r\n\x1b[33m[nexus] o main recusou a digitação neste pane.\x1b[0m',
        );
      } catch {
        // best effort
      }
    },
  );
}

/**
 * Write text into a pane's PTY as if the user typed it — the exact same path as
 * keyboard input. Used by voice routing to inject the transcribed prompt into
 * the focused pane. Returns false when the pane has no live session.
 */
export function writeToPane(paneId: string, data: string): boolean {
  const host = hosts.get(paneId);
  if (host && !host.disposed) {
    host.inputVisibility.onUserInput();
    if (host.opened) webglPool.touch(paneId);
    flushTerminalOutput(host.term);
  }
  const sessionId = typingSessionId(paneId);
  if (!sessionId) return false;
  // Mesma lane do teclado (BUG 1, 06/08): pane governado recusa escrita crua
  // do renderer por design — o espaço retido do hold-to-talk morria em
  // silêncio aqui. Roteia como o xterm onData: missão → lane do operador.
  const pane = listPanes(useLayoutStore.getState().root).find(
    (candidate) => candidate.id === paneId,
  );
  const lane = paneInputLane(
    pane,
    useOrchStore.getState().paneMissions[paneId],
  );
  if (lane === 'operator') {
    sendOperatorInputOrNotify(paneId, sessionId, data);
    return true;
  }
  window.nexus.pty.write(sessionId, data);
  return true;
}

/**
 * Submit a complete prompt to an agent TUI. Newlines stay inside a bracketed
 * paste; a delayed CR performs the actual Enter instead of leaving text in the
 * multiline composer.
 */
export function submitPromptToPane(paneId: string, text: string): boolean {
  const host = hosts.get(paneId);
  if (host && !host.disposed) host.inputVisibility.onUserInput();
  return submitPanePrompt(paneId, text, {
    getSessionId: typingSessionId,
    write: (sessionId, data) => window.nexus.pty.write(sessionId, data),
    writeConfirmed: (sessionId, data) =>
      window.nexus.pty.writeConfirmed(sessionId, data),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  });
}

/** Strong submission contract used by recovery before it acknowledges. */
export function submitPromptToPaneConfirmed(
  paneId: string,
  text: string,
  expectedSessionId: string,
): Promise<boolean> {
  const host = hosts.get(paneId);
  if (host && !host.disposed) host.inputVisibility.onUserInput();
  return submitPanePromptConfirmed(paneId, text, expectedSessionId, {
    getSessionId: typingSessionId,
    write: (sessionId, data) => window.nexus.pty.write(sessionId, data),
    writeConfirmed: (sessionId, data) =>
      window.nexus.pty.writeConfirmed(sessionId, data),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  });
}

/**
 * Digitação confirmada pela lane do operador — caminho autorizado do ditado
 * para panes governados (o writeConfirmed cru é recusado pelo main por design).
 */
export function submitPromptToPaneOperatorInput(
  paneId: string,
  text: string,
  expectedSessionId: string,
): Promise<boolean> {
  const host = hosts.get(paneId);
  if (host && !host.disposed) host.inputVisibility.onUserInput();
  return submitPanePromptOperator(paneId, text, expectedSessionId, {
    getSessionId: typingSessionId,
    operatorWrite: (sessionId, data) =>
      window.nexus.orch.sendPaneOperatorInput({ sessionId, data }),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  });
}

/**
 * Panes afastados por troca de workspace, por workspace dono. Trocar de
 * projeto AFASTA os panes — não os fecha. Antes, todo host fora da árvore nova
 * era descartado e `disposeHost` matava o PTY com `force:true`: o trabalho
 * que rodava num pane do operador morria ~1 s depois do clique em outro
 * workspace, e na volta o scrollback salvo fingia que o terminal tinha
 * voltado. Só o fechamento explícito (pane ✕, Fechar projeto, remover da
 * lista) mata.
 */
const parkedHosts = new Map<string, Set<string>>();
const parkedHostWorkspace = new Map<string, string>();

function unparkHost(paneId: string, host: Host): void {
  host.parked = false;
  const workspacePath = parkedHostWorkspace.get(paneId);
  parkedHostWorkspace.delete(paneId);
  if (workspacePath === undefined) return;
  const set = parkedHosts.get(workspacePath);
  set?.delete(paneId);
  if (set && set.size === 0) parkedHosts.delete(workspacePath);
}

/**
 * Afasta os panes da árvore ATUAL antes de o layout trocar de workspace.
 * Host sem sessão não tem nada a preservar e é descartado (o scrollback salvo
 * o reconstrói na volta); host com sessão sai do DOM e devolve o lease de
 * WebGL, mas mantém xterm, PTY e estado. Devolve quantos ficaram estacionados.
 */
export function parkWorkspaceHosts(workspacePath: string): number {
  const paneIds = listPanes(useLayoutStore.getState().root).map(
    (item) => item.id,
  );
  let parked = 0;
  for (const paneId of paneIds) {
    const host = hosts.get(paneId);
    if (!host || host.disposed || host.parked) continue;
    if (!host.sessionId) {
      disposeHost(host, paneId);
      hosts.delete(paneId);
      continue;
    }
    host.parked = true;
    webglPool.unregister(paneId);
    host.element.remove();
    parkedHostWorkspace.set(paneId, workspacePath);
    let set = parkedHosts.get(workspacePath);
    if (!set) {
      set = new Set();
      parkedHosts.set(workspacePath, set);
    }
    set.add(paneId);
    parked += 1;
  }
  if (parked > 0) {
    console.info(
      `[terminal] ${parked} pane(s) de ${workspacePath} estacionado(s) com a sessão viva`,
    );
  }
  return parked;
}

/** Fechamento explícito de um projeto: mata o que estava estacionado dele. */
export function disposeWorkspaceHosts(workspacePath: string): number {
  const set = parkedHosts.get(workspacePath);
  if (!set) return 0;
  let disposed = 0;
  for (const paneId of [...set]) {
    const host = hosts.get(paneId);
    unparkHost(paneId, host ?? ({ parked: false } as Host));
    if (!host || host.disposed) continue;
    disposeHost(host, paneId);
    hosts.delete(paneId);
    disposed += 1;
  }
  if (disposed > 0) {
    console.info(
      `[terminal] ${disposed} pane(s) estacionado(s) de ${workspacePath} encerrado(s)`,
    );
  }
  return disposed;
}

function disposeHost(host: Host, paneId: string): void {
  host.disposed = true;
  clearDeferredSpawnRetry(host);
  host.inputVisibility.dispose();
  webglPool.unregister(paneId);
  host.ro.disconnect();
  host.cleanups.forEach((fn) => fn());
  if (host.sessionId) window.nexus.pty.kill(host.sessionId);
  host.term.dispose();
  host.element.remove();
  useSessionStateStore.getState().clearPaneState(paneId);
}

/**
 * Dispose every terminal whose pane id is no longer present in the layout.
 * Um host estacionado está fora da árvore DE PROPÓSITO (o workspace dele
 * saiu de cena): não é descarte. Se ele voltou à árvore, desestaciona.
 */
export function reconcileHosts(liveIds: Set<string>): void {
  for (const [id, host] of hosts) {
    if (liveIds.has(id)) {
      if (host.parked) unparkHost(id, host);
      continue;
    }
    if (host.parked) continue;
    disposeHost(host, id);
    hosts.delete(id);
  }
}
