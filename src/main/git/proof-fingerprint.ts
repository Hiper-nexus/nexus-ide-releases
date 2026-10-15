import { createHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * Fingerprint barato (fs puro, sem spawn) do estado que alimenta uma prova de
 * identidade Git. Os tokens cobrem dev/ino/size/mtimeNs/ctimeNs — o ctimeNs
 * denuncia trocas que preservam o mtime (`touch -r`); o conteúdo (sha256)
 * entra no token de arquivos pequenos tipo HEAD/gitdir/commondir.
 *
 * Falha FECHADA: qualquer stat/leitura que não dá certo devolve null, e quem
 * cacheia por fingerprint trata null como "não consigo provar que o cache
 * ainda vale" e recomputa pelo caminho normal.
 */

export function statToken(file: string): string | null {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `s:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return null;
  }
}

/** stat + hash do conteúdo de um arquivo pequeno (ponteiros do Git). */
export function smallFileToken(file: string, maxBytes = 8192): string | null {
  const token = statToken(file);
  if (token === null) return null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
      const digest = createHash('sha256')
        .update(buffer.subarray(0, bytesRead))
        .digest('hex')
        .slice(0, 16);
      return `${token}:c${digest}`;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}
