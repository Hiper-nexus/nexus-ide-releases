import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  CODEX_SHEET_COLS,
  CODEX_SHEET_ROWS,
  type PetInstalledListResult,
  type PetInstalledPreviewResult,
} from '../../shared/pet-types';
import { resolvePetsLibraryRoot } from './pet-library';

const MAX_SPRITESHEET_BYTES = 2.5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const DEFAULT_PREINSTALLED_PETS = [
  {
    id: '2e9cd7ac-dabd-4130-9bc5-782986aea0ed',
    displayName: 'Codex Companion',
    description:
      'A compact premium 3D toy Codex companion inspired by the reference: warm tan complexion, short dark hair, full dark beard, white shirt, and a silver wristwatch.',
    bundledSheetFile: 'codex-companion.webp',
  },
  {
    id: 'nivu',
    displayName: 'Nivu',
    description: 'Mascote Nivu — companheiro personalizável do NexusIDE.',
    bundledSheetFile: 'nivu.webp',
  },
];

export function ensureDefaultInstalledPets(
  codexHome?: string,
  libRootOverride?: string,
): void {
  try {
    const root = petsRoot(codexHome);
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true });
    }
    const realRoot = existsSync(root) ? realpathSync(root) : root;

    // Respeita exclusão explícita pelo operador: não reinstala em loop após delete
    const deletedFile = join(root, '.deleted-preinstalled.json');
    let deletedSet = new Set<string>();
    const deletedStat = lstatSync(deletedFile, { throwIfNoEntry: false });
    if (deletedStat && !deletedStat.isSymbolicLink()) {
      try {
        const arr = JSON.parse(readFileSync(deletedFile, 'utf8'));
        if (Array.isArray(arr)) deletedSet = new Set(arr);
      } catch {
        // ignore
      }
    }

    let libRoot = libRootOverride ?? '';
    if (!libRoot) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { app } = require('electron') as typeof import('electron');
        libRoot = resolvePetsLibraryRoot(
          app.getAppPath(),
          process.resourcesPath,
          app.isPackaged,
        );
      } catch {
        libRoot = resolvePetsLibraryRoot('', '', false);
      }
    }
    for (const pet of DEFAULT_PREINSTALLED_PETS) {
      if (deletedSet.has(pet.id)) continue;
      const targetDir = join(root, pet.id);
      const dirStat = lstatSync(targetDir, { throwIfNoEntry: false });
      if (dirStat?.isSymbolicLink()) continue; // Rejeita symlink (inclusive dangling)
      if (dirStat && !dirStat.isDirectory()) continue;
      if (dirStat) {
        const realTarget = realpathSync(targetDir);
        if (!isWithin(realRoot, realTarget) || basename(realTarget) !== pet.id) continue;
      }
      const targetSheet = join(targetDir, 'spritesheet.webp');
      const targetManifest = join(targetDir, 'pet.json');
      const sheetStat = lstatSync(targetSheet, { throwIfNoEntry: false });
      if (sheetStat?.isSymbolicLink()) continue; // Rejeita symlink (inclusive dangling)
      const manifestStat = lstatSync(targetManifest, { throwIfNoEntry: false });
      if (manifestStat?.isSymbolicLink()) continue; // Rejeita symlink (inclusive dangling)

      if (!sheetStat?.isFile() || !manifestStat?.isFile()) {
        const sourceSheet = join(libRoot, 'sheets', pet.bundledSheetFile);
        if (existsSync(sourceSheet)) {
          if (!dirStat) {
            mkdirSync(targetDir, { recursive: true });
          }
          const freshDirStat = lstatSync(targetDir, { throwIfNoEntry: false });
          if (freshDirStat?.isSymbolicLink()) continue;

          // Nunca sobrescreve arquivos existentes do usuário no pacote
          if (!sheetStat?.isFile()) {
            copyFileSync(sourceSheet, targetSheet);
          }
          if (!manifestStat?.isFile()) {
            writeFileSync(
              targetManifest,
              JSON.stringify(
                {
                  id: pet.id,
                  displayName: pet.displayName,
                  description: pet.description,
                  spriteVersionNumber: 2,
                  spritesheetPath: 'spritesheet.webp',
                },
                null,
                2,
              ),
              'utf8',
            );
          }
        }
      }
    }
  } catch {
    // Tolerante a erro em ambiente sem permissão
  }
}

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
  if (!codexHome) {
    ensureDefaultInstalledPets();
  }
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
  if (!codexHome) {
    ensureDefaultInstalledPets();
  }
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

    // Registra exclusão do pet padrão para que ensureDefaultInstalledPets não o ressuscite
    if (DEFAULT_PREINSTALLED_PETS.some((p) => p.id === id)) {
      try {
        const deletedFile = join(root, '.deleted-preinstalled.json');
        const deletedStat = lstatSync(deletedFile, { throwIfNoEntry: false });
        if (!deletedStat || !deletedStat.isSymbolicLink()) {
          let deletedList: string[] = [];
          if (deletedStat && !deletedStat.isDirectory()) {
            try {
              const parsed = JSON.parse(readFileSync(deletedFile, 'utf8'));
              if (Array.isArray(parsed)) deletedList = parsed;
            } catch {
              // ignore
            }
          }
          if (!deletedList.includes(id)) {
            deletedList.push(id);
            writeFileSync(deletedFile, JSON.stringify(deletedList, null, 2), 'utf8');
          }
        }
      } catch {
        // ignore
      }
    }

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
