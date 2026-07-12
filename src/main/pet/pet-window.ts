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
import {
  AgentAttentionTracker,
  AgentTransitionTracker,
  MissionTransitionTracker,
} from './pet-events';
import { tapAgentHookStatus } from '../agent-hooks/hook-ingest';
import { computeLookDir } from './pet-look';
import { fetchGalleryCatalog, importGalleryPet } from './pet-gallery';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Desktop pet: uma janela transparente, sempre-no-topo e fora da taskbar que
 * flutua sobre o desktop com o mascote pixel. Click-through por padrão — o
 * renderer avisa quando o cursor está sobre o sprite/balão e só então a
 * janela aceita mouse. Opt-in (prefs.enabled), vive apenas enquanto houver
 * uma janela principal, e dorme sob demanda (sem balões).
 */

/** Janela maior: sprite ~150px lê de longe (paridade com o pet do Codex). */
export const PET_WINDOW_SIZE = { width: 300, height: 270 } as const;
const DRAG_TICK_MS = 16;
/** Teto de um arrasto: além disso o watchdog assenta a janela sozinho. */
const DRAG_MAX_MS = 30_000;
/** Cadência do look (cursor → direção do olhar). 16 passos não pedem 60fps. */
const LOOK_TICK_MS = 150;
/** Cursor parado além disso = o pet volta a digitar (idle). */
const LOOK_CURSOR_IDLE_MAX_MS = 4_000;

let petWindow: BrowserWindow | null = null;
let prefs: PetPrefs | null = null;
let dragTimer: NodeJS.Timeout | null = null;
let dragOffset = { x: 0, y: 0 };
let initialized = false;
let lookTimer: NodeJS.Timeout | null = null;
let lookLastSent: number | null = null;
let lookLastCursor = { x: 0, y: 0 };
let lookLastMoveAt = 0;

const agentTracker = new AgentTransitionTracker();
const attentionTracker = new AgentAttentionTracker();
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

function stopLookLoop(): void {
  if (lookTimer) {
    clearInterval(lookTimer);
    lookTimer = null;
  }
  lookLastSent = null;
}

function sendLook(dir: number | null): void {
  if (dir === lookLastSent) return;
  lookLastSent = dir;
  if (petWindow && !petWindow.isDestroyed() && !petWindow.webContents.isCrashed()) {
    petWindow.webContents.send(PET_CHANNELS.look, dir);
  }
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
    const cursor = screen.getCursorScreenPoint();
    const now = Date.now();
    if (cursor.x !== lookLastCursor.x || cursor.y !== lookLastCursor.y) {
      lookLastCursor = { x: cursor.x, y: cursor.y };
      lookLastMoveAt = now;
    }
    sendLook(
      computeLookDir(cursor, petWindow.getBounds(), {
        cursorIdleMs: now - lookLastMoveAt,
        maxIdleMs: LOOK_CURSOR_IDLE_MAX_MS,
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
    stopLookLoop();
    petWindow = null;
  });

  void win.loadURL(petUrl()).catch((err) => {
    console.warn('[pet] load falhou:', err);
  });
  startLookLoop();
}

function destroyPetWindow(): void {
  stopDrag();
  stopLookLoop();
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
    if (state === 'exited') {
      agentTracker.forget(sessionId);
      attentionTracker.forget(sessionId);
    }
  });
  // Hooks explícitos do provider: waiting/blocked = "um agente precisa de
  // você" — o aviso operacional nº 1 do pet.
  tapAgentHookStatus((sessionId, state) => {
    const event = attentionTracker.ingest(sessionId, state, Date.now());
    if (event) sendPetEvent(event);
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
