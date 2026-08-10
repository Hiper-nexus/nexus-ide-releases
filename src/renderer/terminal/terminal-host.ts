import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import type { PaneModel } from '../../shared/types';
import type { TerminalSettings } from '../../shared/settings-types';
import { DEFAULT_TERMINAL_SETTINGS } from '../../shared/settings-types';
import {
  setRestoredPanesHandler,
  setTerminalSnapshotProvider,
  useLayoutStore,
} from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { useOrchStore } from '../state/orch-store';
import { useToastStore } from '../state/toast-store';
import { getActiveWorkspacePath } from '../state/active-workspace';
import { listPanes } from '../lib/split-tree';
import { paneInputLane } from './pane-input-route';
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
  createAdoptionRepaintTape,
  repaintAdoptedFrame,
} from './adoption-repaint';
import {
  SCROLLBACK_WIDTH_MISMATCH_NOTICE,
  SESSION_BOUNDARY_NOTICE,
  terminalBufferHasContent,
} from './session-boundary-notice';
import {
  canReplayScrollback,
  terminalGridChanged,
  terminalOutputPolicy,
  terminalScrollbackLines,
} from './terminal-render-policy';

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
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
  ro: ResizeObserver;
  sessionId: string | null;
  /** Last grid already propagated to the PTY; avoids duplicate SIGWINCH. */
  reportedGrid: { cols: number; rows: number } | null;
  isVisible: boolean;
  /** One-shot notice when agent is held pending user approval. */
  holdNoticeWritten?: boolean;
  /** Invalidates a late async spawn after recovery timeout/replacement. */
  spawnGeneration: number;
  opened: boolean;
  spawnStarted: boolean;
  hibernated: boolean;
  disposed: boolean;
  /** Keeps the live composer visible and repairs missed interactive paints. */
  inputVisibility: TerminalInputVisibilityController;
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
    recovered ? 'Doctor recuperando sessão do pane' : 'Doctor interrompeu o loop de retomada',
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
  return resumeTerminalVisibilityBeforePaint({
    resumeRenderer: () => webglPool.touch(paneId),
    fitVisibleGrid: () => host.fit.fit(),
    propagateSize: () => propagateHostSize(host),
    flushOutput: () => {
      flushPendingScrollback(host);
      flushTerminalOutput(host.term);
    },
    repaint: () => host.inputVisibility.repaintNow(),
  });
}

const hosts = new Map<string, Host>();
const MAX_PERSISTED_SCROLLBACK = 256_000;

setTerminalSnapshotProvider((paneId) => {
  const host = hosts.get(paneId);
  if (!host || host.disposed || !host.opened) return undefined;
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

function propagateHostSize(host: Host): boolean {
  if (!host.sessionId) return false;
  const next = { cols: host.term.cols, rows: host.term.rows };
  if (!terminalGridChanged(host.reportedGrid, next)) return false;
  window.nexus.pty.resize(host.sessionId, next.cols, next.rows);
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
    if (host.disposed) continue;
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
      host.fit.fit();
      propagateHostSize(host);
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
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(serialize);
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
    host.term.writeln(
      '\r\n\x1b[36m[nexus] missão bloqueada — retomando pela autoridade principal…\x1b[0m',
    );
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

function startSpawn(
  pane: PaneModel,
  host: Host,
  resume = false,
  resumeLatestOnly = false,
  continuityPack?: string,
  restorePersistedAuthority = false,
): Promise<string | null> {
  const generation = host.spawnGeneration + 1;
  host.spawnGeneration = generation;
  host.spawnStarted = true;
  host.hibernated = false;
  useSessionStateStore.getState().setPaneState(pane.id, 'spawning');
  return (async (): Promise<string | null> => {
    try {
      const missionId =
        pane.missionId ?? useOrchStore.getState().paneMissions[pane.id];
      // Account absence is also sealed authority. Renderer-side vault
      // discovery is reserved for manual panes; every mission/orchestration
      // spawn must preserve the exact account Main selected (including none).
      const accountId = shouldAutoPinPaneAccount(pane, missionId)
        ? await ensurePaneAccountPin(pane)
        : pane.accountId;
      if (host.disposed || host.spawnGeneration !== generation) return null;
      const spawnKind = pane.kind === 'cli-agent' ? 'cli-agent' : 'shell';
      const res = await window.nexus.pty.spawn({
        // Panes always live inside the active workspace: restored panes from
        // older sessions (or the fresh initial tree) may lack a cwd — they
        // must open in the workspace folder, never the user's home.
        cwd: pane.cwd ?? getActiveWorkspacePath() ?? undefined,
        shell:
          pane.kind === 'shell' && currentSettings.shell !== ''
            ? currentSettings.shell
            : undefined,
        cols: host.term.cols,
        rows: host.term.rows,
        kind: spawnKind,
        resume,
        resumeLatestOnly,
        restorePersistedAuthority,
        // paneId estável (layout persistido): com resume, o main retoma a
        // sessão de provider CAPTURADA deste pane (`--resume <id>`).
        paneId: pane.id,
        adapterId: pane.adapterId,
        model: pane.model,
        accountId: accountId ?? pane.accountId,
        effort: pane.effort,
        orchRequestId: pane.orchRequestId,
        missionId,
      });
      if (host.disposed || host.spawnGeneration !== generation) {
        if (res.ok) window.nexus.pty.kill(res.sessionId);
        return null;
      }
      if (!res.ok) {
        const isPersistedMissionAuthorityRefresh =
          Boolean(missionId) &&
          /persisted mission pane authority/i.test(res.error);
        if (isPersistedMissionAuthorityRefresh) {
          // A persisted pane is only presentation; Main owns the mission. Do
          // not dump an internal seal/CAS diagnostic into the user's terminal
          // and then leave a red dead end. The blocked path is re-armed by
          // Main; a revision that already advanced simply retires this stale
          // presentation while the current coordinator continues.
          console.warn(
            `[mission-restore] stale pane ${pane.id} was not restarted:`,
            res.error,
          );
          host.term.writeln(
            '\r\n\x1b[36m[nexus] contexto antigo detectado — sincronizando a missão pela autoridade principal…\x1b[0m',
          );
          void routeBlockedMissionToResume(host, missionId!).then((resumed) => {
            if (!resumed && !host.disposed) {
              host.term.writeln(
                '\r\n\x1b[33m[nexus] pane antigo aposentado; a revisão atual continua pelo coordenador da missão.\x1b[0m',
              );
            }
          });
          useSessionStateStore.getState().setPaneState(pane.id, 'exited');
          return null;
        }
        host.term.writeln(
          `\r\n\x1b[31m[nexus] failed to start: ${res.error}\x1b[0m`,
        );
        // Spent orch tokens leave a permanent dead pane on Reiniciar — drop them.
        if (
          pane.orchRequestId &&
          /unknown or expired|orchestration spawn request/i.test(res.error)
        ) {
          useLayoutStore.getState().clearOrchRequestId(pane.id);
          host.term.writeln(
            '\r\n\x1b[33m[nexus] token de spawn expirado limpo — use Reiniciar de novo.\x1b[0m',
          );
        }
        useSessionStateStore.getState().setPaneState(pane.id, 'exited');
        return null;
      }
      setHostSession(host, pane.id, res.sessionId);
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
        host.term.writeln(SESSION_BOUNDARY_NOTICE);
      }
      host.hasVisibleContent = true;
      if (resume && !res.adopted) {
        const message =
          res.resumeMode === 'fresh-context'
            ? '[nexus] a sessão anterior morreu com o app — a missão continuará em contexto novo.'
            : res.resumeMode === 'exact'
              ? '[nexus] sessão exata recuperada para este pane.'
              : res.resumeMode === 'latest'
                ? '[nexus] retomada aproximada: a CLI abriu a conversa mais recente deste workspace.'
                : '[nexus] nova sessão: esta CLI não oferece recuperação nativa.';
        host.term.writeln(`\r\n\x1b[${res.resumeMode === 'exact' ? '32' : '33'}m${message}\x1b[0m`);
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

      // Shared output scheduler: focused pane is latency-sensitive (immediate
      // write); hidden panes queue with a bounded backlog so concurrent agent
      // floods cannot pin the renderer. See terminal-output-scheduler.ts.
      host.cleanups.push(
        window.nexus.pty.onData(res.sessionId, (data) => {
          adoptionTape?.retain(data);
          const policy = terminalOutputPolicy({
            kind: pane.kind,
            isFocused:
              useLayoutStore.getState().focusedPaneId === pane.id,
            isPaneVisible: host.isVisible,
            isDocumentVisible: document.visibilityState !== 'hidden',
            performanceMode: currentSettings.performanceMode,
          });
          writeTerminalOutput(host.term, data, {
            ...policy,
            onParsed: () => {
              if (!host.disposed) host.inputVisibility.onOutputParsed();
            },
          });
        }),
      );
      host.cleanups.push(() => discardTerminalOutput(host.term));
      host.cleanups.push(
        window.nexus.pty.onExit(res.sessionId, ({ exitCode }) => {
          const staleExactResume =
            resume &&
            !missionId &&
            !resumeLatestOnly &&
            res.resumeMode === 'exact' &&
            exitCode !== 0 &&
            Date.now() - spawnedAt < 10_000;
          if (staleExactResume) {
            // The CLI validates provider conversation ids only after spawn, so
            // main cannot know synchronously that a captured id expired. Fall
            // back once to the adapter's latest-session command.
            const staleSessionId = res.sessionId;
            reportPaneResumeIncident(
              pane,
              'stale-exact-id',
              'O ID exato expirou; tentando uma única retomada pela conversa mais recente.',
              true,
            );
            setTimeout(() => {
              if (host.disposed || host.sessionId !== staleSessionId) return;
              host.cleanups.forEach((cleanup) => cleanup());
              host.cleanups = [];
              setHostSession(host, pane.id, null);
              host.spawnStarted = false;
              host.term.writeln(
                '\r\n\x1b[33m[nexus] ID exato expirou — tentando a conversa mais recente…\x1b[0m',
              );
              void startSpawn(pane, host, true, true);
            }, 0);
            return;
          }
          const failedMissionExactResume =
            resume &&
            Boolean(missionId) &&
            res.resumeMode === 'exact' &&
            exitCode !== 0 &&
            Date.now() - spawnedAt < 10_000;
          if (failedMissionExactResume) {
            reportPaneResumeIncident(
              pane,
              'resume-fallback-failed',
              'A sessão exata desta missão não pôde ser recuperada. O Nexus não abriu a conversa mais recente de outro pane.',
              false,
            );
          }
          const failedFallback =
            resume &&
            exitCode !== 0 &&
            Date.now() - spawnedAt < 10_000 &&
            (resumeLatestOnly || res.resumeMode === 'latest');
          setHostSession(host, pane.id, null);
          // Latch solto: sem isto o host fica em exited eterno e o teclado
          // morre em silêncio (onData early-return quando sessionId=null).
          host.spawnStarted = false;
          if (failedFallback) {
            reportPaneResumeIncident(
              pane,
              'resume-fallback-failed',
              'A conversa exata e a conversa mais recente não puderam ser recuperadas. O pane foi preservado e o retry automático foi encerrado.',
              false,
            );
            host.term.writeln(
              '\r\n\x1b[31m[nexus doctor] recuperação esgotada sem loop; inicie uma nova sessão neste pane.\x1b[0m',
            );
          }
          // Linha própria com \r\n em ambos os lados: o aviso de backlog 2 MB
          // pode cair no meio do buffer e colar "process exited" com "output
          // because the backlog…" (print do operador 2026-08-07 HiperGO).
          host.term.writeln(
            `\r\n\x1b[90m[nexus] process exited (code ${exitCode})\x1b[0m`,
          );
          useSessionStateStore.getState().setPaneState(pane.id, 'exited');
          if (missionStillOwnsPane(pane.id, pane)) {
            host.term.writeln(
              '\x1b[33m[nexus] a missão ainda é dona deste pane — use o rail para retomar, ou espere o próximo despacho.\x1b[0m',
            );
          } else {
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
      // when the adapter actually restored something.
      const shouldInjectContinue =
        Boolean(continuityPack) ||
        (resume && !res.adopted && res.resumeMode !== 'unsupported');
      if (shouldInjectContinue) {
        const resumedSessionId = res.sessionId;
        const continuationTimer = setTimeout(() => {
          if (host.disposed || host.sessionId !== resumedSessionId) return;
          const role = pane.role === 'orchestrator' ? 'orchestrator' : 'agent';
          const continuation =
            continuityPack ??
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
              continuityPack
                ? '\r\n\x1b[36m[nexus] handoff multi-conta submetido (sessão nova nesta conta).\x1b[0m'
                : '\r\n\x1b[36m[nexus] continuidade submetida automaticamente ao agente.\x1b[0m',
            );
          }
        }, 1_800);
        host.cleanups.push(() => clearTimeout(continuationTimer));
      }
      const input = host.term.onData((data) => {
        // xterm does not locally echo: the PTY/TUI sends the visible composer
        // back. Return to live output before the key leaves the renderer.
        host.inputVisibility.onUserInput();
        if (host.opened) webglPool.touch(pane.id);
        flushTerminalOutput(host.term);
        if (!host.sessionId) {
          // Cadáver de missão/CLI: tecla era no-op e o operador lia "travado".
          // Missão terminal (done/failed) ou pane sem missão viva → shell.
          if (
            paneState(pane.id) === 'exited' &&
            !host.spawnStarted &&
            !missionStillOwnsPane(pane.id, pane)
          ) {
            void reclaimExitedPaneAsShell(pane, host);
          }
          return;
        }
        // Pane de missão não aceita escrita do renderer — a posse é do main.
        // O teclado do operador entra pedindo, não escrevendo: sem esse desvio
        // a tecla era descartada em silêncio e o terminal parecia morto.
        // O vínculo vem do orchStore quando o pane restaurado chega sem ele.
        if (pane.kind === 'cli-agent' && missionId) {
          void window.nexus.orch.sendPaneOperatorInput({
            sessionId: host.sessionId,
            data,
          });
          return;
        }
        window.nexus.pty.write(host.sessionId, data);
      });
      host.cleanups.push(() => input.dispose());
      return res.sessionId;
    } catch (err) {
      if (host.disposed || host.spawnGeneration !== generation) return null;
      const message = err instanceof Error ? err.message : String(err);
      host.term.writeln(
        `\r\n\x1b[31m[nexus] failed to start: ${message}\x1b[0m`,
      );
      useSessionStateStore.getState().setPaneState(pane.id, 'exited');
      return null;
    }
  })();
}

/**
 * Debounced fit-on-resize. An interactive node resize (or a canvas pan that
 * re-parents the terminal) fires the ResizeObserver in a tight burst; calling
 * fit()+pty.resize on each frame floods the child with SIGWINCH and thrashes
 * the renderer (the resize storm Maestri hit). Coalesce to one fit ~60ms after
 * the last resize.
 */
const RESIZE_DEBOUNCE_MS = 60;

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
        return;
      }
      try {
        host.fit.fit();
      } catch {
        return;
      }
      // Primeira medição real do slot: é aqui que o replay pendente entra, já
      // na largura certa.
      flushPendingScrollback(host);
      propagateHostSize(host);
    }, RESIZE_DEBOUNCE_MS);
  });
}

/** Re-measure every live terminal: fit, propagate cols/rows, repaint. */
function refitAllHosts(): void {
  for (const host of hosts.values()) {
    if (host.disposed || !host.opened) continue;
    try {
      host.fit.fit();
    } catch {
      continue; // Not measurable right now; the ResizeObserver will settle it.
    }
    flushPendingScrollback(host);
    propagateHostSize(host);
    try {
      host.term.refresh(0, Math.max(0, host.term.rows - 1));
    } catch {
      // The next PTY write repaints.
    }
  }
}

let refitAllTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefitAll(): void {
  if (refitAllTimer) clearTimeout(refitAllTimer);
  refitAllTimer = setTimeout(() => {
    refitAllTimer = null;
    refitAllHosts();
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
  window.addEventListener('resize', scheduleRefitAll);
  if (typeof window.matchMedia !== 'function') return;
  let media: MediaQueryList | null = null;
  const onChange = (): void => {
    scheduleRefitAll();
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
    term,
    fit,
    search,
    serialize,
    ro: null as unknown as ResizeObserver,
    sessionId: null,
    reportedGrid: null,
    isVisible: true,
    spawnGeneration: 0,
    opened: false,
    spawnStarted: false,
    hibernated: false,
    disposed: false,
    inputVisibility,
    cleanups: [],
  };

  host.ro = makeResizeObserver(pane.id, host);
  host.ro.observe(element);

  term.onTitleChange((title) =>
    useLayoutStore.getState().setTitle(pane.id, title),
  );
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
    term,
    fit,
    search,
    serialize,
    ro: null as unknown as ResizeObserver,
    sessionId: null,
    reportedGrid: null,
    isVisible: true,
    spawnGeneration: 0,
    opened: false,
    spawnStarted: false,
    hibernated: false,
    disposed: false,
    inputVisibility,
    cleanups: [],
  };

  host.ro = makeResizeObserver(pane.id, host);
  host.ro.observe(element);

  term.onTitleChange((title) =>
    useLayoutStore.getState().setTitle(pane.id, title),
  );
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

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Save a pasted/dropped binary blob into ~/.nexus/dropped, inject its path. */
async function injectSavedBlob(host: Host, file: File): Promise<void> {
  try {
    const base64 = bufferToBase64(await file.arrayBuffer());
    const res = await window.nexus.files.saveDropped(file.name || 'pasted', base64);
    if (res.ok && res.path && host.sessionId) {
      window.nexus.pty.write(host.sessionId, `${shellQuote(res.path)} `);
    }
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

  // Native wheel scrolling can update xterm's viewport without emitting an
  // onScroll notification on some Chromium/compositor paths. Sample the
  // authoritative buffer after the wheel frame so the history cue and the
  // next-input jump never depend on that notification alone.
  element.addEventListener(
    'wheel',
    () => {
      requestAnimationFrame(() => {
        if (host.disposed) return;
        host.inputVisibility.onScroll(
          term.buffer.active.viewportY,
          term.buffer.active.baseY,
        );
      });
    },
    { passive: true },
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

  element.addEventListener(
    'paste',
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          e.preventDefault();
          const file = items[i].getAsFile();
          if (file) void injectSavedBlob(host, file);
          return;
        }
      }
      // Plain text → let xterm's native paste handle it.
    },
    true,
  );

  element.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  element.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const p = window.nexus.files.pathForFile(files[i]);
      if (p) paths.push(p);
    }
    if (paths.length > 0 && host.sessionId) {
      window.nexus.pty.write(
        host.sessionId,
        paths.map(shellQuote).join(' ') + ' ',
      );
    } else {
      // No real path (e.g. an image dragged from a browser) → save + inject.
      for (let i = 0; i < files.length; i++) void injectSavedBlob(host, files[i]);
    }
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

  if (useLayoutStore.getState().focusedPaneId !== pane.id) {
    try {
      host.fit.fit();
      flushPendingScrollback(host);
      propagateHostSize(host);
    } catch {
      // Slot not measurable yet; the ResizeObserver will retry.
    }
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
          host.term.writeln(
            '\r\n  [Nexus] Agente em pausa — a sessão anterior NÃO foi ' +
              'reiniciada automaticamente.\r\n' +
              '  Confirme o diálogo ou retome a missão no rail quando quiser.\r\n',
          );
        } catch {
          // xterm may not be ready; ignore.
        }
      }
      return;
    }
    void startSpawn(
      pane,
      host,
      resumeOnFirstSpawn.delete(pane.id),
      false,
      undefined,
      restoreAuthorityOnFirstSpawn.delete(pane.id),
    );
  }
}

/**
 * Panes flagged here spawn their FIRST session with the adapter's resume
 * flags (claude --resume etc.). Consumed on spawn — transient by design, so
 * the flag never persists into the saved layout. Used by the mission reopen
 * flow: mark before setPanes(), and every restored CLI continues its
 * previous conversation.
 */
const resumeOnFirstSpawn = new Set<string>();
const restoreAuthorityOnFirstSpawn = new Set<string>();
/** Restored agents held until the user confirms resume (no silent auto-work). */
const heldSpawnPanes = new Set<string>();

export function markResumeOnSpawn(paneId: string): void {
  // Intentional resume (reopen mission / user confirmed) always clears a hold.
  heldSpawnPanes.delete(paneId);
  resumeOnFirstSpawn.add(paneId);
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
  resumeOnFirstSpawn.delete(paneId);
}

export function isSpawnHeld(paneId: string): boolean {
  return heldSpawnPanes.has(paneId);
}

/** Forget every renderer-local spawn intent before pruning an orphan leaf. */
export function discardPaneSpawnState(paneId: string): void {
  heldSpawnPanes.delete(paneId);
  resumeOnFirstSpawn.delete(paneId);
  restoreAuthorityOnFirstSpawn.delete(paneId);
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
      resumeOnFirstSpawn.add(paneId);
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
  void startSpawn(
    pane,
    host,
    resumeOnFirstSpawn.delete(paneId),
    false,
    undefined,
    restoreAuthorityOnFirstSpawn.delete(paneId),
  );
}

function listPanesFromLayout(): readonly PaneModel[] {
  return listPanes(useLayoutStore.getState().root);
}

/** Mark a missing mission pane to start fresh with its persisted authority. */
export function markPersistedAuthorityOnSpawn(paneId: string): void {
  restoreAuthorityOnFirstSpawn.add(paneId);
  heldSpawnPanes.delete(paneId);
  unlockExitedSessionlessHost(paneId);
  kickHeldSpawnIfReady(paneId);
}

// Conservative fallback until restore-agents-gate installs the product policy.
// The installed handler auto-resumes main-owned mission panes and asks only for
// standalone agents.
setRestoredPanesHandler((panes) => {
  for (const pane of panes) {
    if (pane.kind === 'cli-agent') holdSpawnUntilApproved(pane.id);
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
    return;
  }
  if (!host.opened) return;
  resumeTerminalOutput(host.term);
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
    resumeTerminalOutput(host.term);
    if (paneId === focusedPaneId) {
      requestAnimationFrame(() => focusHost(paneId));
    }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', handleDocumentVisibilityChange);
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
  // Resume WebGL rendering if it was evicted while hidden.
  resumeVisibleHost(paneId, host);
  // Force a full repaint of the visible area.
  host.term.refresh(0, host.term.rows - 1);
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
  // Vínculo órfão (missão sumiu do store) ou missão terminal: operador reclama.
  if (!mission) return false;
  return mission.status === 'running' || mission.status === 'blocked';
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
): Promise<void> {
  if (host.disposed || host.sessionId || host.spawnStarted) return;
  if (missionStillOwnsPane(pane.id, pane)) return;
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
  },
): void {
  const host = hosts.get(pane.id);
  if (!host || host.disposed) return;
  if (isMainControlledMissionPane(pane.id, pane)) {
    // Numa missão bloqueada, "Reiniciar" É a intenção de retomar — encaminha
    // para o caminho sancionado em vez de repetir a recusa até virar spam.
    const missionId =
      pane.missionId ?? useOrchStore.getState().paneMissions[pane.id];
    void (async () => {
      const routed = missionId
        ? await routeBlockedMissionToResume(host, missionId, { manual: true })
        : false;
      if (!routed) {
        reportMainOwnedLifecycleOnly(host, 'Reiniciar ou trocar conta');
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
    reportMainOwnedLifecycleOnly(host, 'Acordar/recriar');
    return false;
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

/** The live PTY session id backing a pane, or null if not spawned yet. */
export function getPaneSessionId(paneId: string): string | null {
  return hosts.get(paneId)?.sessionId ?? null;
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
  let pendingSpawn: Promise<string | null> | null = null;
  const pane = listPanes(useLayoutStore.getState().root).find(
    (candidate) => candidate.id === paneId,
  );
  if (pane?.kind === 'shell' && pane.isStructuralPlaceholder !== true) {
    const host = getOrCreateHost(pane);
    if (!host.spawnStarted && !host.hibernated) {
      pendingSpawn = startSpawn(
        pane,
        host,
        resumeOnFirstSpawn.delete(pane.id),
        false,
        undefined,
        restoreAuthorityOnFirstSpawn.delete(pane.id),
      );
    }
  }
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
    void pendingSpawn?.then((sessionId) => {
      if (!sessionId) finish(null);
    });
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
  const sessionId = getPaneSessionId(paneId);
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
    void window.nexus.orch.sendPaneOperatorInput({ sessionId, data });
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
    getSessionId: getPaneSessionId,
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
    getSessionId: getPaneSessionId,
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
    getSessionId: getPaneSessionId,
    operatorWrite: (sessionId, data) =>
      window.nexus.orch.sendPaneOperatorInput({ sessionId, data }),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  });
}

function disposeHost(host: Host, paneId: string): void {
  host.disposed = true;
  host.inputVisibility.dispose();
  webglPool.unregister(paneId);
  host.ro.disconnect();
  host.cleanups.forEach((fn) => fn());
  if (host.sessionId) window.nexus.pty.kill(host.sessionId);
  host.term.dispose();
  host.element.remove();
  useSessionStateStore.getState().clearPaneState(paneId);
}

/** Dispose every terminal whose pane id is no longer present in the layout. */
export function reconcileHosts(liveIds: Set<string>): void {
  for (const [id, host] of hosts) {
    if (!liveIds.has(id)) {
      disposeHost(host, id);
      hosts.delete(id);
    }
  }
}
