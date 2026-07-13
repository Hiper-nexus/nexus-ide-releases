import path from 'node:path';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  PET_CHANNELS,
  isPetUrgentEvent,
  sanitizePetPrefsPatch,
  type PetEvent,
  type PetPrefs,
} from '../../shared/pet-types';
import { RENDERER_PROTOCOL_ENTRY_URL } from '../renderer-protocol';
import { getAgentSessionInfo, tapSessionState } from '../pty/pty-manager';
import { tapMissionsBroadcast, tapMissionsSeed } from '../orch/orch-ipc';
import { loadPetPrefs, savePetPrefs } from './pet-prefs';
import {
  bestPetParkPosition,
  clampPetDrag,
  clampPetDragFreeDesktop,
  EDGE_OVERHANG_DRAG,
  EDGE_OVERHANG_SETTLE,
  isWithinPetOverhang,
  petCoversMainSidebar,
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
import { computeLookDir } from './pet-look';
import { copyHatchImage } from './pet-hatch-image';
import { fetchGalleryCatalog, importGalleryPet } from './pet-gallery';
import { listPetLibrary, loadLibrarySheet } from './pet-library';
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
 * Janela do companion: sheet ~260px + balão + margem de arrasto.
 * (2×/416 era grande demais no desktop.)
 */
export const PET_WINDOW_SIZE = { width: 380, height: 360 } as const;
/**
 * Motor de arrasto. Log no boot: se não aparecer, o main é código velho.
 * free-v4 = arrasto livre no desktop virtual; settle assenta num display.
 */
export const PET_DRAG_ENGINE = 'free-v4';
/** Cadência do arrasto (ms). */
const DRAG_TICK_MS = 16;
/** Teto de um arrasto: além disso o watchdog assenta a janela sozinho. */
const DRAG_MAX_MS = 30_000;
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
/** Renderer do pet pronto para receber IPC de evento (did-finish-load). */
let petReady = false;
/** Eventos enfileirados até o pet carregar — evita balão perdido no boot. */
const pendingPetEvents: PetEvent[] = [];
const PENDING_PET_EVENT_LIMIT = 12;

const agentTracker = new AgentTransitionTracker();
const attentionTracker = new AgentAttentionTracker();
const missionTracker = new MissionTransitionTracker();
let attentionPolicy: AttentionPolicyState = createAttentionPolicyState();
let digestTimer: NodeJS.Timeout | null = null;

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
  // O display salvo pode ter sido desconectado: clampa para a workArea do
  // display mais próximo (settle overhang — preserva cantos).
  const display = screen.getDisplayMatching({
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
  });
  const clamped = clampPetDrag(
    { x: Math.round(saved.x), y: Math.round(saved.y) },
    PET_WINDOW_SIZE,
    display.workArea,
    EDGE_OVERHANG_SETTLE,
  );
  // Posição legada / arrasto acidental sobre o explorer: re-estaciona no canto
  // livre em vez de tapar a árvore de ficheiros (clique + legibilidade).
  // Só no restore/boot — o settle do arrasto respeita a intenção do user.
  const mains = mainWindowObstacles();
  if (mains.some((m) => petCoversMainSidebar(clamped, PET_WINDOW_SIZE, m))) {
    return bestPetParkPosition(PET_WINDOW_SIZE, display.workArea, mains);
  }
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
  const result = admitPetEvent(attentionPolicy, event, now);
  attentionPolicy = result.state;
  if (result.scheduleDigest) scheduleDigestFlush();
  if (result.immediate) applyAttentionDecision(result.immediate);
  for (const decision of result.flushed) applyAttentionDecision(decision);
}

function stopDrag(): void {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  dragOrigin = null;
}

function applyIgnoreMouseEvents(ignore: boolean): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (petIgnoresMouse === ignore) return;
  petIgnoresMouse = ignore;
  petWindow.setIgnoreMouseEvents(ignore, { forward: true });
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
function raisePetAboveAll(force = false): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const now = Date.now();
  const demoted = !petWindow.isAlwaysOnTop() || !petPinnedTop;
  if (!force && !demoted) return;
  if (!force && now - lastRaiseAt < RAISE_DEBOUNCE_MS) return;
  lastRaiseAt = now;

  try {
    petWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  } catch {
    try {
      petWindow.setAlwaysOnTop(true, 'screen-saver');
    } catch {
      petWindow.setAlwaysOnTop(true);
    }
  }
  try {
    petWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
    });
  } catch {
    petWindow.setVisibleOnAllWorkspaces(true);
  }
  // moveTop só quando demovido — a cada tick recompõe e pisca.
  if (force || demoted) {
    petWindow.moveTop();
  }
  if (!petWindow.isVisible()) {
    petWindow.showInactive();
  }
  petPinnedTop = true;
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

/** setBounds idempotente — setBounds redundante em transparente pisca no macOS. */
function setPetBounds(pos: { x: number; y: number }): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const [cx, cy] = petWindow.getPosition();
  const [cw, ch] = petWindow.getSize();
  if (
    cx === pos.x &&
    cy === pos.y &&
    cw === PET_WINDOW_SIZE.width &&
    ch === PET_WINDOW_SIZE.height
  ) {
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
    if (getPrefs().sleeping || dragTimer) {
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
 * Arrasto livre: desktop virtual (união de monitores). Sem parede na costura.
 * Settle usa workArea do display sob o centro da janela.
 */
function clampDragFree(pos: { x: number; y: number }): { x: number; y: number } {
  const bounds = screen.getAllDisplays().map((d) => d.bounds);
  return clampPetDragFreeDesktop(
    pos,
    PET_WINDOW_SIZE,
    bounds,
    EDGE_OVERHANG_DRAG,
  );
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
  // Já no envelope de settle — não setBounds (setBounds em transparente pisca).
  if (isWithinPetOverhang({ x, y }, PET_WINDOW_SIZE, display.workArea)) return;

  const settled = clampPetDrag(
    { x, y },
    PET_WINDOW_SIZE,
    display.workArea,
    EDGE_OVERHANG_SETTLE,
  );
  if (x === settled.x && y === settled.y) return;
  setPetBounds(settled);
  persistPosition(settled);
}

/**
 * Re-estaciona se o pet tapa o explorer. Só para caminhos automáticos
 * (boot, race com bounds do main, nova janela) — NÃO no settle de arrasto,
 * senão o user solta à esquerda e a janela “salta” sozinha.
 */
function reparkIfCoveringSidebar(): void {
  if (!petWindow || petWindow.isDestroyed() || dragTimer) return;
  const [x, y] = petWindow.getPosition();
  const pos = { x, y };
  const mains = mainWindowObstacles();
  if (!mains.some((m) => petCoversMainSidebar(pos, PET_WINDOW_SIZE, m))) {
    return;
  }
  const display = screen.getDisplayMatching({
    x,
    y,
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
  });
  const parked = bestPetParkPosition(
    PET_WINDOW_SIZE,
    display.workArea,
    mains,
  );
  if (parked.x === x && parked.y === y) return;
  setPetBounds(parked);
  persistPosition(parked);
  applyIgnoreMouseEvents(true);
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

function createPetWindow(): void {
  if (creatingPetWindow) return;
  if (petWindow && !petWindow.isDestroyed()) {
    ensurePetWindowSize(petWindow);
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
    bootDisplay.workArea,
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
    movable: false, // movimento é nosso (drag manual + clamp na workArea)
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Nunca rouba o foco do terminal do usuário: pet é presença, não janela.
    focusable: false,
    alwaysOnTop: true,
    // macOS: NSPanel sobe melhor sobre outras apps / Spaces.
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    title: 'NexusIDE Pet',
    backgroundColor: '#00000000',
    // Evita re-raster agressivo da superfície transparente no macOS.
    paintWhenInitiallyHidden: false,
    webPreferences: {
      preload: path.join(__dirname, 'pet-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  petWindow = win;
  petReady = false;
  creatingPetWindow = false;

  // Mesma postura de segurança da janela principal.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  petPinnedTop = false;
  raisePetAboveAll(true);
  // Click-through até o renderer marcar uma área interativa sob o cursor.
  petIgnoresMouse = true;
  win.setIgnoreMouseEvents(true, { forward: true });

  win.webContents.once('did-finish-load', () => {
    petReady = true;
    // Click-through garantido após load (renderer ainda não enviou leave).
    applyIgnoreMouseEvents(true);
    raisePetAboveAll(true);
    flushPendingPetEvents();
    // Corrige posição suja legada sem esperar plug de monitor.
    reclampPetToVisibleDisplay();
    // Se ainda estiver sobre o explorer (race com bounds do main), re-parqueia.
    reparkIfCoveringSidebar();
  });

  win.on('closed', () => {
    stopDrag();
    stopLookLoop();
    stopRaiseWatch();
    petReady = false;
    petIgnoresMouse = true;
    petPinnedTop = false;
    petWindow = null;
  });

  void win.loadURL(petUrl()).catch((err) => {
    console.warn('[pet] load falhou:', err);
  });
  startLookLoop();
  startRaiseWatch();
}

function destroyPetWindow(): void {
  stopDrag();
  stopLookLoop();
  stopRaiseWatch();
  petReady = false;
  petIgnoresMouse = true;
  petPinnedTop = false;
  pendingPetEvents.length = 0;
  if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
  petWindow = null;
}

function syncWindowToPrefs(): void {
  const current = getPrefs();
  const shouldShow = current.enabled && mainAppWindows().length > 0;
  if (shouldShow) createPetWindow();
  else destroyPetWindow();
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
    // Idempotent — mouseenter/leave no canto da tela dispara em rajada e cada
    // setIgnoreMouseEvents recompõe a janela transparente (pisca forte no macOS).
    applyIgnoreMouseEvents(interactive !== true);
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
    // Centro da janela (não o canto TL): na costura Mac↔LG o TL ainda está no
    // Mac e o getDisplayMatching errava o workArea do settle → salto.
    const display = screen.getDisplayNearestPoint({
      x: raw.x + Math.floor(PET_WINDOW_SIZE.width / 2),
      y: raw.y + Math.floor(PET_WINDOW_SIZE.height / 2),
    });
    // Settle num display (workArea + overhang moderado para cantos).
    const settled = clampPetDrag(
      raw,
      PET_WINDOW_SIZE,
      display.workArea,
      EDGE_OVERHANG_SETTLE,
    );
    if (gx !== settled.x || gy !== settled.y) {
      setPetBounds(settled);
    }
    persistPosition(settled);
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
      // Livre em todo o desktop virtual (Mac + LG sem parede).
      const clamped = clampDragFree(next);
      lastDragPos = clamped;
      if (clamped.x === lastApplied.x && clamped.y === lastApplied.y) return;
      lastApplied = clamped;
      // setBounds (setPosition falhava em panel transparente em alguns builds).
      setPetBounds(clamped);
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

  const watchAppWindow = (win: BrowserWindow) => {
    if (isPetWindow(win)) return;
    win.on('closed', () => {
      if (mainAppWindows().length === 0) destroyPetWindow();
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
    // Bounds do main só existem agora — evita pet a nascer sobre o explorer.
    reparkIfCoveringSidebar();
  });

  // NÃO escutar browser-window-focus: dispara em rajada e recompõe o pet
  // (pisca). activate / did-become-active bastam para Spaces / dock click.
  app.on('activate', () => {
    raisePetAboveAll(true);
  });
  app.on('did-become-active', () => {
    raisePetAboveAll(true);
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
}
