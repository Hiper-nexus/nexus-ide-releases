import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * User-added custom model ids per adapter. Providers ship a curated list, but a
 * CLI can offer more (or newer) models than we bundle — this lets the user add
 * any model id (e.g. "glm-5.2", "gpt-5.6") and have it appear everywhere the
 * adapter's models show (provider settings, Modo Livre picker, squad roster).
 *
 * Standalone (no imports from the registry/config) so the adapter registry can
 * merge these in without an import cycle. Persisted to ~/.nexus/custom-models.json.
 */

const FILE = path.join(os.homedir(), '.nexus', 'custom-models.json');

let cache: Record<string, string[]> | null = null;

function load(): Record<string, string[]> {
  if (cache) return cache;
  let loaded: Record<string, string[]> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object') loaded = raw;
  } catch {
    loaded = {};
  }
  cache = loaded;
  return loaded;
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache ?? {}, null, 2));
  } catch (err) {
    console.warn('[custom-models] failed to persist:', err);
  }
}

export function getCustomModels(adapterId: string): string[] {
  return load()[adapterId] ?? [];
}

export function addCustomModel(adapterId: string, model: string): void {
  const clean = model.trim();
  if (!clean) return;
  const store = load();
  const list = store[adapterId] ?? [];
  if (!list.includes(clean)) {
    store[adapterId] = [...list, clean];
    persist();
  }
}

export function removeCustomModel(adapterId: string, model: string): void {
  const store = load();
  const list = store[adapterId];
  if (!list) return;
  store[adapterId] = list.filter((m) => m !== model);
  persist();
}
