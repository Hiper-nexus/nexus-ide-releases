import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  defaultPetPrefs,
  sanitizePetPrefsPatch,
  type PetPrefs,
} from '../../shared/pet-types';

/**
 * Persistência das prefs do pet em um arquivo próprio (userData/pet.json) —
 * isolado do settings.json para não acoplar o pet ao schema/testes de
 * settings. Escrita atômica (tmp + rename), leitura tolerante a lixo.
 */

export const PET_PREFS_FILENAME = 'pet.json';

export function petPrefsPath(userDataDir: string): string {
  return path.join(userDataDir, PET_PREFS_FILENAME);
}

export function loadPetPrefs(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
): PetPrefs {
  const defaults = defaultPetPrefs(platform);
  try {
    const raw = readFileSync(petPrefsPath(userDataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    // O arquivo em disco é input não confiável como qualquer outro: passa
    // pelo mesmo sanitizador do IPC e o que sobrar cai nos defaults.
    return { ...defaults, ...sanitizePetPrefsPatch(parsed) };
  } catch {
    return defaults;
  }
}

export function savePetPrefs(userDataDir: string, prefs: PetPrefs): void {
  const target = petPrefsPath(userDataDir);
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}
