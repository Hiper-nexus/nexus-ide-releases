import { createHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * Resume verificado de rollouts do Codex (porte do desenho Orca #21102).
 *
 * Um restart perde os offsets em memória e forçaria revarrer rollouts de
 * vários MB do zero — além do custo, reemitir eventos com ordinal reiniciado
 * geraria ids diferentes para o mesmo uso (dupla contagem no store). Por isso
 * o scanner persiste por arquivo {offset, snapshot do ingest, digests} e só
 * retoma quando prova que o prefixo não mudou.
 *
 * A prova são dois digests sha256 de janelas de 4KB: head (cobre o
 * session_meta — toda rotação real o reescreve) e boundary (cobre os bytes
 * logo antes do offset de resume). O layout é função pura do offset, e abaixo
 * do piso as janelas se sobreporiam — então prefixos curtos nunca retomam
 * (reparse integral é mais barato e igualmente correto).
 *
 * Toda resposta errada aqui corrompe totais em silêncio: qualquer dúvida cai
 * para reparse integral. Fora do modelo (igual ao Orca): reescrita de mesmo
 * tamanho no MEIO do prefixo, longe das duas janelas — rollouts só sofrem
 * append/truncate/rotate na prática.
 */

export const BOUNDARY_WINDOW_BYTES = 4096;
export const HEAD_WINDOW_BYTES = 4096;

/**
 * Menor prefixo que vale retomar. Medido no oráculo de bytes do Orca: prefixo
 * de 12.191 B custa 21.234 B retomado contra 21.137 B a frio; aos 13.699 B a
 * retomada vence (21.234 B contra 22.645 B). 3 janelas arredonda para cima do
 * crossover com folga e garante janelas disjuntas.
 */
export const MIN_RESUMABLE_PREFIX_BYTES = 3 * BOUNDARY_WINDOW_BYTES;

export function isResumablePrefixLength(parsedBytes: number): boolean {
  return (
    Number.isSafeInteger(parsedBytes) && parsedBytes > MIN_RESUMABLE_PREFIX_BYTES
  );
}

export interface WindowRange {
  readonly start: number;
  readonly endExclusive: number;
}

export interface PrefixWindowLayout {
  readonly head: WindowRange;
  readonly boundary: WindowRange;
}

/** Layout puro em função do offset — a verificação hasheia os mesmos ranges. */
export function prefixWindowLayout(parsedBytes: number): PrefixWindowLayout {
  return {
    head: { start: 0, endExclusive: HEAD_WINDOW_BYTES },
    boundary: {
      start: parsedBytes - BOUNDARY_WINDOW_BYTES,
      endExclusive: parsedBytes,
    },
  };
}

async function readWindowDigest(
  handle: fs.promises.FileHandle,
  start: number,
  endExclusive: number,
): Promise<string | null> {
  const expectedBytes = endExclusive - start;
  if (expectedBytes <= 0) return null;
  try {
    const buffer = Buffer.allocUnsafe(expectedBytes);
    const { bytesRead } = await handle.read(buffer, 0, expectedBytes, start);
    if (bytesRead !== expectedBytes) return null;
    const hash = createHash('sha256').update(buffer.subarray(0, bytesRead));
    return `${expectedBytes}:${hash.digest('hex')}`;
  } catch {
    return null;
  }
}

export interface PrefixDigests {
  readonly headDigest: string;
  readonly boundaryDigest: string;
}

/**
 * Os dois digests de um prefixo, ou null se o arquivo não alcança o offset.
 * Só chamar para prefixo além de `MIN_RESUMABLE_PREFIX_BYTES` (janelas
 * disjuntas e em tamanho cheio).
 */
export async function readPrefixDigests(
  file: string,
  parsedBytes: number,
): Promise<PrefixDigests | null> {
  if (!isResumablePrefixLength(parsedBytes)) return null;
  const layout = prefixWindowLayout(parsedBytes);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, 'r');
    const headDigest = await readWindowDigest(
      handle,
      layout.head.start,
      layout.head.endExclusive,
    );
    const boundaryDigest = await readWindowDigest(
      handle,
      layout.boundary.start,
      layout.boundary.endExclusive,
    );
    if (!headDigest || !boundaryDigest) return null;
    return { headDigest, boundaryDigest };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Digest da janela de head para registros sem offset (skip). */
export async function readHeadDigest(file: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, 'r');
    return await readWindowDigest(handle, 0, HEAD_WINDOW_BYTES);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface DigestVerification {
  readonly offset: number;
  readonly headDigest: string;
  readonly boundaryDigest: string;
}

/** Reprova (false) em qualquer dúvida: tamanho, piso, layout ou digest. */
export async function verifyResumedPrefix(
  file: string,
  record: DigestVerification,
): Promise<boolean> {
  if (!isResumablePrefixLength(record.offset)) return false;
  let size: number;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    return false;
  }
  if (size < record.offset) return false;
  const current = await readPrefixDigests(file, record.offset);
  if (!current) return false;
  return (
    current.headDigest === record.headDigest &&
    current.boundaryDigest === record.boundaryDigest
  );
}

/**
 * Offset em bytes logo após o último `\n` do buffer, ou -1 se não há linha
 * completa. `\n` (0x0A) nunca aparece dentro de sequência multibyte UTF-8, então
 * retomar exatamente aí é fronteira limpa para decoder fresco + remainder ''.
 */
export function findLastLineBoundary(buffer: Buffer): number {
  const index = buffer.lastIndexOf(0x0a);
  return index < 0 ? -1 : index + 1;
}
