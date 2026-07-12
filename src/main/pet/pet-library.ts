/**
 * Biblioteca de pets embutida no app (resources/pets).
 *
 * 15 sprites Codex v2 curados e comprimidos (~2–3 MB no total) para o
 * cliente ter opções diversas sem depender da galeria online. A arte
 * original vem da comunidade petdex/codex-pets — ver NOTICE no pacote.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  CODEX_SHEET_COLS,
  CODEX_SHEET_ROWS,
  detectSheetGrid,
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
  cols?: number;
  rows?: number;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Só aceitamos sheets no subpath canônico do pacote. */
const SHEET_FILE_RE = /^sheets\/[a-z0-9][a-z0-9-]{0,62}\.webp$/;
/** Teto do arquivo em disco antes de materializar data URL (base64 ~4/3). */
const SHEET_FILE_MAX_BYTES = Math.floor((SHEET_DATA_URL_MAX * 3) / 4);

let cachedRoot: string | null = null;
let cachedManifest: ManifestEntry[] | null = null;

/** Diretório resources/pets — dev (repo) ou packaged (extraResource). */
export function resolvePetsLibraryRoot(
  appPath: string,
  resourcesPath: string,
  packaged: boolean,
  cwd: string = process.cwd(),
): string {
  if (packaged) {
    return path.join(resourcesPath, 'pets');
  }
  // Mesma estratégia do model-ranking: cwd do processo (vite/electron) e
  // appPath nem sempre coincidem com a raiz do repo em dev.
  const candidates = [
    path.join(cwd, 'resources', 'pets'),
    path.join(appPath, 'resources', 'pets'),
    path.join(appPath, '..', 'resources', 'pets'),
    path.join(appPath, '..', '..', 'resources', 'pets'),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'manifest.json'))) {
      return path.resolve(candidate);
    }
  }
  return path.resolve(candidates[0]);
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

function isSafeManifestEntry(item: unknown): item is ManifestEntry {
  if (!item || typeof item !== 'object') return false;
  const entry = item as ManifestEntry;
  if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) return false;
  if (typeof entry.label !== 'string' || entry.label.trim().length === 0) {
    return false;
  }
  if (entry.label.length > 128) return false;
  if (typeof entry.file !== 'string' || !SHEET_FILE_RE.test(entry.file)) {
    return false;
  }
  // file basename must match id (impede apontar sheet de outro id).
  if (entry.file !== `sheets/${entry.id}.webp`) return false;
  if (entry.slug !== undefined) {
    if (typeof entry.slug !== 'string' || !ID_RE.test(entry.slug)) return false;
  }
  if (entry.note !== undefined) {
    if (typeof entry.note !== 'string' || entry.note.length > 256) return false;
  }
  return true;
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
    cachedManifest = raw.filter(isSafeManifestEntry);
    return cachedManifest;
  } catch {
    cachedManifest = [];
    return cachedManifest;
  }
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

export function listPetLibrary(): PetLibraryListResult {
  try {
    const items: PetLibraryEntry[] = [];
    for (const entry of loadManifest()) {
      // Só listar o que realmente existe no pacote (manifest órfão some).
      if (!sheetPathFor(entry.id)) continue;
      items.push({
        id: entry.id,
        slug: entry.slug ?? entry.id,
        label: entry.label,
        note: entry.note,
      });
    }
    return { ok: true, items };
  } catch (err) {
    return {
      ok: false,
      error: `Biblioteca de pets indisponível (${err instanceof Error ? err.message : 'erro'}).`,
    };
  }
}

/**
 * Lê width/height de um WebP (VP8X / VP8L / VP8) sem dependências.
 * Usado para detectar malha 8×9 vs 8×11 a partir do arquivo real.
 */
export function readWebpDimensions(
  buf: Buffer,
): { width: number; height: number } | null {
  if (
    buf.byteLength < 30 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  let offset = 12;
  while (offset + 8 <= buf.byteLength) {
    const fourcc = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (dataStart > buf.byteLength) return null;
    if (fourcc === 'VP8X' && size >= 10 && dataStart + 10 <= buf.byteLength) {
      const width =
        1 +
        buf[dataStart + 4]! +
        (buf[dataStart + 5]! << 8) +
        (buf[dataStart + 6]! << 16);
      const height =
        1 +
        buf[dataStart + 7]! +
        (buf[dataStart + 8]! << 8) +
        (buf[dataStart + 9]! << 16);
      if (width > 0 && height > 0 && width <= 16384 && height <= 16384) {
        return { width, height };
      }
      return null;
    }
    if (fourcc === 'VP8L' && size >= 5 && dataStart + 5 <= buf.byteLength) {
      if (buf[dataStart] !== 0x2f) return null;
      const bits =
        buf[dataStart + 1]! |
        (buf[dataStart + 2]! << 8) |
        (buf[dataStart + 3]! << 16) |
        (buf[dataStart + 4]! << 24);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
    if (fourcc === 'VP8 ' && size >= 10 && dataStart + 10 <= buf.byteLength) {
      const sig = dataStart + 3;
      if (
        buf[sig] === 0x9d &&
        buf[sig + 1] === 0x01 &&
        buf[sig + 2] === 0x2a
      ) {
        const width = buf.readUInt16LE(sig + 3) & 0x3fff;
        const height = buf.readUInt16LE(sig + 5) & 0x3fff;
        if (width > 0 && height > 0) return { width, height };
      }
    }
    // Chunks são padados a 2 bytes.
    offset = dataStart + size + (size & 1);
  }
  return null;
}

/** Carrega o sheet da biblioteca como data URL pronto para PetPrefs.sheet. */
export function loadLibrarySheet(id: string): {
  ok: boolean;
  name?: string;
  sheet?: PetSheet;
  error?: string;
} {
  const trimmed = id.trim();
  if (!ID_RE.test(trimmed)) {
    return { ok: false, error: 'id de biblioteca inválido' };
  }
  const entry = loadManifest().find((item) => item.id === trimmed);
  if (!entry) return { ok: false, error: 'Pet da biblioteca não encontrado.' };
  const file = sheetPathFor(trimmed);
  if (!file) return { ok: false, error: 'Arquivo do pet ausente no pacote.' };
  try {
    const size = statSync(file).size;
    if (!Number.isFinite(size) || size <= 0 || size > SHEET_FILE_MAX_BYTES) {
      return { ok: false, error: 'Sheet da biblioteca com tamanho inválido.' };
    }
    const buf = readFileSync(file);
    if (buf.byteLength > SHEET_FILE_MAX_BYTES) {
      return { ok: false, error: 'Sheet da biblioteca excede o limite interno.' };
    }
    // WebP RIFF magic — evita data URL de lixo embutido por engano.
    if (
      buf.byteLength < 12 ||
      buf.toString('ascii', 0, 4) !== 'RIFF' ||
      buf.toString('ascii', 8, 12) !== 'WEBP'
    ) {
      return { ok: false, error: 'Sheet da biblioteca não é WebP válido.' };
    }
    const dataUrl = `data:image/webp;base64,${buf.toString('base64')}`;
    if (dataUrl.length > SHEET_DATA_URL_MAX) {
      return { ok: false, error: 'Sheet da biblioteca excede o limite interno.' };
    }
    // Dimensões reais do WebP (RIFF) > manifest — evita rows:11 stale.
    const dims = readWebpDimensions(buf);
    const detected = dims
      ? detectSheetGrid(dims.width, dims.height)
      : null;
    const cols =
      detected?.cols ??
      (typeof entry.cols === 'number' &&
      Number.isInteger(entry.cols) &&
      entry.cols >= 1 &&
      entry.cols <= 16
        ? entry.cols
        : CODEX_SHEET_COLS);
    const rows =
      detected?.rows ??
      (typeof entry.rows === 'number' &&
      Number.isInteger(entry.rows) &&
      entry.rows >= 1 &&
      entry.rows <= 16
        ? entry.rows
        : CODEX_SHEET_ROWS);
    return {
      ok: true,
      name: entry.label,
      sheet: {
        dataUrl,
        cols,
        rows,
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
