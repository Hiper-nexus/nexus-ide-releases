/**
 * Nexus Redline (Linux) — preferência "mostrar na bandeja".
 *
 * Um booleano por instalação, em `<userData>/redline-linux.json` (mesma
 * família do marcador `redline-offer.json`). Fica de fora de
 * `~/.nexus/settings.json` de propósito: é preferência da máquina, não do
 * perfil sincronizável, e não mexe no schema compartilhado de configurações.
 *
 * Opt-in: sem arquivo, arquivo ilegível ou valor que não seja EXATAMENTE
 * `true` significa desligado. Leitura nunca lança; escrita lança (quem chama
 * precisa dizer ao operador que não salvou).
 */

import path from 'node:path';
import { writeJsonAtomic } from '../util/atomic-write';
import { readRegularFileCapped } from './redline-safe-read';

export const REDLINE_LINUX_SETTINGS_FILE = 'redline-linux.json';
/** O arquivo tem uma chave; qualquer coisa maior que isso não é nosso. */
const MAX_SETTINGS_BYTES = 4096;

export function readRedlineLinuxEnabled(userDataDir: string): boolean {
  const read = readRegularFileCapped(
    path.join(userDataDir, REDLINE_LINUX_SETTINGS_FILE),
    MAX_SETTINGS_BYTES,
  );
  if (read.kind !== 'text') return false;
  try {
    const parsed: unknown = JSON.parse(read.text);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { enabled?: unknown }).enabled === true
    );
  } catch {
    return false;
  }
}

export function writeRedlineLinuxEnabled(userDataDir: string, enabled: boolean): void {
  writeJsonAtomic(path.join(userDataDir, REDLINE_LINUX_SETTINGS_FILE), { enabled });
}
