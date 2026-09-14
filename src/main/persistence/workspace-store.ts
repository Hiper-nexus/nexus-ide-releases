import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import type { WebContents } from 'electron';
import {
  WORKSPACE_CHANNELS,
  openWorkspaceSchema,
  type WorkspaceInfo,
  type WorkspaceLivenessEvent,
  type WorkspaceState,
} from '../../shared/workspace-types';
import {
  bindRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from './renderer-workspace-scope';
import { WorkspaceGrantRegistry } from './workspace-grants';
import {
  scheduleOrientationForWorkspace,
  stopOrientationForWorkspace,
} from '../context/orientation/orientation-bootstrap';

/**
 * Workspace store: current + recent workspaces, persisted in
 * ~/.nexus/workspaces.json. The renderer's launch screen reads this to offer
 * "open recent" and the folder picker.
 */

const STORE_FILE = path.join(os.homedir(), '.nexus', 'workspaces.json');
const MAX_RECENTS = 12;
const WORKSPACE_GRANT_TTL_MS = 30 * 60 * 1000;

let state: WorkspaceState = { current: null, recents: [] };
const listeners = new Set<WebContents>();
const workspaceGrants = new WorkspaceGrantRegistry(WORKSPACE_GRANT_TTL_MS);

function canonicalDirectory(candidate: string): string | null {
  try {
    const real = fs.realpathSync(path.resolve(candidate));
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function normalizeWorkspaceInfo(value: unknown): WorkspaceInfo | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<WorkspaceInfo>;
  if (typeof candidate.path !== 'string') return null;
  const canonical = canonicalDirectory(candidate.path);
  if (!canonical) return null;
  return {
    path: canonical,
    name:
      typeof candidate.name === 'string' && candidate.name.length > 0
        ? candidate.name
        : path.basename(canonical) || canonical,
    lastOpenedAt:
      typeof candidate.lastOpenedAt === 'number' &&
      Number.isFinite(candidate.lastOpenedAt)
        ? candidate.lastOpenedAt
        : 0,
  };
}

function load(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) as unknown;
    const value = raw as { recents?: unknown; current?: unknown };
    const alive = (Array.isArray(value?.recents) ? value.recents : [])
      .map(normalizeWorkspaceInfo)
      .filter((workspace): workspace is WorkspaceInfo => workspace !== null)
      .filter(
        (workspace, index, all) =>
          all.findIndex((candidate) => candidate.path === workspace.path) === index,
      );
    const current = normalizeWorkspaceInfo(value?.current);
    state = {
      current,
      recents: alive,
    };
  } catch {
    state = { current: null, recents: [] };
  }
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[workspace] failed to persist:', err);
  }
}

function broadcast(): void {
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(WORKSPACE_CHANNELS.changed, state);
  }
}

/** Caminho do current cujo sumiço já foi avisado ao renderer. */
let missingReported: string | null = null;

/**
 * A pasta do workspace corrente pode sumir com o app aberto (worktree
 * removido por outra ferramenta). `load()` só valida no boot; isto sonda
 * depois — no foco da janela e em cada spawn que cai por isso — e avisa o
 * renderer UMA vez por sumiço e uma vez pela volta. Não fecha o workspace
 * sozinho: panes vivos continuam vivos e decidir é do operador.
 */
export function probeCurrentWorkspaceLiveness(): WorkspaceLivenessEvent | null {
  const current = state.current;
  if (!current) {
    missingReported = null;
    return null;
  }
  const missing = canonicalDirectory(current.path) === null;
  const reported = missingReported === current.path;
  if (missing === reported) return null;
  missingReported = missing ? current.path : null;
  const event: WorkspaceLivenessEvent = {
    path: current.path,
    name: current.name,
    missing,
  };
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(WORKSPACE_CHANNELS.liveness, event);
  }
  return event;
}

export function getWorkspaceState(): WorkspaceState {
  return state;
}

/** The active workspace root, or the home dir when none is open. */
export function activeWorkspacePath(): string {
  return state.current?.path ?? os.homedir();
}

/** Sandbox de arquivos exige workspace REAL — nunca cair para o home. */
export function activeWorkspaceOrNull(): string | null {
  return state.current?.path ?? null;
}

function toInfo(dir: string): WorkspaceInfo {
  return { path: dir, name: path.basename(dir) || dir, lastOpenedAt: Date.now() };
}

function openWorkspace(dir: string, owner: WebContents): WorkspaceState {
  const canonical = canonicalDirectory(dir);
  if (!canonical) return state;
  bindRendererWorkspaceScope(owner, canonical);
  const info = toInfo(canonical);
  const recents = [
    info,
    ...state.recents.filter((w) => w.path !== canonical),
  ].slice(0, MAX_RECENTS);
  state = { current: info, recents };
  missingReported = null;
  persist();
  broadcast();
  // L1 structural map — async, never blocks open, never mutates the repo.
  scheduleOrientationForWorkspace(canonical);
  return state;
}

export function registerWorkspaceListener(wc: WebContents): void {
  listeners.add(wc);
}

export function unregisterWorkspaceListener(wc: WebContents): void {
  listeners.delete(wc);
  workspaceGrants.clear(wc);
  clearRendererWorkspaceScope(wc);
}

/**
 * Internal main-process capability for a directory it already created. The
 * normal IPC handler still consumes this owner-bound, one-use grant; no new
 * renderer-accessible bypass is introduced.
 */
export function grantWorkspacePathFromTrustedMain(
  owner: WebContents,
  candidate: string,
): string | null {
  const canonical = canonicalDirectory(candidate);
  if (!canonical) return null;
  workspaceGrants.grant(owner, canonical);
  return canonical;
}

export function registerWorkspaceIpc(): void {
  load();

  ipcMain.handle(WORKSPACE_CHANNELS.get, (event) => {
    if (state.current) {
      try {
        bindRendererWorkspaceScope(event.sender, state.current.path);
      } catch (error) {
        // Um current quarentenado (ex.: manifesto com lineage divergente) não
        // pode derrubar o hydrate inteiro — o operador precisa do launcher e
        // dos recents para conseguir abrir OUTRO workspace.
        console.warn(
          '[workspace] current quarentenado; degradando para o launcher:',
          error instanceof Error ? error.message : error,
        );
        return { ...state, current: null };
      }
    }
    return state;
  });

  ipcMain.handle(WORKSPACE_CHANNELS.pick, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: 'Escolher pasta do workspace',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return state;
    return openWorkspace(result.filePaths[0], event.sender);
  });

  // Folder picker WITHOUT opening the workspace — the "Novo workspace" wizard
  // uses it for the PASTA step (the workspace only opens on the final launch).
  ipcMain.handle(WORKSPACE_CHANNELS.pickPath, async (event): Promise<string | null> => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: 'Escolher pasta do workspace',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const canonical = canonicalDirectory(result.filePaths[0]);
    if (!canonical) return null;
    workspaceGrants.grant(event.sender, canonical);
    return canonical;
  });

  ipcMain.handle(WORKSPACE_CHANNELS.open, (event, raw) => {
    const parsed = openWorkspaceSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('workspace path is invalid');
    }
    const canonical = canonicalDirectory(parsed.data.path);
    if (!canonical) {
      throw new Error('workspace path is invalid or inaccessible');
    }
    const isRecent = state.recents.some((workspace) => workspace.path === canonical);
    if (!isRecent && !workspaceGrants.consume(event.sender, canonical)) {
      throw new Error('workspace path was not authorized by the folder picker');
    }
    return openWorkspace(canonical, event.sender);
  });

  ipcMain.handle(WORKSPACE_CHANNELS.close, (event) => {
    clearRendererWorkspaceScope(event.sender);
    stopOrientationForWorkspace();
    state = { ...state, current: null };
    missingReported = null;
    persist();
    broadcast();
    return state;
  });

  ipcMain.handle(WORKSPACE_CHANNELS.remove, (event, raw) => {
    const parsed = openWorkspaceSchema.safeParse(raw);
    if (!parsed.success) return state;
    const removedCurrent = state.current?.path === parsed.data.path;
    if (removedCurrent) clearRendererWorkspaceScope(event.sender);
    state = {
      current:
        state.current?.path === parsed.data.path ? null : state.current,
      recents: state.recents.filter((w) => w.path !== parsed.data.path),
    };
    if (removedCurrent) missingReported = null;
    persist();
    broadcast();
    return state;
  });
}
