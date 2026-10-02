/**
 * Nexus Redline (Linux) — preferência "mostrar na bandeja".
 *
 * Um booleano por instalação, em `<userData>/redline-linux.json` (mesma
 * família do marcador `redline-offer.json`). Fica de fora de
 * `~/.nexus/settings.json` de propósito: é preferência da máquina, não do
 * perfil sincronizável, e não mexe no schema compartilhado de configurações.
 *
 * LIGADO por padrão (F-739): sem arquivo nenhum, a bandeja aparece. No Mac e
 * no Windows o Redline é oferecido no primeiro boot; no Linux a única porta
 * era um botão em Uso e cotas, atrás do login, e o operador simplesmente não
 * via o Redline. Quem não quer usa "Ocultar da bandeja" (no menu do ícone ou
 * em Uso e cotas), que grava `false` — e essa escolha é respeitada para sempre.
 *
 * Só a AUSÊNCIA do arquivo liga. Arquivo presente vale pelo que diz, com
 * leitura estrita: ilegível, grande demais, FIFO, JSON quebrado ou qualquer
 * valor que não seja EXATAMENTE `true` significa desligado. Leitura nunca
 * lança; escrita lança (quem chama precisa dizer ao operador que não salvou).
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
  // `missing` = nunca houve escolha: padrão ligado. Qualquer outro "sem texto"
  // (rejeitado, ilegível, instável) é um arquivo que existe e não se entende.
  if (read.kind !== 'text') return read.kind === 'none' && read.stamp === 'missing';
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
