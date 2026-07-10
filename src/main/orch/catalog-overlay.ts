import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CatalogOverlayState,
  CatalogOverlayPatch,
  RecipeSuggestion,
} from '../../shared/types';
import { writeJsonAtomic } from '../util/atomic-write';
import { detectWorkspaceStacks } from './stack-detector';

const FILE = path.join(os.homedir(), '.nexus', 'catalog-overlay.json');

interface OverlayFile {
  workspaces: Record<string, CatalogOverlayState>;
}

function readFile(): OverlayFile {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as OverlayFile;
    if (raw && typeof raw.workspaces === 'object') return raw;
  } catch {
    // Missing/corrupt overlay.
  }
  return { workspaces: {} };
}

function writeFile(data: OverlayFile): void {
  writeJsonAtomic(FILE, data);
}

function keyOf(workspacePath?: string): string {
  return workspacePath ? path.resolve(workspacePath) : 'global';
}

export function getCatalogOverlay(workspacePath?: string): CatalogOverlayState {
  const key = keyOf(workspacePath);
  const file = readFile();
  return (
    file.workspaces[key] ?? {
      workspacePath: key === 'global' ? undefined : key,
      stacks: [],
      disabled: [],
      tombstones: [],
      categories: {},
      updatedAt: 0,
    }
  );
}

export function saveCatalogOverlay(
  patch: CatalogOverlayPatch,
): CatalogOverlayState {
  const key = keyOf(patch.workspacePath);
  const file = readFile();
  const current = getCatalogOverlay(patch.workspacePath);
  const next: CatalogOverlayState = {
    ...current,
    workspacePath: key === 'global' ? undefined : key,
    ...(patch.stacks ? { stacks: patch.stacks } : {}),
    ...(patch.disabled ? { disabled: patch.disabled } : {}),
    ...(patch.tombstones ? { tombstones: patch.tombstones } : {}),
    ...(patch.categories ? { categories: patch.categories } : {}),
    updatedAt: Date.now(),
  };
  file.workspaces[key] = next;
  writeFile(file);
  return next;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function effectiveStacks(workspacePath?: string): string[] {
  const overlay = getCatalogOverlay(workspacePath);
  return uniq([...detectWorkspaceStacks(workspacePath), ...overlay.stacks]);
}

export function proposeRecipes(workspacePath?: string): RecipeSuggestion[] {
  const stacks = effectiveStacks(workspacePath);
  const out: RecipeSuggestion[] = [];
  if (stacks.some((s) => ['react', 'vite', 'node'].includes(s))) {
    out.push({
      id: 'web-ship',
      title: 'Web app shipping squad',
      stacks,
      agents: ['architect', 'frontend', 'reviewer'],
      tools: [
        'nexus_preview_start',
        'nexus_browser_open',
        'nexus_browser_read',
        'nexus_browser_click',
        'nexus_browser_fill',
        'nexus_browser_wait',
        'nexus_browser_screenshot',
      ],
      gaps: [],
    });
  }
  if (stacks.includes('electron')) {
    out.push({
      id: 'electron-release',
      title: 'Electron release hardening',
      stacks,
      agents: ['architect', 'executor', 'reviewer'],
      tools: ['nexus_perf_snapshot', 'nexus_pane_read'],
      gaps: ['gap:notarization_status: requires Apple notary result'],
    });
  }
  out.push({
    id: 'remote-ops',
    title: 'Remote ops bridge',
    stacks,
    agents: ['orchestrator', 'executor'],
    tools: ['nexus_remote_bridge_status', 'nexus_remote_tmux_list', 'nexus_remote_spawn'],
    gaps: [],
  });
  return out;
}
