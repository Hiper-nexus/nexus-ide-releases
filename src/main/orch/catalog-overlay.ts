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

const MAX_OVERLAY_FILE_BYTES = 1 * 1024 * 1024;
const MAX_OVERLAY_PATCH_BYTES = 256 * 1024;
const MAX_OVERLAY_WORKSPACES = 128;
const MAX_OVERLAY_CATEGORIES = 512;

interface OverlayFile {
  workspaces: Record<string, CatalogOverlayState>;
}

export interface MainCatalogOverlayPatch extends CatalogOverlayPatch {
  readonly workspacePath?: string;
}

function overlayFile(): string {
  return path.join(os.homedir(), '.nexus', 'catalog-overlay.json');
}

function isValidStoredOverlay(
  key: string,
  value: unknown,
): value is CatalogOverlayState {
  if (
    key.length < 1 ||
    key.length > 4_096 ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return false;
  }
  const state = value as Partial<CatalogOverlayState>;
  const expectedWorkspacePath = key === 'global' ? undefined : key;
  if (state.workspacePath !== expectedWorkspacePath) return false;
  if (
    typeof state.updatedAt !== 'number' ||
    !Number.isFinite(state.updatedAt) ||
    state.updatedAt < 0
  ) {
    return false;
  }
  try {
    assertValidCatalogOverlayPatch({
      workspacePath: state.workspacePath,
      stacks: state.stacks,
      disabled: state.disabled,
      tombstones: state.tombstones,
      categories: state.categories,
    });
    return (
      state.stacks !== undefined &&
      state.disabled !== undefined &&
      state.tombstones !== undefined &&
      state.categories !== undefined
    );
  } catch {
    return false;
  }
}

function readFile(): OverlayFile {
  const file = overlayFile();
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_OVERLAY_FILE_BYTES) {
      return { workspaces: {} };
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as OverlayFile;
    if (
      raw &&
      raw.workspaces &&
      typeof raw.workspaces === 'object' &&
      !Array.isArray(raw.workspaces) &&
      Object.keys(raw.workspaces).length <= MAX_OVERLAY_WORKSPACES &&
      Object.entries(raw.workspaces).every(([key, value]) =>
        isValidStoredOverlay(key, value),
      )
    ) return raw;
  } catch {
    // Missing/corrupt overlay.
  }
  return { workspaces: {} };
}

export function assertValidCatalogOverlayPatch(
  patch: MainCatalogOverlayPatch,
): void {
  if (
    patch.workspacePath !== undefined &&
    (typeof patch.workspacePath !== 'string' || patch.workspacePath.length > 4_096)
  ) {
    throw new Error('invalid catalog overlay workspace');
  }
  const arrays: Array<[unknown, number, string]> = [
    [patch.stacks, 32, 'stacks'],
    [patch.disabled, 512, 'disabled'],
    [patch.tombstones, 512, 'tombstones'],
  ];
  for (const [value, max, label] of arrays) {
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length > max ||
      value.some((entry) =>
        typeof entry !== 'string' || entry.length < 1 || entry.length > 128,
      )
    ) {
      throw new Error(`invalid catalog overlay ${label}`);
    }
  }
  if (patch.categories !== undefined) {
    if (
      !patch.categories ||
      typeof patch.categories !== 'object' ||
      Array.isArray(patch.categories) ||
      Object.keys(patch.categories).length > MAX_OVERLAY_CATEGORIES ||
      Object.entries(patch.categories).some(
        ([key, value]) =>
          key.length < 1 ||
          key.length > 128 ||
          typeof value !== 'string' ||
          value.length < 1 ||
          value.length > 128,
      )
    ) {
      throw new Error('invalid catalog overlay categories');
    }
  }
  let bytes = Number.POSITIVE_INFINITY;
  try {
    bytes = Buffer.byteLength(JSON.stringify(patch), 'utf8');
  } catch {
    // Rejected below.
  }
  if (bytes > MAX_OVERLAY_PATCH_BYTES) {
    throw new Error('catalog overlay patch exceeds byte budget');
  }
}

function writeFile(data: OverlayFile): void {
  if (Object.keys(data.workspaces).length > MAX_OVERLAY_WORKSPACES) {
    throw new Error('catalog overlay workspace limit exceeded');
  }
  // `writeJsonAtomic` persists pretty-printed JSON; budget the exact encoding
  // that will reach disk rather than the smaller compact representation.
  const bytes = Buffer.byteLength(JSON.stringify(data, null, 2), 'utf8');
  if (bytes > MAX_OVERLAY_FILE_BYTES) {
    throw new Error('catalog overlay file byte budget exceeded');
  }
  writeJsonAtomic(overlayFile(), data);
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
  patch: MainCatalogOverlayPatch,
): CatalogOverlayState {
  assertValidCatalogOverlayPatch(patch);
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
