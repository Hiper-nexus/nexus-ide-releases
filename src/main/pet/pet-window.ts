import path from 'node:path';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  PET_CHANNELS,
  sanitizePetPrefsPatch,
  type PetEvent,
  type PetPrefs,
} from '../../shared/pet-types';
import { RENDERER_PROTOCOL_ENTRY_URL } from '../renderer-protocol';
import { tapSessionState } from '../pty/pty-manager';
import { tapMissionsBroadcast, tapMissionsSeed } from '../orch/orch-ipc';
import { loadPetPrefs, savePetPrefs } from './pet-prefs';
import { clampToWorkArea, snapToCorner } from './pet-geometry';
import { AgentTransitionTracker, MissionTransitionTracker } from './pet-events';

/**
 * Desktop pet: uma janela transparente, sempre-no-topo e fora da taskbar que
 * flutua sobre o desktop com o mascote pixel. Click-through por padrão — o
 * renderer avisa quando o cursor está sobre o sprite/balão e só então a
 * janela aceita mouse. Opt-in (prefs.enabled), vive apenas enquanto houver
 * uma janela principal, e dorme sob demanda (sem balões).
 */

export const PET_WINDOW_SIZE = { width: 240, height: 200 } as const;
const DRAG_TICK_MS = 16;
/** Teto de um arrasto: além disso o watchdog assenta a janela sozinho. */
const DRAG_MAX_MS = 30_000;

let petWindow: BrowserWindow | null = null;
let prefs: PetPrefs | null = null;
let dragTimer: NodeJS.Timeout | null = null;
let dragOffset = { x: 0, y: 0 };
let initialized = false;

const agentTracker = new AgentTransitionTracker();
const missionTracker = new MissionTransitionTracker();

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

function defaultPosition(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - PET_WINDOW_SIZE.width - 24,
    y: area.y + area.height - PET_WINDOW_SIZE.height - 24,
  };
}

function restoredPosition(): { x: number; y: number } {
  const saved = getPrefs().position;
  if (!saved) return defaultPosition();
  // O display salvo pode ter sido desconectado: clampa para a workArea do
  // display mais próximo da posição salva.
  const display = screen.getDisplayMatching({
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
  });
  return clampToWorkArea(saved, PET_WINDOW_SIZE, display.workArea);
}

function broadcastPrefs(): void {
  const current = getPrefs();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isCrashed()) {
      win.webContents.send(PET_CHANNELS.prefsChanged, current);
    }
  }
}

function sendPetEvent(event: PetEvent): void {
  const current = getPrefs();
  if (current.sleeping) return;
  if (
    petWindow &&
    !petWindow.isDestroyed() &&
    !petWindow.webContents.isCrashed()
  ) {
    petWindow.webContents.send(PET_CHANNELS.event, event);
  }
}

function stopDrag(): void {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
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

function createPetWindow(): void {
  if (creatingPetWindow) return;
  if (petWindow && !petWindow.isDestroyed()) return;
  const position = restoredPosition();

  creatingPetWindow = true;
  const win = new BrowserWindow({
    ...PET_WINDOW_SIZE,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false, // movimento é nosso (drag manual + snap)
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Nunca rouba o foco do terminal do usuário: pet é presença, não janela.
    focusable: false,
    alwaysOnTop: true,
    title: 'NexusIDE Pet',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'pet-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  petWindow = win;
  creatingPetWindow = false;

  // Mesma postura de segurança da janela principal.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-through até o renderer marcar uma área interativa sob o cursor.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.on('closed', () => {
    stopDrag();
    petWindow = null;
  });

  void win.loadURL(petUrl()).catch((err) => {
    console.warn('[pet] load falhou:', err);
  });
}

function destroyPetWindow(): void {
  stopDrag();
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

  ipcMain.on(PET_CHANNELS.setInteractive, (event, interactive: unknown) => {
    if (!fromPetWindow(event) || !petWindow) return;
    petWindow.setIgnoreMouseEvents(interactive !== true, { forward: true });
  });

  // Assenta a janela onde parou (snap + clamp) e persiste. Usado pelo
  // dragEnd normal e pelo watchdog do arrasto.
  const settleDrag = (): void => {
    stopDrag();
    if (!petWindow || petWindow.isDestroyed()) return;
    const [x, y] = petWindow.getPosition();
    const display = screen.getDisplayMatching({
      x,
      y,
      width: PET_WINDOW_SIZE.width,
      height: PET_WINDOW_SIZE.height,
    });
    const snapped = snapToCorner({ x, y }, PET_WINDOW_SIZE, display.workArea);
    petWindow.setPosition(snapped.x, snapped.y);
    persistPosition(snapped);
  };

  ipcMain.on(PET_CHANNELS.dragBegin, (event, rawOffset: unknown) => {
    if (!fromPetWindow(event) || !petWindow) return;
    const offset = (rawOffset ?? {}) as Record<string, unknown>;
    const clamp = (value: unknown, max: number): number =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(value, 0), max)
        : 0;
    dragOffset = {
      x: clamp(offset.x, PET_WINDOW_SIZE.width),
      y: clamp(offset.y, PET_WINDOW_SIZE.height),
    };
    stopDrag();
    // Watchdog: se o dragEnd do renderer se perder (janela virou
    // click-through no instante errado, renderer morreu), o pet NÃO fica
    // grudado no cursor para sempre — assenta sozinho.
    const startedAt = Date.now();
    dragTimer = setInterval(() => {
      if (!petWindow || petWindow.isDestroyed()) {
        stopDrag();
        return;
      }
      if (Date.now() - startedAt > DRAG_MAX_MS) {
        settleDrag();
        return;
      }
      const cursor = screen.getCursorScreenPoint();
      petWindow.setPosition(
        Math.round(cursor.x - dragOffset.x),
        Math.round(cursor.y - dragOffset.y),
      );
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
}

function wireOperationalEvents(): void {
  tapSessionState((sessionId, state) => {
    const event = agentTracker.ingest(sessionId, state, Date.now());
    if (event) sendPetEvent(event);
    if (state === 'exited') agentTracker.forget(sessionId);
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
  });

  syncWindowToPrefs();
}
