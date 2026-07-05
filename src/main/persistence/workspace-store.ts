import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dialog, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import {
  WORKSPACE_CHANNELS,
  openWorkspaceSchema,
  type WorkspaceInfo,
  type WorkspaceState,
} from '../../shared/workspace-types';

/**
 * Workspace store: current + recent workspaces, persisted in
 * ~/.nexus/workspaces.json. The renderer's launch screen reads this to offer
 * "open recent" and the folder picker.
 */

const STORE_FILE = path.join(os.homedir(), '.nexus', 'workspaces.json');
const MAX_RECENTS = 12;

let state: WorkspaceState = { current: null, recents: [] };
const listeners = new Set<WebContents>();

function load(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    const recents = Array.isArray(raw?.recents)
      ? raw.recents.filter(
          (w: unknown): w is WorkspaceInfo =>
            typeof (w as WorkspaceInfo)?.path === 'string',
        )
      : [];
    const current =
      raw?.current && typeof raw.current.path === 'string' ? raw.current : null;
    // Drop entries whose directory no longer exists.
    const alive = recents.filter((w: WorkspaceInfo) => dirExists(w.path));
    state = {
      current: current && dirExists(current.path) ? current : null,
      recents: alive,
    };
  } catch {
    state = { current: null, recents: [] };
  }
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
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

function openWorkspace(dir: string): WorkspaceState {
  if (!dirExists(dir)) return state;
  const info = toInfo(dir);
  const recents = [
    info,
    ...state.recents.filter((w) => w.path !== dir),
  ].slice(0, MAX_RECENTS);
  state = { current: info, recents };
  persist();
  broadcast();
  return state;
}

export function registerWorkspaceListener(wc: WebContents): void {
  listeners.add(wc);
}

export function unregisterWorkspaceListener(wc: WebContents): void {
  listeners.delete(wc);
}

export function registerWorkspaceIpc(): void {
  load();

  ipcMain.handle(WORKSPACE_CHANNELS.get, () => state);

  ipcMain.handle(WORKSPACE_CHANNELS.pick, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Escolher pasta do workspace',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return state;
    return openWorkspace(result.filePaths[0]);
  });

  // Folder picker WITHOUT opening the workspace — the "Novo workspace" wizard
  // uses it for the PASTA step (the workspace only opens on the final launch).
  ipcMain.handle(WORKSPACE_CHANNELS.pickPath, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Escolher pasta do workspace',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(WORKSPACE_CHANNELS.open, (_event, raw) => {
    const parsed = openWorkspaceSchema.safeParse(raw);
    if (!parsed.success) return state;
    return openWorkspace(parsed.data.path);
  });

  ipcMain.handle(WORKSPACE_CHANNELS.close, () => {
    state = { ...state, current: null };
    persist();
    broadcast();
    return state;
  });

  ipcMain.handle(WORKSPACE_CHANNELS.remove, (_event, raw) => {
    const parsed = openWorkspaceSchema.safeParse(raw);
    if (!parsed.success) return state;
    state = {
      current:
        state.current?.path === parsed.data.path ? null : state.current,
      recents: state.recents.filter((w) => w.path !== parsed.data.path),
    };
    persist();
    broadcast();
    return state;
  });
}
