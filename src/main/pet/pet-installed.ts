import {
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  CODEX_SHEET_COLS,
  CODEX_SHEET_ROWS,
  type PetInstalledListResult,
  type PetInstalledPreviewResult,
} from '../../shared/pet-types';

const MAX_SPRITESHEET_BYTES = 2.5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

interface InstalledManifest {
  id: string;
  displayName?: string;
  description?: string;
  spriteVersionNumber: number;
  spritesheetPath: string;
}

function petsRoot(codexHome?: string): string {
  return join(
    resolve(codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')),
    'pets',
  );
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function parsePackage(
  id: string,
  codexHome?: string,
): {
  id: string;
  name: string;
  description?: string;
  sheetPath: string;
  mtimeMs: number;
} {
  if (!SAFE_ID_RE.test(id)) throw new Error('id de pet local inválido');
  const root = realpathSync(petsRoot(codexHome));
  const packageDir = realpathSync(join(root, id));
  if (!isWithin(root, packageDir) || basename(packageDir) !== id) {
    throw new Error('pacote de pet fora de ~/.codex/pets');
  }

  const manifestPath = join(packageDir, 'pet.json');
  const sheetPath = join(packageDir, 'spritesheet.webp');
  const manifestStat = statSync(manifestPath);
  const sheetStat = statSync(sheetPath);
  if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error('pet.json ausente ou grande demais');
  }
  if (
    !sheetStat.isFile() ||
    sheetStat.size === 0 ||
    sheetStat.size > MAX_SPRITESHEET_BYTES
  ) {
    throw new Error('spritesheet.webp ausente, vazio ou grande demais');
  }

  const header = readFileSync(sheetPath).subarray(0, 12);
  if (
    header.length < 12 ||
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error('spritesheet.webp inválido');
  }

  let manifest: InstalledManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as InstalledManifest;
  } catch {
    throw new Error('pet.json inválido');
  }
  if (
    manifest.id !== id ||
    manifest.spriteVersionNumber !== 2 ||
    manifest.spritesheetPath !== 'spritesheet.webp'
  ) {
    throw new Error('pacote não segue o contrato Codex v2');
  }
  return {
    id,
    name:
      typeof manifest.displayName === 'string' && manifest.displayName.trim()
        ? manifest.displayName.trim().slice(0, 96)
        : id,
    description:
      typeof manifest.description === 'string' && manifest.description.trim()
        ? manifest.description.trim().slice(0, 240)
        : undefined,
    sheetPath,
    mtimeMs: Math.max(sheetStat.mtimeMs, manifestStat.mtimeMs),
  };
}

/** Lista somente pacotes locais completos e seguros; lixo parcial não aparece. */
export function listInstalledPets(codexHome?: string): PetInstalledListResult {
  let entries: ReturnType<typeof parsePackage>[] = [];
  try {
    const root = petsRoot(codexHome);
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SAFE_ID_RE.test(entry.name))
      .flatMap((entry) => {
        try {
          return [parsePackage(entry.name, codexHome)];
        } catch {
          return [];
        }
      });
  } catch {
    return { ok: true, items: [] };
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return {
    ok: true,
    items: entries.map((entry) => ({
      id: entry.id,
      slug: entry.id,
      label: entry.name,
      ...(entry.description ? { note: entry.description } : {}),
    })),
  };
}

/** Carrega o preview/aplicação sem permitir path arbitrário vindo do renderer. */
export function loadInstalledPet(
  id: string,
  codexHome?: string,
): PetInstalledPreviewResult {
  try {
    const pet = parsePackage(id, codexHome);
    const dataUrl = `data:image/webp;base64,${readFileSync(pet.sheetPath).toString('base64')}`;
    return {
      ok: true,
      name: pet.name,
      sheet: {
        dataUrl,
        cols: CODEX_SHEET_COLS,
        rows: CODEX_SHEET_ROWS,
      },
    };
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof Error
          ? cause.message
          : 'não foi possível carregar o pet local',
    };
  }
}

/**
 * Apaga um pacote local em ~/.codex/pets/<id>. Só remove pastas filhas
 * diretas do root pets (sem traversal). A biblioteca embutida do app
 * não passa por aqui.
 */
export function deleteInstalledPet(
  id: string,
  codexHome?: string,
): { ok: boolean; name?: string; error?: string } {
  try {
    if (!SAFE_ID_RE.test(id)) {
      return { ok: false, error: 'id de pet local inválido' };
    }
    // Valida contrato + path seguro antes de apagar.
    const pet = parsePackage(id, codexHome);
    const root = realpathSync(petsRoot(codexHome));
    const packageDir = realpathSync(join(root, id));
    if (
      !isWithin(root, packageDir) ||
      basename(packageDir) !== id ||
      packageDir === root
    ) {
      return { ok: false, error: 'pacote de pet fora de ~/.codex/pets' };
    }
    rmSync(packageDir, { recursive: true, force: false });
    return { ok: true, name: pet.name };
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof Error
          ? cause.message
          : 'não foi possível apagar o pet local',
    };
  }
}
