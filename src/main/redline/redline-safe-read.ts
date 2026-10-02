/**
 * Nexus Redline (Linux) — leitura limitada de arquivo que não é nosso.
 *
 * O snapshot e a preferência vivem em diretórios graváveis pelo usuário, que
 * outro processo (ou um gerenciador de dotfiles) pode ter trocado por FIFO,
 * dispositivo infinito ou arquivo gigante. `readFileSync(path)` num FIFO
 * pendura o Main para sempre. Aqui o arquivo é aberto UMA vez com
 * `O_NONBLOCK`, conferido no próprio descritor (arquivo regular, dentro do
 * teto) e lido em no máximo `teto + 1` bytes: não há janela entre o stat e o
 * read. Symlink para arquivo regular é seguido de propósito (dotfiles).
 */

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';

export type SafeRead =
  /** `stamp` = `mtimeMs:tamanho`, para o chamador pular leituras repetidas. */
  | { kind: 'text'; stamp: string; text: string }
  /** O stamp conhecido ainda vale: nada foi lido. */
  | { kind: 'unchanged' }
  /** Ausente, ilegível, não regular ou acima do teto. */
  | { kind: 'none'; stamp: string };

const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

export function readRegularFileCapped(
  file: string,
  maxBytes: number,
  knownStamp?: string,
): SafeRead {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | O_NONBLOCK);
  } catch {
    return { kind: 'none', stamp: 'missing' };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) {
      return { kind: 'none', stamp: `rejected:${stat.size}` };
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (knownStamp !== undefined && stamp === knownStamp) return { kind: 'unchanged' };
    // Um byte a mais que o tamanho visto: se vier, o arquivo cresceu no meio.
    const buffer = Buffer.alloc(stat.size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    if (filled > stat.size) return { kind: 'none', stamp: 'unstable' };
    return { kind: 'text', stamp, text: buffer.toString('utf8', 0, filled) };
  } catch {
    return { kind: 'none', stamp: 'unreadable' };
  } finally {
    closeSync(fd);
  }
}
