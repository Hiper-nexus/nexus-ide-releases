import path from 'node:path';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  PET_CHANNELS,
  isPetUrgentEvent,
  sanitizePetPrefsPatch,
  type PetEvent,
  type PetPlacement,
  type PetPrefs,
  type PetRoamState,
} from '../../shared/pet-types';
import { RENDERER_PROTOCOL_ENTRY_URL } from '../renderer-protocol';
import { getAgentSessionInfo, tapSessionState } from '../pty/pty-manager';
import { tapMissionsBroadcast, tapMissionsSeed } from '../orch/orch-ipc';
import { loadPetPrefs, savePetPrefs } from './pet-prefs';
import {
  bestPetParkPosition,
  clampPetCoveredByDisplays,
  clampPetDrag,
  EDGE_OVERHANG_SETTLE,
  isWithinPetOverhang,
  snapPetToCursorEdges,
  windowIntersectsOffDisplay,
  type Rect,
} from './pet-geometry';
import {
  AgentAttentionTracker,
  AgentTransitionTracker,
  MissionTransitionTracker,
} from './pet-events';
import {
  DIGEST_WINDOW_MS,
  admitPetEvent,
  createAttentionPolicyState,
  type AttentionDecision,
  type AttentionPolicyState,
} from './pet-attention-policy';
import { tapAgentHookStatus } from '../agent-hooks/hook-ingest';
import {
  petActionForAppFullscreenEvent,
  petWorkspacePinForFullscreenEvent,
  shouldKeepPetFullscreenSilence,
  shouldRaisePetAboveAll,
  type PetWorkspacePin,
} from './pet-fullscreen-guard';
import { computeLookDir } from './pet-look';
import {
  pickRoamDestination,
  roamStep,
  ROAM_PAUSE_MAX_MS,
  ROAM_PAUSE_MIN_MS,
  ROAM_SPRINT_CHANCE,
  ROAM_SPRINT_FACTOR,
  ROAM_WALK_SPEED_PX_S,
} from './pet-roam';
import { PetLifetimeTracker } from './pet-stats';
import { USAGE_CHANNELS } from '../../shared/usage-types';
import { tapUsageSnapshot } from '../usage/usage-service';
import { copyHatchImage } from './pet-hatch-image';
import { fetchGalleryCatalog, importGalleryPet } from './pet-gallery';
import { listPetLibrary, loadLibrarySheet } from './pet-library';
import {
  deleteInstalledPet,
  listInstalledPets,
  loadInstalledPet,
} from './pet-installed';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';

/**
 * Desktop pet: uma janela transparente, sempre-no-topo e fora da taskbar que
 * flutua sobre o desktop com o mascote pixel. Click-through por padrão — o
 * renderer avisa quando o cursor está sobre o sprite/balão e só então a
 * janela aceita mouse. Opt-in (prefs.enabled), vive apenas enquanto houver
 * uma janela principal, e dorme sob demanda (sem balões).
 */

/**
 * Janela do companion: sprite compacto (~120px) no rodapé, mas área
 * suficiente para balões de intervenção com título + detalhe + 2 botões
 * sem ellipsis. (180×220 + max-width 160 + line-clamp:2 cortava mensagens.)
 */
export const PET_WINDOW_SIZE = { width: 300, height: 340 } as const;
/**
 * Motor de arrasto. Log no boot: se não aparecer, o main é código velho.
 * compositor-v10 = janela normal pequena, canvas recortado/persistente e
 * bounds físicos forçados depois do load (sem coordenadas divergentes de panel).
 */
export const PET_DRAG_ENGINE = 'compositor-v10';
/**
 * Cadência do arrasto (ms). 8 ms acompanha 120 Hz; o WindowServer faz o
 * coalescing natural em monitores de 60/75 Hz. Como o caminho quente usa só
 * setPosition, não há resize/repaint da superfície a cada amostra.
 */
const DRAG_TICK_MS = 8;
/** Teto de um arrasto: além disso o watchdog assenta a janela sozinho. */
// Teto do watchdog: é o resgate quando o pointerup se perde de vez — 30s
// deixava o pet "grudado no mouse" por meio minuto. O fim normal do drag vem
// do pointerup/lostpointercapture do renderer; 10s cobre qualquer arrasto
// legítimo entre monitores.
const DRAG_MAX_MS = 10_000;
/** Cadência do look (cursor → direção do olhar). 16 passos não pedem 60fps. */
const LOOK_TICK_MS = 180;
/** Cursor parado além disso = o pet volta a digitar (idle). */
const LOOK_CURSOR_IDLE_MAX_MS = 4_000;
/** Tempo mínimo numa direção antes de enviar (anti-piscar look N↔N+1 / idle). */
const LOOK_DWELL_MS = 320;

let petWindow: BrowserWindow | null = null;
let prefs: PetPrefs | null = null;
let dragTimer: NodeJS.Timeout | null = null;
/** Origem do arrasto em coordenadas de ecrã (delta fiável, sem clientX). */
let dragOrigin: {
  winX: number;
  winY: number;
  cursorX: number;
  cursorY: number;
} | null = null;
/** Última posição aplicada durante o arrasto — settle usa isto, não getPosition. */
let lastDragPos: { x: number; y: number } | null = null;
let initialized = false;
let lookTimer: NodeJS.Timeout | null = null;
let lookLastSent: number | null = null;
/** Candidato ainda não confirmado por dwell (evita piscar a cada tick). */
let lookPending: number | null = null;
let lookPendingSince = 0;
let lookLastCursor = { x: 0, y: 0 };
let lookLastMoveAt = 0;
/** Cache: setIgnoreMouseEvents é caro e a alternar no canto pisca o compositor. */
let petIgnoresMouse = true;
/**
 * Silêncio de fullscreen no macOS: hide() sem desligar o pin ainda deixa o
 * pet (visibleOnAllWorkspaces + alwaysOnTop) na coleção de Spaces. Latch
 * do enter até o re-pin do leave; enquanto isFullScreen() no Darwin, nenhum
 * raise/assert/showInactive. Re-pin só depois da animação de saída.
 */
let fullscreenGuardUntil = 0;
let fullscreenSilenceLatched = false;
let fullscreenRepinTimer: NodeJS.Timeout | null = null;
const FULLSCREEN_GUARD_MS = 2_400;
const FULLSCREEN_REPIN_DELAY_MS = 2_600;

function inFullscreenTransition(): boolean {
  return shouldKeepPetFullscreenSilence({
    platform: process.platform,
    appIsFullScreen: mainAppIsFullScreen(),
    silenceLatched:
      fullscreenSilenceLatched || Date.now() < fullscreenGuardUntil,
  });
}

function petRaiseAllowed(): boolean {
  return shouldRaisePetAboveAll({
    platform: process.platform,
    inFullscreenTransition: inFullscreenTransition(),
    appIsFullScreen: mainAppIsFullScreen(),
  });
}

/** Cache do nível alwaysOnTop — evita setAlwaysOnTop/moveTop em spam (pisca). */
let petPinnedTop = false;
let lastRaiseAt = 0;
let reclampTimer: NodeJS.Timeout | null = null;
/**
 * Perto da borda: força look=null (idle estável). Congelar a última direção
 * ainda faz o sheet “tremer” se bounds subpixel mudam o frame de look.
 */
const LOOK_EDGE_FREEZE_PX = 64;
/** Mínimo entre re-pins de z-order (ms) — spam de setAlwaysOnTop pisca no macOS. */
const RAISE_DEBOUNCE_MS = 1_200;
/** Watch só se o SO demover o flag alwaysOnTop (não re-pin preventivo). */
const RAISE_WATCH_MS = 5_000;
/** Renderer do pet pronto após o handshake feito com onEvent já registrado. */
let petReady = false;
/** Eventos enfileirados até o pet carregar — evita balão perdido no boot. */
const pendingPetEvents: PetEvent[] = [];
const PENDING_PET_EVENT_LIMIT = 12;

const agentTracker = new AgentTransitionTracker();
const attentionTracker = new AgentAttentionTracker();
const missionTracker = new MissionTransitionTracker();
let attentionPolicy: AttentionPolicyState = createAttentionPolicyState();
let digestTimer: NodeJS.Timeout | null = null;

// ── Patrulha autônoma ("andar em todos os cantos") ─────────────────────
/** Cadência do passo da patrulha — 30 fps bastam para andar ~4 px/tick. */
const ROAM_TICK_MS = 33;
let roamTimer: NodeJS.Timeout | null = null;
let roamTarget: { x: number; y: number } | null = null;
/** Fim da pausa parado; enquanto now < pauseUntil o pet descansa no lugar. */
let roamPauseUntil = 0;
let roamSprint = false;
let roamLastDir: 'left' | 'right' = 'right';
let roamLastSent: PetRoamState = { phase: 'idle', dir: null, climb: null };
/** Veto do renderer (balão/menu/arrasto/reduced-motion/sleeping). */
let roamRendererHold = false;
let roamLastPlacementAt = 0;

// ── Contadores de vida útil (tokens/USD/panes — o HUD gamificado) ──────
let petStats: PetLifetimeTracker | null = null;
let statsPushTimer: NodeJS.Timeout | null = null;
let statsFlushTimer: NodeJS.Timeout | null = null;
const STATS_PUSH_DEBOUNCE_MS = 1_500;
const STATS_FLUSH_MS = 20_000;

function getPetStats(): PetLifetimeTracker {
  petStats ??= new PetLifetimeTracker(userDataDir());
  return petStats;
}

function pushPetStats(): void {
  if (statsPushTimer) return;
  statsPushTimer = setTimeout(() => {
    statsPushTimer = null;
    if (!petWindow || petWindow.isDestroyed() || !petReady) return;
    petWindow.webContents.send(PET_CHANNELS.stats, getPetStats().stats());
  }, STATS_PUSH_DEBOUNCE_MS);
}

function userDataDir(): string {
  return app.getPath('userData');
}

function getPrefs(): PetPrefs {
  prefs ??= loadPetPrefs(userDataDir());
  return prefs;
}

export function isPetWindow(win: BrowserWindow): boolean {
  // Durante o construtor do pet (evento síncrono), petWindow ainda é null —
  // o flag garante que a janela meio-construída nunca conte como app window.
  if (creatingPetWindow) return true;
  return petWindow !== null && win.id === petWindow.id;
}

/** Janelas "de app" = tudo que não é o pet. O pet nunca segura o app vivo. */
function mainAppWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !isPetWindow(win) && !win.isDestroyed(),
  );
}

function mainAppIsFullScreen(): boolean {
  return mainAppWindows().some((win) => {
    try {
      return win.isFullScreen();
    } catch {
      return false;
    }
  });
}

function petUrl(): string {
  const devServerUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  if (devServerUrl) return new URL('/pet.html', devServerUrl).toString();
  return RENDERER_PROTOCOL_ENTRY_URL.replace(/index\.html$/, 'pet.html');
}

/** Bounds das janelas de app (não-pet) — obstáculos para estacionar o companion. */
function mainWindowObstacles(): Rect[] {
  const out: Rect[] = [];
  for (const win of mainAppWindows()) {
    if (win.isMinimized()) continue;
    try {
      const b = win.getBounds();
      if (b.width > 0 && b.height > 0) out.push(b);
    } catch {
      // janela a fechar
    }
  }
  return out;
}

/**
 * WorkArea onde estacionar: display da janela principal (ou a focada),
 * não o primary cego — multi-monitor com IDE no ecrã externo.
 */
function parkWorkArea(): Rect {
  const mains = mainAppWindows();
  // Preferir focused; senão a primeira visível.
  const preferred =
    mains.find((w) => {
      try {
        return w.isFocused();
      } catch {
        return false;
      }
    }) ?? mains[0];
  if (preferred) {
    try {
      return screen.getDisplayMatching(preferred.getBounds()).workArea;
    } catch {
      // fall through
    }
  }
  return screen.getPrimaryDisplay().workArea;
}

function defaultPosition(): { x: number; y: number } {
  // Preferir canto com menos overlap com o IDE (BR primeiro → não tapa explorer).
  return bestPetParkPosition(
    PET_WINDOW_SIZE,
    parkWorkArea(),
    mainWindowObstacles(),
  );
}

function restoredPosition(): { x: number; y: number } {
  const saved = getPrefs().position;
  if (
    !saved ||
    !Number.isFinite(saved.x) ||
    !Number.isFinite(saved.y)
  ) {
    return defaultPosition();
  }
  // O display salvo pode ter sido desconectado: clampa para os bounds do
  // display mais próximo. O utilizador pode escolher qualquer canto real —
  // inclusive colado na menubar/Dock (o pet flutua acima deles).
  const display = screen.getDisplayMatching({
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
  });
  const clamped = clampPetDrag(
    { x: Math.round(saved.x), y: Math.round(saved.y) },
    PET_WINDOW_SIZE,
    display.bounds,
    EDGE_OVERHANG_SETTLE,
  );
  // Uma posição já salva é escolha explícita do utilizador. Não re-estacionar
  // por cima dela no boot, mesmo que fique sobre a lateral do IDE.
  return clamped;
}

function broadcastPrefs(): void {
  const current = getPrefs();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isCrashed()) {
      win.webContents.send(PET_CHANNELS.prefsChanged, current);
    }
  }
}

function broadcastAttentionToMain(event: PetEvent): void {
  for (const win of mainAppWindows()) {
    if (!win.isDestroyed() && !win.webContents.isCrashed()) {
      win.webContents.send(PET_CHANNELS.attention, event);
    }
  }
}

function deliverToPetWindow(event: PetEvent): void {
  if (!petWindow || petWindow.isDestroyed() || petWindow.webContents.isCrashed()) {
    return;
  }
  if (isPetUrgentEvent(event.kind)) {
    // Traz o companion à frente sem roubar o foco do terminal (focusable:false).
    raisePetAboveAll(true);
  }
  petWindow.webContents.send(PET_CHANNELS.event, event);
}

function flushPendingPetEvents(): void {
  if (!petReady || !petWindow || petWindow.isDestroyed()) return;
  const batch = pendingPetEvents.splice(0, pendingPetEvents.length);
  for (const event of batch) deliverToPetWindow(event);
}

function enqueuePendingPetEvent(event: PetEvent): void {
  pendingPetEvents.push(event);
  while (pendingPetEvents.length > PENDING_PET_EVENT_LIMIT) {
    pendingPetEvents.shift();
  }
}

function applyAttentionDecision(decision: AttentionDecision): void {
  const current = getPrefs();
  const urgent = isPetUrgentEvent(decision.event.kind);
  // Dormindo: só interrompe para intervenção humana.
  if (current.sleeping && !urgent) return;

  if (decision.mirrorMain) {
    broadcastAttentionToMain(decision.event);
  }

  if (!decision.deliverPet) return;
  // Pet desligado: toast (se mirrorMain) basta — presença é opt-in.
  if (!current.enabled) return;

  if (!petWindow || petWindow.isDestroyed()) {
    if (mainAppWindows().length === 0) return;
    createPetWindow();
  }
  if (!petReady || !petWindow || petWindow.isDestroyed()) {
    enqueuePendingPetEvent(decision.event);
    return;
  }
  deliverToPetWindow(decision.event);
}

function scheduleDigestFlush(): void {
  if (digestTimer) return;
  digestTimer = setTimeout(() => {
    digestTimer = null;
    const result = admitPetEvent(
      attentionPolicy,
      { kind: 'agent-idle', title: '', at: Date.now() },
      Date.now(),
      { flushDigest: true },
    );
    attentionPolicy = result.state;
    for (const decision of result.flushed) applyAttentionDecision(decision);
  }, DIGEST_WINDOW_MS);
}

/**
 * Porta única de saída para o companion: trackers emitem transições; a política
 * de atenção decide se vira balão, toast, digest ou silêncio (anti-spam em
 * frota grande).
 */
function sendPetEvent(event: PetEvent): void {
  const now = Date.now();
  // Entregas reais alimentam o contador de missões do HUD do companion.
  if (event.kind === 'mission-done' || event.kind === 'goal-finished') {
    getPetStats().recordMissionDone();
    pushPetStats();
  }
  const result = admitPetEvent(attentionPolicy, event, now);
  attentionPolicy = result.state;
  if (result.scheduleDigest) scheduleDigestFlush();
  if (result.immediate) applyAttentionDecision(result.immediate);
  for (const decision of result.flushed) applyAttentionDecision(decision);
}

export function broadcastPetEvent(event: PetEvent): void {
  sendPetEvent(event);
}

function stopDrag(): void {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  dragOrigin = null;
}

/**
 * Click-through do companion.
 * - ignore=true + forward: rato atravessa, mas o renderer ainda recebe
 *   mousemove (para mouseenter/leave no sprite).
 * - force=true: reaplicar no OS mesmo se o cache coincidir — após
 *   showInactive/raise o AppKit por vezes perde o forward e o pet fica
 *   “de vidro” (visível, não clicável) até toggle.
 */
function applyIgnoreMouseEvents(ignore: boolean, force = false): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!force && petIgnoresMouse === ignore) return;
  petIgnoresMouse = ignore;
  try {
    petWindow.setIgnoreMouseEvents(ignore, { forward: true });
  } catch {
    try {
      petWindow.setIgnoreMouseEvents(ignore);
    } catch {
      // ignore
    }
  }
}

/**
 * Mantém o pet acima de outras janelas (cross-OS).
 *
 * Senior notes:
 * - `floating` fica abaixo do Dock e perde para muitas apps → `screen-saver`.
 * - setAlwaysOnTop/moveTop/setVisibleOnAllWorkspaces em spam recompõe a
 *   superfície transparente no macOS e **pisca nos cantos**. Por isso:
 *   debounce + só re-pin quando o flag caiu (ou force=true no boot/urgent).
 */
function applyPetWorkspacePin(pin: PetWorkspacePin): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  try {
    if (process.platform === 'darwin') {
      // skipTransformProcessType: sem isto o Electron vira UIElement e o
      // ícone do Dock some. visibleOnFullScreen fica sempre off — o pet
      // não acompanha o Space de tela cheia.
      petWindow.setVisibleOnAllWorkspaces(pin.visibleOnAllWorkspaces, {
        visibleOnFullScreen: pin.visibleOnFullScreen,
        skipTransformProcessType: true,
      });
    } else {
      petWindow.setVisibleOnAllWorkspaces(pin.visibleOnAllWorkspaces);
    }
  } catch (error) {
    // Never use the option-less fallback on macOS: Electron documents that it
    // transforms the process type and briefly hides both the Dock and window.
    if (process.platform !== 'darwin') {
      try {
        petWindow.setVisibleOnAllWorkspaces(pin.visibleOnAllWorkspaces);
      } catch {
        // Best effort on window managers without all-workspaces support.
      }
    } else {
      console.warn('[pet] all-workspaces pin unavailable:', error);
    }
  }
  try {
    if (pin.alwaysOnTop) {
      try {
        petWindow.setAlwaysOnTop(true, 'screen-saver', 1);
      } catch {
        try {
          petWindow.setAlwaysOnTop(true, 'screen-saver');
        } catch {
          petWindow.setAlwaysOnTop(true);
        }
      }
    } else {
      petWindow.setAlwaysOnTop(false);
    }
  } catch {
    // ignore
  }
  petPinnedTop = pin.alwaysOnTop;
}

function raisePetAboveAll(force = false): void {
  if (!petRaiseAllowed()) return;
  if (!petWindow || petWindow.isDestroyed()) return;
  const now = Date.now();
  const demoted = !petWindow.isAlwaysOnTop() || !petPinnedTop;
  if (!force && !demoted) return;
  if (!force && now - lastRaiseAt < RAISE_DEBOUNCE_MS) return;
  lastRaiseAt = now;

  applyPetWorkspacePin(petWorkspacePinForFullscreenEvent('leave-full-screen'));
  // moveTop só quando demovido — a cada tick recompõe e pisca.
  if (force || demoted) {
    petWindow.moveTop();
  }
  if (!petWindow.isVisible()) {
    petWindow.showInactive();
  }
  // show/moveTop no macOS por vezes dropa o forward do ignore-mouse → pet de vidro.
  if (force || demoted) {
    applyIgnoreMouseEvents(petIgnoresMouse, true);
  }
}

let raiseTimer: NodeJS.Timeout | null = null;

function startRaiseWatch(): void {
  stopRaiseWatch();
  // Só reage se o SO demover o flag — re-pin preventivo a cada N ms pisca.
  raiseTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) {
      stopRaiseWatch();
      return;
    }
    if (!getPrefs().enabled) return;
    if (!petRaiseAllowed()) return;
    if (!petWindow.isAlwaysOnTop()) {
      petPinnedTop = false;
      raisePetAboveAll(true);
    }
  }, RAISE_WATCH_MS);
}

function stopRaiseWatch(): void {
  if (raiseTimer) {
    clearInterval(raiseTimer);
    raiseTimer = null;
  }
}

/**
 * Move sem redimensionar a superfície transparente.
 *
 * `setBounds` no caminho quente do drag fazia o WindowServer recompor a
 * textura inteira a cada tick. Na costura entre monitores (especialmente com
 * DPI/Hz diferentes) isso aparecia como pet duplicado, piscando e atrasado.
 * `setPosition` preserva a mesma superfície GPU e deixa o compositor apenas
 * deslocá-la. `setBounds` fica restrito à recuperação rara de tamanho.
 */
function setPetBounds(
  pos: { x: number; y: number },
  exact = false,
): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const [cx, cy] = petWindow.getPosition();
  const [cw, ch] = petWindow.getSize();
  const sizeIsCorrect =
    cw === PET_WINDOW_SIZE.width && ch === PET_WINDOW_SIZE.height;
  if (!exact && cx === pos.x && cy === pos.y && sizeIsCorrect) return;

  if (!exact && sizeIsCorrect) {
    petWindow.setPosition(pos.x, pos.y, false);
    return;
  }

  petWindow.setBounds({
    x: pos.x,
    y: pos.y,
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
  });
}

function stopLookLoop(): void {
  if (lookTimer) {
    clearInterval(lookTimer);
    lookTimer = null;
  }
  lookLastSent = null;
  lookPending = null;
  lookPendingSince = 0;
}

// ── Patrulha autônoma ───────────────────────────────────────────────────
// A janela anda de verdade (setPosition a cada tick) enquanto o renderer
// toca run-left/right — ou gira o sprite 90° quando a subida domina.
// Vetos: arrasto, sono, balão/menu (roamHold do renderer), fullscreen do
// app, pet ainda não pronto e a flag prefs.roam.

function sendRoamState(state: PetRoamState): void {
  const same =
    state.phase === roamLastSent.phase &&
    state.dir === roamLastSent.dir &&
    state.climb === roamLastSent.climb;
  if (same) return;
  roamLastSent = state;
  if (petWindow && !petWindow.isDestroyed() && !petWindow.webContents.isCrashed()) {
    petWindow.webContents.send(PET_CHANNELS.roam, state);
  }
}

function roamBlocked(): boolean {
  const p = getPrefs();
  return (
    !p.enabled ||
    !p.roam ||
    p.sleeping ||
    roamRendererHold ||
    !petReady ||
    dragTimer !== null ||
    inFullscreenTransition() ||
    !petWindow ||
    petWindow.isDestroyed() ||
    !petWindow.isVisible()
  );
}

/**
 * Tick da patrulha. Dois estados: parado (esperando roamPauseUntil → sorteia
 * destino) e andando (passo constante até o alvo → pausa). O destino mora na
 * workArea do display atual — perímetro com viés, então o pet encosta em
 * TODAS as bordas e cantos; ~8% das vezes salta para outro monitor.
 */
function roamTick(): void {
  if (roamBlocked()) {
    roamTarget = null;
    roamSprint = false;
    sendRoamState({ phase: 'idle', dir: null, climb: null });
    return;
  }
  if (!petWindow || petWindow.isDestroyed()) return;
  const now = Date.now();
  const [x, y] = petWindow.getPosition();
  const pos = { x, y };

  if (!roamTarget) {
    if (now < roamPauseUntil) {
      sendRoamState({ phase: 'idle', dir: null, climb: null });
      return;
    }
    const displays = screen.getAllDisplays();
    let area = screen.getDisplayMatching({
      x: pos.x,
      y: pos.y,
      width: PET_WINDOW_SIZE.width,
      height: PET_WINDOW_SIZE.height,
    }).bounds;
    if (displays.length > 1 && Math.random() < 0.08) {
      const other = displays[Math.floor(Math.random() * displays.length)];
      if (other) area = other.bounds;
    }
    roamTarget = pickRoamDestination(pos, area, PET_WINDOW_SIZE, Math.random)
      .point;
    roamSprint = Math.random() < ROAM_SPRINT_CHANCE;
    return;
  }

  const speed =
    ROAM_WALK_SPEED_PX_S * (roamSprint ? ROAM_SPRINT_FACTOR : 1);
  const step = roamStep(pos, roamTarget, ROAM_TICK_MS, speed, roamLastDir);
  roamLastDir = step.dir;
  setPetBounds(step.next);
  sendRoamState({ phase: step.phase, dir: step.dir, climb: step.climb });

  // Placement segue a janela: sprite/balão re-ancoram ao encostar na borda.
  if (now - roamLastPlacementAt > 500) {
    roamLastPlacementAt = now;
    sendPetPlacement(step.next);
  }

  if (step.arrived) {
    roamTarget = null;
    roamSprint = false;
    roamPauseUntil =
      now +
      ROAM_PAUSE_MIN_MS +
      Math.random() * (ROAM_PAUSE_MAX_MS - ROAM_PAUSE_MIN_MS);
    sendRoamState({ phase: 'idle', dir: null, climb: null });
    sendPetPlacement(step.next);
    persistPosition(step.next);
  }
}

function startRoamLoop(): void {
  if (roamTimer) return;
  roamTimer = setInterval(roamTick, ROAM_TICK_MS);
  roamTimer.unref?.();
}

function stopRoamLoop(): void {
  if (roamTimer) {
    clearInterval(roamTimer);
    roamTimer = null;
  }
  roamTarget = null;
  roamSprint = false;
  roamLastSent = { phase: 'idle', dir: null, climb: null };
}

function commitLook(dir: number | null): void {
  if (dir === lookLastSent) return;
  lookLastSent = dir;
  lookPending = dir;
  lookPendingSince = Date.now();
  if (petWindow && !petWindow.isDestroyed() && !petWindow.webContents.isCrashed()) {
    petWindow.webContents.send(PET_CHANNELS.look, dir);
  }
}

/**
 * Só envia look após dwell estável. Idle (null) e direção usam o mesmo
 * debounce — o piscar típico era idle↔look a cada 150ms no limiar.
 */
function sendLook(dir: number | null): void {
  if (dir === lookLastSent) {
    lookPending = dir;
    return;
  }
  const now = Date.now();
  if (dir !== lookPending) {
    lookPending = dir;
    lookPendingSince = now;
    return;
  }
  if (now - lookPendingSince < LOOK_DWELL_MS) return;
  commitLook(dir);
}

/**
 * Look mechanics (contrato v2): o pet olha para o cursor. O main faz o poll
 * (a janela é click-through — o renderer não vê o mouse do desktop), quantiza
 * em 16 direções e só envia quando a direção MUDA. Dormindo ou arrastando,
 * o olhar volta ao neutro.
 */
function startLookLoop(): void {
  stopLookLoop();
  lookLastMoveAt = Date.now();
  lookTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) {
      stopLookLoop();
      return;
    }
    if (
      getPrefs().sleeping ||
      dragTimer ||
      roamLastSent.phase !== 'idle'
    ) {
      sendLook(null);
      return;
    }
    const bounds = petWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    // Borda física OU workArea: bounds subpixel + sheet look = piscar.
    // Força idle (null) — NÃO “congela” a última direção (ainda troca frames).
    if (
      petNearDisplayEdge(bounds, display.workArea) ||
      petNearDisplayEdge(bounds, display.bounds) ||
      windowIntersectsOffDisplay(
        { x: bounds.x, y: bounds.y },
        PET_WINDOW_SIZE,
        display.bounds,
      )
    ) {
      sendLook(null);
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const now = Date.now();
    if (cursor.x !== lookLastCursor.x || cursor.y !== lookLastCursor.y) {
      lookLastCursor = { x: cursor.x, y: cursor.y };
      lookLastMoveAt = now;
    }
    sendLook(
      computeLookDir(cursor, bounds, {
        cursorIdleMs: now - lookLastMoveAt,
        maxIdleMs: LOOK_CURSOR_IDLE_MAX_MS,
        // Sticky lastDir: evita piscar idle↔look / dir N↔N+1 nos cantos
        // e ao cruzar monitores (bounds + cursor “tremem” no limiar).
        lastDir: lookLastSent,
      }),
    );
  }, LOOK_TICK_MS);
}

function persistPosition(pos: { x: number; y: number }): void {
  prefs = { ...getPrefs(), position: pos };
  savePetPrefs(userDataDir(), prefs);
}

/** Último placement enviado — dedup: re-render do renderer só quando muda. */
let placementLastSent: PetPlacement | null = null;

/**
 * Encosta o sprite ao canto DENTRO da janela. A janela permanece 100% no
 * display; só os ~50–100 px transparentes mudam para o lado de dentro.
 * Só emite IPC quando o placement muda — no arrasto a cada tick seria
 * spam de re-render, e a troca de âncora no meio do gesto parecia salto.
 */
function sendPetPlacement(pos?: { x: number; y: number }): void {
  if (!petWindow || petWindow.isDestroyed() || !petReady) return;
  const [wx, wy] = petWindow.getPosition();
  const current = pos ?? { x: wx, y: wy };
  const display = screen.getDisplayMatching({
    x: current.x,
    y: current.y,
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
  });
  // bounds físicos: o nível screen-saver desenha o pet ACIMA de menubar e
  // Dock, então a extremidade percebida é o pixel físico. O sprite encosta
  // na beirada real quando a janela está colada nos bounds.
  const area = display.bounds;
  const leftGap = Math.abs(current.x - area.x);
  const rightGap = Math.abs(
    area.x + area.width - (current.x + PET_WINDOW_SIZE.width),
  );
  const topGap = Math.abs(current.y - area.y);
  const edgePx = 4;
  const placement: PetPlacement = {
    horizontal:
      leftGap <= edgePx
        ? 'left'
        : rightGap <= edgePx
          ? 'right'
          : 'center',
    vertical: topGap <= edgePx ? 'top' : 'bottom',
  };
  if (
    placementLastSent &&
    placementLastSent.horizontal === placement.horizontal &&
    placementLastSent.vertical === placement.vertical
  ) {
    return;
  }
  placementLastSent = placement;
  petWindow.webContents.send(PET_CHANNELS.placement, placement);
}

/**
 * Guard de reentrância da criação: o Electron emite 'browser-window-created'
 * SINCRONAMENTE dentro do construtor do BrowserWindow — antes de
 * `petWindow = win` ser atribuído. Sem este flag, o handler global re-entra
 * em createPetWindow com petWindow ainda null e a recursão de janelas
 * estoura a stack (e brickaria o boot, já que enabled=true persiste antes).
 */
let creatingPetWindow = false;

function ensurePetWindowSize(win: BrowserWindow): void {
  const [width, height] = win.getSize();
  if (
    width !== PET_WINDOW_SIZE.width ||
    height !== PET_WINDOW_SIZE.height
  ) {
    win.setSize(PET_WINDOW_SIZE.width, PET_WINDOW_SIZE.height);
  }
}

/**
 * Arrasto livre: janela inteira coberta pela união dos bounds FÍSICOS de
 * todos os monitores. O pet flutua no nível screen-saver — acima da menu
 * bar e do Dock — então a extremidade real é o pixel físico, não a
 * workArea: o sprite chega no canto verdadeiro sem nada escondido. O que
 * continua proibido é pixel fora de tela (zona morta entre monitores de
 * alturas diferentes), que o compositor desenha como corte/piscada.
 */
function clampDragFree(pos: { x: number; y: number }): { x: number; y: number } {
  const areas = screen.getAllDisplays().map((d) => d.bounds);
  return clampPetCoveredByDisplays(pos, PET_WINDOW_SIZE, areas);
}

/** Pull the pet back into the settle envelope after display topology changes. */
function reclampPetToVisibleDisplay(): void {
  if (!petWindow || petWindow.isDestroyed() || dragTimer) return;
  const [x, y] = petWindow.getPosition();
  const display = screen.getDisplayMatching({
    x,
    y,
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
  });
  // Já totalmente dentro dos bounds físicos — não recompor a janela.
  if (isWithinPetOverhang({ x, y }, PET_WINDOW_SIZE, display.bounds)) return;

  const settled = clampPetDrag(
    { x, y },
    PET_WINDOW_SIZE,
    display.bounds,
    EDGE_OVERHANG_SETTLE,
  );
  if (x === settled.x && y === settled.y) return;
  setPetBounds(settled, true);
  persistPosition(settled);
  sendPetPlacement(settled);
}

function scheduleReclampPet(): void {
  if (reclampTimer) clearTimeout(reclampTimer);
  reclampTimer = setTimeout(() => {
    reclampTimer = null;
    reclampPetToVisibleDisplay();
  }, 450);
}

/** True when the pet window sits on the outer rim of its display workArea. */
function petNearDisplayEdge(
  bounds: { x: number; y: number; width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
  margin = LOOK_EDGE_FREEZE_PX,
): boolean {
  return (
    bounds.x <= workArea.x + margin ||
    bounds.y <= workArea.y + margin ||
    bounds.x + bounds.width >= workArea.x + workArea.width - margin ||
    bounds.y + bounds.height >= workArea.y + workArea.height - margin
  );
}

/**
 * Garante companion visível e no topo. No boot macOS a janela transparente +
 * alwaysOnTop por vezes nasce "fantasma" (enabled=true mas nada se vê até
 * toggle off/on). Esta assert re-mostra sem destruir a janela.
 *
 * raisePetAboveAll(force) já re-aplica ignore+forward — não duplicar aqui
 * (spam de setIgnoreMouseEvents pisca o compositor).
 */
function assertPetVisible(force = false): void {
  if (!petRaiseAllowed()) return;
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!getPrefs().enabled) return;
  ensurePetWindowSize(petWindow);
  if (force || !petWindow.isVisible()) {
    try {
      petWindow.showInactive();
    } catch {
      try {
        petWindow.show();
      } catch {
        // ignore
      }
    }
  }
  petPinnedTop = false;
  raisePetAboveAll(true);
}

const bootReassertTimers: NodeJS.Timeout[] = [];
/** Tentativas de reload após did-fail-load (por janela). */
const petLoadFailRetries = new WeakMap<Electron.BrowserWindow, number>();
const PET_LOAD_FAIL_MAX = 3;

function clearBootReassert(): void {
  while (bootReassertTimers.length > 0) {
    const t = bootReassertTimers.pop();
    if (t) clearTimeout(t);
  }
}

/** Re-asserts staggered: compositor macOS por vezes engole o 1º show. */
function scheduleBootReassert(): void {
  clearBootReassert();
  for (const ms of [250, 900, 2_000]) {
    bootReassertTimers.push(
      setTimeout(() => {
        if (!getPrefs().enabled) return;
        if (!petWindow || petWindow.isDestroyed()) {
          if (mainAppWindows().length > 0) createPetWindow();
          return;
        }
        assertPetVisible(true);
      }, ms),
    );
  }
}

function createPetWindow(): void {
  if (creatingPetWindow) return;
  if (!petWindow || petWindow.isDestroyed()) {
    // Não nascer alwaysOnTop no meio do Space de tela cheia.
    if (!petRaiseAllowed()) return;
  }
  if (petWindow && !petWindow.isDestroyed()) {
    assertPetVisible(true);
    if (!petReady && !petWindow.webContents.isLoading()) {
      void petWindow.loadURL(petUrl()).catch((err) => {
        console.warn('[pet] reload falhou:', err);
      });
    }
    return;
  }
  const position = restoredPosition();

  // Prefs antigas podiam gravar overhang extremo (ex.: x=-65 y=-86) → flicker.
  const bootDisplay = screen.getDisplayMatching({
    x: position.x,
    y: position.y,
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
  });
  const bootPos = clampPetDrag(
    position,
    PET_WINDOW_SIZE,
    bootDisplay.bounds,
    EDGE_OVERHANG_SETTLE,
  );
  // Persistir se re-park/clamp divergiu da prefs (senão o restore re-aplica
  // o explorer no próximo boot e o repark corre outra vez em loop).
  const saved = getPrefs().position;
  if (
    !saved ||
    !Number.isFinite(saved.x) ||
    !Number.isFinite(saved.y) ||
    saved.x !== bootPos.x ||
    saved.y !== bootPos.y
  ) {
    persistPosition(bootPos);
  }

  creatingPetWindow = true;
  const win = new BrowserWindow({
    ...PET_WINDOW_SIZE,
    x: bootPos.x,
    y: bootPos.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false, // movimento é nosso (drag manual + clamp no display)
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // On macOS the Dock is app-scoped. Keep skipTaskbar false so the pet never
    // participates in process-level Dock/taskbar policy; Windows/Linux can
    // still hide only this companion from the taskbar. (The UIElement flip that
    // hid the Dock icon was setVisibleOnAllWorkspaces without
    // skipTransformProcessType — fixed in raisePetAboveAll.)
    skipTaskbar: process.platform !== 'darwin',
    hasShadow: false,
    // Nunca rouba o foco do terminal do usuário: pet é presença, não janela.
    focusable: false,
    alwaysOnTop: true,
    // Mostrar só em ready-to-show — evita surface transparente “morta” no boot.
    show: false,
    // Permite posicionar a janela frameless na borda física, não só dentro da
    // workArea do AppKit. Evita o NSPanel, que diverge as coordenadas entre
    // Electron e WindowServer quando os monitores têm origens negativas.
    enableLargerThanScreen: true,
    title: 'NexusIDE Pet',
    backgroundColor: '#00000000',
    // Precisa de paint mesmo escondida para o 1º frame não ser vazio.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'pet-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // Pin safe defaults explicitly (L3) to match the main window.
      webSecurity: true,
      allowRunningInsecureContent: false,
      // O pet nunca recebe foco; não reduzir RAF/timers enquanto ele está
      // visível, senão a animação parece travar durante o arrasto.
      backgroundThrottling: false,
    },
  });
  petWindow = win;
  petReady = false;
  creatingPetWindow = false;

  // Mesma postura de segurança da janela principal.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  petPinnedTop = false;
  // Click-through até o renderer marcar uma área interativa sob o cursor.
  petIgnoresMouse = true;
  win.setIgnoreMouseEvents(true, { forward: true });

  win.once('ready-to-show', () => {
    if (petWindow !== win || win.isDestroyed()) return;
    if (!getPrefs().enabled) return;
    setPetBounds(bootPos, true);
    assertPetVisible(true);
  });

  win.webContents.once('did-finish-load', () => {
    // did-finish-load ainda é cedo demais: React useEffect pode não ter
    // registrado onEvent. O renderer envia rendererReady após assinar a fila.
    petReady = false;
    // O AppKit pode ajustar a posição durante a criação. Reaplicar uma vez
    // depois da surface existir mantém getBounds e WindowServer sincronizados.
    setPetBounds(bootPos, true);
    // Click-through garantido após load (renderer ainda não enviou leave).
    applyIgnoreMouseEvents(true);
    assertPetVisible(true);
    // Corrige posição suja legada sem esperar plug de monitor.
    reclampPetToVisibleDisplay();
    scheduleBootReassert();
  });

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.warn(`[pet] did-fail-load code=${code} ${desc}`);
    petReady = false;
    if (!getPrefs().enabled) return;
    const n = (petLoadFailRetries.get(win) ?? 0) + 1;
    petLoadFailRetries.set(win, n);
    if (n > PET_LOAD_FAIL_MAX) {
      console.warn(`[pet] load desistiu após ${PET_LOAD_FAIL_MAX} tentativas`);
      return;
    }
    setTimeout(() => {
      if (petWindow !== win || win.isDestroyed()) return;
      void win.loadURL(petUrl()).catch((err) => {
        console.warn('[pet] retry load falhou:', err);
      });
    }, 600 * n);
  });

  win.on('closed', () => {
    stopDrag();
    stopLookLoop();
    stopRaiseWatch();
    clearBootReassert();
    petLoadFailRetries.delete(win);
    petReady = false;
    petIgnoresMouse = true;
    petPinnedTop = false;
    roamRendererHold = false;
    petWindow = null;
  });

  void win.loadURL(petUrl()).catch((err) => {
    console.warn('[pet] load falhou:', err);
  });
  startLookLoop();
  startRaiseWatch();
  // A patrulha nasce com a janela e se auto-veta quando bloqueada.
  startRoamLoop();
}

function destroyPetWindow(): void {
  stopDrag();
  stopLookLoop();
  stopRoamLoop();
  stopRaiseWatch();
  clearBootReassert();
  petReady = false;
  petIgnoresMouse = true;
  petPinnedTop = false;
  roamRendererHold = false;
  placementLastSent = null;
  pendingPetEvents.length = 0;
  if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
  petWindow = null;
}

function syncWindowToPrefs(): void {
  const current = getPrefs();
  const shouldShow = current.enabled && mainAppWindows().length > 0;
  if (shouldShow) {
    createPetWindow();
    assertPetVisible(true);
  } else {
    destroyPetWindow();
  }
}

function applyPrefsPatch(raw: unknown): PetPrefs {
  const patch = sanitizePetPrefsPatch(raw);
  prefs = { ...getPrefs(), ...patch };
  savePetPrefs(userDataDir(), prefs);
  syncWindowToPrefs();
  broadcastPrefs();
  return prefs;
}

function fromPetWindow(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return (
    petWindow !== null &&
    !petWindow.isDestroyed() &&
    event.sender === petWindow.webContents
  );
}

/**
 * Prefs só para janelas DE APP (principal, pet) — nunca para WebContentsViews
 * de browser panes, que carregam páginas arbitrárias. Mesma convenção de
 * validação de sender do resto do IPC (orch, pty).
 */
function fromTrustedWindow(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (fromPetWindow(event)) return true;
  return BrowserWindow.getAllWindows().some(
    (win) => !win.isDestroyed() && win.webContents === event.sender,
  );
}

function registerPetIpc(): void {
  ipcMain.handle(PET_CHANNELS.getPrefs, (event) => {
    if (!fromTrustedWindow(event)) throw new Error('pet: sender não autorizado');
    return getPrefs();
  });
  ipcMain.handle(PET_CHANNELS.setPrefs, (event, raw: unknown) => {
    if (!fromTrustedWindow(event)) throw new Error('pet: sender não autorizado');
    return applyPrefsPatch(raw);
  });
  ipcMain.handle(PET_CHANNELS.galleryImport, (event, raw: unknown) => {
    if (!fromTrustedWindow(event)) throw new Error('pet: sender não autorizado');
    if (typeof raw !== 'string' || raw.length > 512) {
      return { ok: false, error: 'Entrada inválida.' };
    }
    // O fetch vive no main de propósito: a CSP do renderer (connect-src
    // 'self') não fala com a galeria — e não deve.
    return importGalleryPet(raw);
  });
  ipcMain.handle(PET_CHANNELS.galleryList, (event) => {
    if (!fromTrustedWindow(event)) throw new Error('pet: sender não autorizado');
    return fetchGalleryCatalog();
  });
  ipcMain.handle(PET_CHANNELS.libraryList, (event) => {
    if (!fromTrustedWindow(event)) throw new Error('pet: sender não autorizado');
    return listPetLibrary();
  });
  ipcMain.handle(PET_CHANNELS.libraryApply, (event, raw: unknown) => {
    if (!fromTrustedWindow(event)) throw new Error('pet: sender não autorizado');
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) {
      return { ok: false, error: 'id de biblioteca inválido' };
    }
    try {
      const loaded = loadLibrarySheet(raw.trim());
      if (!loaded.ok || !loaded.sheet) {
        return {
          ok: false,
          error: loaded.error ?? 'pet da biblioteca indisponível',
        };
      }
      const prefs = applyPrefsPatch({
        preset: 'sheet',
        sheet: loaded.sheet,
        // Aplicar da biblioteca é escolha explícita de “usar este pet agora”.
        enabled: true,
      });
      return { ok: true, name: loaded.name, prefs };
    } catch (err) {
      return {
        ok: false,
        error: `Falha ao aplicar pet (${err instanceof Error ? err.message : 'erro'}).`,
      };
    }
  });
  ipcMain.handle(PET_CHANNELS.libraryPreview, (event, raw: unknown) => {
    if (!fromTrustedWindow(event)) throw new Error('pet: sender não autorizado');
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) {
      return { ok: false, error: 'id de biblioteca inválido' };
    }
    try {
      return loadLibrarySheet(raw.trim());
    } catch (err) {
      return {
        ok: false,
        error: `Falha no preview (${err instanceof Error ? err.message : 'erro'}).`,
      };
    }
  });
  ipcMain.handle(PET_CHANNELS.installedList, (event) => {
    if (!fromTrustedWindow(event)) throw new Error('pet: sender não autorizado');
    return listInstalledPets();
  });
  ipcMain.handle(PET_CHANNELS.installedApply, (event, raw: unknown) => {
    if (!fromTrustedWindow(event)) throw new Error('pet: sender não autorizado');
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) {
      return { ok: false, error: 'id de pet local inválido' };
    }
    const loaded = loadInstalledPet(raw.trim());
    if (!loaded.ok || !loaded.sheet) return loaded;
    const prefs = applyPrefsPatch({
      preset: 'sheet',
      sheet: loaded.sheet,
      enabled: true,
    });
    return { ok: true, name: loaded.name, prefs };
  });
  ipcMain.handle(PET_CHANNELS.installedPreview, (event, raw: unknown) => {
    if (!fromTrustedWindow(event)) throw new Error('pet: sender não autorizado');
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) {
      return { ok: false, error: 'id de pet local inválido' };
    }
    return loadInstalledPet(raw.trim());
  });
  ipcMain.handle(PET_CHANNELS.installedDelete, (event, raw: unknown) => {
    if (!fromTrustedWindow(event)) throw new Error('pet: sender não autorizado');
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) {
      return { ok: false, error: 'id de pet local inválido' };
    }
    return deleteInstalledPet(raw.trim());
  });
  ipcMain.handle(PET_CHANNELS.pickImage, async (event) => {
    if (!fromTrustedWindow(event)) throw new Error('pet: sender não autorizado');
    const owner = BrowserWindow.fromWebContents(event.sender);
    const { dialog, app: electronApp } = await import('electron');
    const options = {
      title: 'Imagem-base do pet (geração com IA)',
      defaultPath: electronApp.getPath('pictures'),
      properties: ['openFile' as const],
      filters: [
        { name: 'Imagem', extensions: ['png', 'webp', 'jpg', 'jpeg'] },
      ],
    };
    const picked = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    // Fototeca/iCloud entregam caminhos temporários que somem antes de a
    // missão rodar. A cópia precisa viver DENTRO do workspace autorizado:
    // um path em userData aparecia no prompt, mas ficava fora do sandbox do
    // orquestrador e portanto não era um anexo realmente utilizável.
    try {
      const scope = requireRendererWorkspaceScope(event.sender);
      const stable = await copyHatchImage(
        picked.filePaths[0],
        path.join(scope.rootRealPath, '.nexus', 'attachments'),
      );
      return { ok: true, path: stable };
    } catch (cause) {
      return {
        ok: false,
        error:
          cause instanceof Error
            ? `Não consegui anexar a imagem ao workspace: ${cause.message}`
            : 'Não consegui anexar a imagem ao workspace.',
      };
    }
  });
  ipcMain.handle(PET_CHANNELS.pickSheet, async (event) => {
    if (!fromTrustedWindow(event)) throw new Error('pet: sender não autorizado');
    const owner = BrowserWindow.fromWebContents(event.sender);
    // Abre direto onde o Codex guarda os pets (mesmo caminho nos 3 OS).
    const codexPets = path.join(homedir(), '.codex', 'pets');
    const { dialog } = await import('electron');
    const dialogOptions = {
      title: 'Importar spritesheet do Codex',
      defaultPath: existsSync(codexPets) ? codexPets : homedir(),
      properties: ['openFile' as const],
      filters: [
        {
          name: 'Spritesheet (png/webp/jpeg)',
          extensions: ['png', 'webp', 'jpg', 'jpeg'],
        },
      ],
    };
    const picked = owner
      ? await dialog.showOpenDialog(owner, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const file = picked.filePaths[0];
    try {
      if (statSync(file).size > 2_600_000) {
        return { ok: false, error: 'Arquivo grande demais (limite ~2,5 MB).' };
      }
      const ext = path.extname(file).toLowerCase().replace('.', '');
      const mime =
        ext === 'png' ? 'png' : ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : 'webp';
      const dataUrl = `data:image/${mime};base64,${readFileSync(file).toString('base64')}`;
      return { ok: true, dataUrl };
    } catch (err) {
      return {
        ok: false,
        error: `Não consegui ler o arquivo (${err instanceof Error ? err.message : 'erro'}).`,
      };
    }
  });

  ipcMain.on(PET_CHANNELS.setInteractive, (event, interactive: unknown) => {
    if (!fromPetWindow(event) || !petWindow) return;
    // Idempotent no cache; force=false evita spam de recompose no macOS.
    // O renderer re-sincroniza em mousemove (corrige ignore perdido após drag).
    applyIgnoreMouseEvents(interactive !== true, false);
  });

  ipcMain.on(PET_CHANNELS.rendererReady, (event) => {
    if (!fromPetWindow(event) || !petWindow) return;
    petReady = true;
    flushPendingPetEvents();
    sendPetPlacement();
    sendRoamState({ phase: 'idle', dir: null, climb: null });
    // Stats imediato no boot do renderer — sem esperar o debounce.
    petWindow.webContents.send(PET_CHANNELS.stats, getPetStats().stats());
  });

  ipcMain.on(PET_CHANNELS.roamHold, (event, held: unknown) => {
    if (!fromPetWindow(event)) return;
    roamRendererHold = held === true;
  });

  ipcMain.on(PET_CHANNELS.eventShown, (event, kind: unknown) => {
    if (!fromPetWindow(event)) return;
    if (
      typeof kind !== 'string' ||
      ![
        'mission-done',
        'mission-failed',
        'mission-technical-failure',
        'mission-blocked',
        'agent-waiting',
        'agent-exited',
      ].includes(kind)
    ) {
      return;
    }
    console.log(`[pet] balloon shown: ${kind}`);
  });

  /**
   * Assenta ONDE o utilizador soltou. Usa lastDragPos (delta de ecrã), não
   * getPosition() — em janelas transparentes macOS o getPosition pode
   * desfasar do que setPosition aplicou. Sem snap de canto.
   */
  const settleDrag = (): void => {
    if (!petWindow || petWindow.isDestroyed()) {
      stopDrag();
      lastDragPos = null;
      return;
    }
    const [gx, gy] = petWindow.getPosition();
    const raw = lastDragPos ?? { x: gx, y: gy };
    stopDrag();
    // O cursor representa a intenção do utilizador. Usar o centro da grande
    // janela transparente escolhia a tela errada perto da costura e puxava o
    // pet para dentro ao soltar.
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    // Settle 100% dentro dos bounds físicos — o pet flutua acima de
    // menubar/Dock, então a borda de verdade é o pixel físico do display.
    const settled = snapPetToCursorEdges(
       clampPetDrag(
         raw,
         PET_WINDOW_SIZE,
         display.bounds,
         EDGE_OVERHANG_SETTLE,
       ),
       PET_WINDOW_SIZE,
       display.bounds,
       cursor,
       0,
     );
    if (gx !== settled.x || gy !== settled.y) {
      // Um único setBounds no fim garante a coordenada exata persistida.
      setPetBounds(settled, true);
    }
    persistPosition(settled);
    sendPetPlacement(settled);
    lastDragPos = null;
    // Soltar o click-through residual pós-drag.
    applyIgnoreMouseEvents(true);
    // NÃO repark após settle — o utilizador mandou a posição; repark roubava
    // o arrasto (“tenho de forçar o rato”).
    raisePetAboveAll(false);
  };

  ipcMain.on(PET_CHANNELS.dragBegin, (event, _rawOffset: unknown) => {
    if (!fromPetWindow(event) || !petWindow) return;
    stopDrag();
    lastDragPos = null;
    // Arrasto: look off + hit-test ON (click-through matava o pointer mid-drag).
    commitLook(null);
    applyIgnoreMouseEvents(false);
    // Delta de ecrã: ignora clientX do renderer (falha com DPI / click-through).
    const cursor = screen.getCursorScreenPoint();
    const [winX, winY] = petWindow.getPosition();
    dragOrigin = {
      winX,
      winY,
      cursorX: cursor.x,
      cursorY: cursor.y,
    };
    lastDragPos = { x: winX, y: winY };
    // Watchdog: se o dragEnd do renderer se perder, assenta sozinho.
    const startedAt = Date.now();
    let lastApplied = { x: winX, y: winY };
    dragTimer = setInterval(() => {
      if (!petWindow || petWindow.isDestroyed() || !dragOrigin) {
        stopDrag();
        return;
      }
      if (Date.now() - startedAt > DRAG_MAX_MS) {
        settleDrag();
        return;
      }
      const c = screen.getCursorScreenPoint();
      const next = {
        x: Math.round(dragOrigin.winX + (c.x - dragOrigin.cursorX)),
        y: Math.round(dragOrigin.winY + (c.y - dragOrigin.cursorY)),
      };
      // Livre coberto pelos bounds físicos (Mac + LG sem parede; zona
      // morta entre monitores recusada, menubar/Dock alcançáveis).
      const clamped = clampDragFree(next);
      lastDragPos = clamped;
      if (clamped.x === lastApplied.x && clamped.y === lastApplied.y) return;
      lastApplied = clamped;
      // Movimento posicional: preserva a superfície transparente entre telas.
      setPetBounds(clamped);
      // Placement ao vivo a cada tick (dedup interno — IPC só na mudança):
      // o sprite encosta na borda DURANTE o arrasto, sem salto no drop.
      sendPetPlacement(clamped);
    }, DRAG_TICK_MS);
  });

  ipcMain.on(PET_CHANNELS.dragEnd, (event) => {
    if (!fromPetWindow(event)) return;
    settleDrag();
  });

  const focusMainWindow = (): BrowserWindow | null => {
    const [main] = mainAppWindows();
    if (!main) return null;
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    return main;
  };

  ipcMain.on(PET_CHANNELS.focusMain, (event) => {
    if (!fromPetWindow(event)) return;
    focusMainWindow();
  });

  ipcMain.on(PET_CHANNELS.requestSettings, (event) => {
    if (!fromPetWindow(event)) return;
    focusMainWindow()?.webContents.send(PET_CHANNELS.openSettings);
  });

  ipcMain.on(PET_CHANNELS.requestOpenTerminal, (event) => {
    if (!fromPetWindow(event)) return;
    focusMainWindow()?.webContents.send(PET_CHANNELS.openTerminal);
  });

  ipcMain.on(PET_CHANNELS.requestOpenOps, (event) => {
    if (!fromPetWindow(event)) return;
    focusMainWindow()?.webContents.send(PET_CHANNELS.openOps);
  });
}

function wireOperationalEvents(): void {
  tapSessionState((sessionId, state) => {
    const event = agentTracker.ingest(sessionId, state, Date.now());
    if (event) sendPetEvent(event);
    if (state === 'exited') {
      agentTracker.forget(sessionId);
      attentionTracker.forget(sessionId);
    }
  });
  // Hooks explícitos do provider: waiting/blocked = "um agente precisa de
  // você" — o aviso operacional nº 1 do pet.
  tapAgentHookStatus((sessionId, state) => {
    const raw = attentionTracker.ingest(sessionId, state, Date.now());
    if (!raw) return;
    const info = getAgentSessionInfo(sessionId);
    const label =
      info?.agentName ||
      (info?.missionId ? `missão ${info.missionId.slice(0, 8)}` : null) ||
      info?.adapterId ||
      'agente';
    sendPetEvent({ ...raw, title: label });
  });
  // Semeia o tracker na abertura de cada escopo: a primeira transição real
  // (ex.: missão que estava rodando no boot termina) NÃO é engolida como seed.
  tapMissionsSeed((scopeKey, missions) => {
    missionTracker.seed(scopeKey, missions);
  });
  tapMissionsBroadcast((scopeKey, missions) => {
    for (const event of missionTracker.ingest(scopeKey, missions, Date.now())) {
      sendPetEvent(event);
    }
  });
}

/**
 * Liga o pet no boot (chamado uma vez no bootstrap do main). O pet segue as
 * janelas principais: some quando a última fecha, volta quando outra abre.
 */
export function initDesktopPet(): void {
  if (initialized) return;
  initialized = true;
  // Prova de vida do main: se isto não aparece no terminal do `npm start`,
  // o Electron está a correr código antigo (Forge não recarrega o main).
  console.log(`[pet] drag-engine=${PET_DRAG_ENGINE}`);
  registerPetIpc();
  wireOperationalEvents();

  // Telemetria real → contadores de vida útil do companion. O tap recebe
  // o snapshot cumulativo de cada escopo no mesmo instante do broadcast.
  tapUsageSnapshot((scope, snapshot) => {
    getPetStats().ingestSnapshot(scope, snapshot);
    pushPetStats();
  });
  // Totais de vida útil também alimentam o Perfil de Operador (tokens
  // torrados + equivalente USD de API). Autoridade: o tracker acima —
  // o renderer principal lê via invoke, sem canal próprio de estado.
  ipcMain.handle(USAGE_CHANNELS.lifetime, () => getPetStats().stats());
  // Persistência preguiçosa do piso/panes — JSON pequeno, tmp+rename.
  statsFlushTimer = setInterval(() => {
    try {
      getPetStats().flush();
    } catch (error) {
      console.warn('[pet] stats flush falhou:', error);
    }
  }, STATS_FLUSH_MS);
  statsFlushTimer.unref?.();
  // O tick da patrulha é barato e se auto-veta (prefs/drag/balão); fica
  // ligado sempre para o pet responder sem esperar o próximo toggle.
  startRoamLoop();

  const watchAppWindow = (win: BrowserWindow) => {
    if (isPetWindow(win)) return;
    win.on('closed', () => {
      if (mainAppWindows().length === 0) destroyPetWindow();
    });
    // Fullscreen nativo cria um Space. Hide() sem desligar o pin ainda
    // deixa o pet na coleção e o WindowServer troca o desktop depois.
    const beginFullscreenSilence = (): void => {
      fullscreenSilenceLatched = true;
      fullscreenGuardUntil = Date.now() + FULLSCREEN_GUARD_MS;
      if (fullscreenRepinTimer) {
        clearTimeout(fullscreenRepinTimer);
        fullscreenRepinTimer = null;
      }
    };
    const unpinAndHidePetForAppFullscreen = (): void => {
      if (!petWindow || petWindow.isDestroyed()) return;
      applyPetWorkspacePin(petWorkspacePinForFullscreenEvent('enter-full-screen'));
      try {
        petWindow.hide();
      } catch {
        // ignore
      }
    };
    const suppressPetForAppFullscreen = (): void => {
      beginFullscreenSilence();
      if (petActionForAppFullscreenEvent('enter-full-screen') === 'hide-and-silence') {
        unpinAndHidePetForAppFullscreen();
      }
    };
    // will-enter (se o Electron encaminhar) corre antes da animação do Space.
    win.on('will-enter-full-screen' as 'enter-full-screen', suppressPetForAppFullscreen);
    win.on('enter-full-screen', suppressPetForAppFullscreen);
    win.on('leave-full-screen', () => {
      beginFullscreenSilence();
      if (petActionForAppFullscreenEvent('leave-full-screen') !== 'silence-then-repin') {
        return;
      }
      fullscreenRepinTimer = setTimeout(() => {
        fullscreenRepinTimer = null;
        fullscreenSilenceLatched = false;
        fullscreenGuardUntil = 0;
        petPinnedTop = false;
        if (getPrefs().enabled && mainAppWindows().length > 0) {
          createPetWindow();
        }
        raisePetAboveAll(true);
        assertPetVisible(true);
        scheduleReclampPet();
      }, FULLSCREEN_REPIN_DELAY_MS);
    });
  };

  // A janela principal nasce ANTES deste init (bootstrap): cobrir as vivas e
  // as futuras — sem o watcher nela, fechar a principal deixaria o pet órfão.
  for (const win of BrowserWindow.getAllWindows()) watchAppWindow(win);
  app.on('browser-window-created', (_event, win) => {
    watchAppWindow(win);
    syncWindowToPrefs();
    // Nova janela do app: re-pin só se o pet tiver sido demovido.
    raisePetAboveAll(false);
  });

  // NÃO escutar browser-window-focus: dispara em rajada e recompõe o pet
  // (pisca). activate / did-become-active bastam para Spaces / dock click.
  app.on('activate', () => {
    // Se o pet sumiu no boot, recria/re-mostra em vez de só re-pin no vazio.
    syncWindowToPrefs();
    assertPetVisible(true);
  });
  app.on('did-become-active', () => {
    syncWindowToPrefs();
    assertPetVisible(true);
  });

  // Multi-monitor: plug/unplug/resolution — reclamp debounced (metrics-changed
  // pode disparar em rajada e setBounds repetido pisca o pet).
  const onDisplayTopology = (): void => {
    scheduleReclampPet();
    petPinnedTop = false;
    raisePetAboveAll(true);
  };
  screen.on('display-added', onDisplayTopology);
  screen.on('display-removed', onDisplayTopology);
  screen.on('display-metrics-changed', onDisplayTopology);

  syncWindowToPrefs();
  // 2ª passagem: main window por vezes ainda não está em getAllWindows()
  // no instante exacto do 1º sync (ou o compositor ignora o 1º show).
  scheduleBootReassert();
}
