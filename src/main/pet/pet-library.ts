/**
 * Biblioteca de pets embutida no app (resources/pets).
 *
 * 15 sprites Codex v2 curados e comprimidos (~2–3 MB no total) para o
 * cliente ter opções diversas sem depender da galeria online. A arte
 * original vem da comunidade petdex/codex-pets — ver NOTICE no pacote.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CODEX_SHEET_COLS,
  CODEX_SHEET_ROWS,
  SHEET_DATA_URL_MAX,
  type PetLibraryEntry,
  type PetLibraryListResult,
  type PetSheet,
} from '../../shared/pet-types';

interface ManifestEntry {
  id: string;
  slug: string;
  label: string;
  note?: string;
  file: string;
  bytes?: number;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

let cachedRoot: string | null = null;
let cachedManifest: ManifestEntry[] | null = null;

/** Diretório resources/pets — dev (repo) ou packaged (extraResource). */
export function resolvePetsLibraryRoot(
  appPath: string,
  resourcesPath: string,
  packaged: boolean,
): string {
  if (packaged) {
    return path.join(resourcesPath, 'pets');
  }
  // plugin-vite: app.getAppPath() costuma ser a pasta do projeto em dev.
  return path.join(appPath, 'resources', 'pets');
}

export function configurePetsLibraryRoot(root: string): void {
  cachedRoot = root;
  cachedManifest = null;
}

function libraryRoot(): string {
  if (cachedRoot) return cachedRoot;
  // Lazy electron import keeps unit tests free of app bootstrap.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron');
  cachedRoot = resolvePetsLibraryRoot(
    app.getAppPath(),
    process.resourcesPath,
    app.isPackaged,
  );
  return cachedRoot;
}

function loadManifest(): ManifestEntry[] {
  if (cachedManifest) return cachedManifest;
  const file = path.join(libraryRoot(), 'manifest.json');
  if (!existsSync(file)) {
    cachedManifest = [];
    return cachedManifest;
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(raw)) {
      cachedManifest = [];
      return cachedManifest;
    }
    cachedManifest = raw.filter(
      (item): item is ManifestEntry =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as ManifestEntry).id === 'string' &&
        ID_RE.test((item as ManifestEntry).id) &&
        typeof (item as ManifestEntry).label === 'string' &&
        typeof (item as ManifestEntry).file === 'string' &&
        !(item as ManifestEntry).file.includes('..') &&
        !(item as ManifestEntry).file.startsWith('/'),
    );
    return cachedManifest;
  } catch {
    cachedManifest = [];
    return cachedManifest;
  }
}

export function listPetLibrary(): PetLibraryListResult {
  const items: PetLibraryEntry[] = loadManifest().map((entry) => ({
    id: entry.id,
    slug: entry.slug ?? entry.id,
    label: entry.label,
    note: entry.note,
  }));
  return { ok: true, items };
}

function sheetPathFor(id: string): string | null {
  if (!ID_RE.test(id)) return null;
  const entry = loadManifest().find((item) => item.id === id);
  if (!entry) return null;
  const full = path.resolve(libraryRoot(), entry.file);
  const root = path.resolve(libraryRoot());
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!existsSync(full)) return null;
  return full;
}

/** Carrega o sheet da biblioteca como data URL pronto para PetPrefs.sheet. */
export function loadLibrarySheet(id: string): {
  ok: boolean;
  name?: string;
  sheet?: PetSheet;
  error?: string;
} {
  const entry = loadManifest().find((item) => item.id === id);
  if (!entry) return { ok: false, error: 'Pet da biblioteca não encontrado.' };
  const file = sheetPathFor(id);
  if (!file) return { ok: false, error: 'Arquivo do pet ausente no pacote.' };
  try {
    const buf = readFileSync(file);
    const dataUrl = `data:image/webp;base64,${buf.toString('base64')}`;
    if (dataUrl.length > SHEET_DATA_URL_MAX) {
      return { ok: false, error: 'Sheet da biblioteca excede o limite interno.' };
    }
    return {
      ok: true,
      name: entry.label,
      sheet: {
        dataUrl,
        cols: CODEX_SHEET_COLS,
        rows: CODEX_SHEET_ROWS,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `Falha ao ler pet da biblioteca (${err instanceof Error ? err.message : 'erro'}).`,
    };
  }
}

export function __resetPetLibraryCacheForTests(): void {
  cachedRoot = null;
  cachedManifest = null;
}
