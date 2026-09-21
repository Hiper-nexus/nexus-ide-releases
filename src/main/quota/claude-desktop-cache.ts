/**
 * Cache de uso do Claude Desktop — port do `ClaudeDesktopUsageCache` do
 * Codenotch. Terceira fonte para os mesmos números: o Desktop (Chromium)
 * grava a resposta de `GET /api/organizations/<id>/usage` num Simple Cache
 * em disco. Sem token, sem keychain, sem request à Anthropic — leitura
 * local de um arquivo que o app do usuário já escreveu.
 *
 * Por que existe: quando o login do `claude` CLI morre (grant revogado,
 * keychain esvaziado), a conta continua viva no Desktop — e este cache é a
 * única fonte que ainda responde. A org do cache key casa com o
 * `oauthAccount.organizationUuid` do perfil, então uma leitura NUNCA cai na
 * linha de outra conta.
 *
 * Formato lido (somente o necessário, igual ao original):
 *  - entry `*_0` em `Cache/Cache_Data` — stream 0 guarda a resposta
 *  - header 24B: magic u64 LE + 3×u32 + 4B pad; keyLength u32 @12
 *  - body zstd a partir de 24+keyLength; trailer depois do frame tem os
 *    headers HTTP em blocos separados por NUL (de lá sai o `Date:`)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { QuotaWindow } from '../../shared/quota-types';
import { parseClaudeCachedUtilization } from './claude-account-usage';

const HEADER_BYTES = 24;
const ENTRY_MAGIC = 0xfcfb6d1ba7725c30n;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
/** Resposta de usage tem ~4 kB; folga de ordens de grandeza. */
const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_KEY_BYTES = 8 * 1024;
const MAX_DECOMPRESSED_BYTES = 256 * 1024;
/** O alvo é reescrito a cada refresh do Desktop — sempre entre os recentes. */
const MAX_ENTRIES_EXAMINED = 400;
/** Frescor aceitável — mesma janela do `cachedUsageUtilization` do CLI. */
export const CLAUDE_DESKTOP_CACHE_FRESH_MS = 30 * 60 * 1000;

export function claudeDesktopCacheDirectory(home = os.homedir()): string {
  return path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'Cache',
    'Cache_Data',
  );
}

function readU32LE(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

function readU64LE(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off);
}

/** A chave do entry, ou null quando os bytes não são um Simple Cache entry. */
function entryKey(entry: Buffer): string | null {
  if (entry.length <= HEADER_BYTES) return null;
  if (readU64LE(entry, 0) !== ENTRY_MAGIC) return null;
  const keyLength = readU32LE(entry, 12);
  if (keyLength <= 0 || keyLength > MAX_KEY_BYTES) return null;
  if (HEADER_BYTES + keyLength > entry.length) return null;
  return entry.toString('utf8', HEADER_BYTES, HEADER_BYTES + keyLength);
}

/**
 * A org que a URL de usage no key nomeia — `/api/organizations/<id>/usage`
 * (2 segmentos exatos; `?skip_spend=1` e afins não fazem parte). Host check
 * primeiro: sem ele, qualquer site com path parecido viraria candidato.
 */
function usageOrganizationInKey(key: string): string | null {
  if (!key.includes('claude.ai') && !key.includes('anthropic.com')) return null;
  const marker = '/api/organizations/';
  const at = key.indexOf(marker);
  if (at < 0) return null;
  const path = key
    .slice(at + marker.length)
    .split(/[?#]/, 1)[0] ?? '';
  const segments = path.split('/');
  if (segments.length !== 2 || !segments[0] || segments[1] !== 'usage') {
    return null;
  }
  return segments[0];
}

/**
 * Tamanho do frame zstd no início de `buf` — o `ZSTD_findFrameCompressedSize`
 * do original, reimplementado: header + soma dos blocos até Last_Block +
 * checksum opcional. Node não expõe a função, e o decompress rejeita bytes
 * além do frame (o trailer do Chromium vem colado depois dele).
 */
function zstdFrameSize(buf: Buffer): number | null {
  if (buf.length < 6) return null;
  for (let i = 0; i < ZSTD_MAGIC.length; i += 1) {
    if (buf[i] !== ZSTD_MAGIC[i]) return null;
  }
  const descriptor = buf[4]!;
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const checksum = (descriptor & 0x04) !== 0;
  const dictFlag = descriptor & 0x03;

  let off = 5;
  if (!singleSegment) off += 1; // Window_Descriptor
  off += dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : dictFlag === 3 ? 4 : 0;
  const fcsBytes =
    fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : fcsFlag === 3 ? 8 : singleSegment ? 1 : 0;
  off += fcsBytes;
  if (off > buf.length) return null;

  // Blocos: header 3B LE → last(1b) | type(2b) | size(21b). Tipos zstd:
  // 0=Raw e 2=Compressed carregam `size` bytes no stream; 1=RLE carrega 1.
  for (;;) {
    if (off + 3 > buf.length) return null;
    const header = buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16);
    const last = (header & 1) !== 0;
    const type = (header >> 1) & 0x03;
    const size = header >> 3;
    off += 3;
    off += type === 1 ? 1 : size;
    if (off > buf.length) return null;
    if (last) break;
  }
  if (checksum) off += 4;
  return off <= buf.length ? off : null;
}

/** `Date:`/`date:` no bloco de headers que segue o body (separados por NUL). */
function httpDateInTrailer(trailer: Buffer): number | null {
  for (const name of ['\0date:', '\0Date:']) {
    const at = trailer.indexOf(name, 0, 'latin1');
    if (at < 0) continue;
    const valueStart = at + name.length;
    const end = trailer.indexOf(0x00, valueStart);
    if (end < 0) continue;
    const text = trailer.toString('latin1', valueStart, end).trim();
    const ms = Date.parse(text);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

interface ParsedEntry {
  body: unknown;
  organization: string;
  capturedAt: number | null;
}

function parseEntry(entry: Buffer, fileMtimeMs: number | null): ParsedEntry | null {
  const key = entryKey(entry);
  if (!key) return null;
  const organization = usageOrganizationInKey(key);
  if (!organization) return null;

  const bodyStart = HEADER_BYTES + Buffer.byteLength(key, 'utf8');
  if (entry.length - bodyStart <= ZSTD_MAGIC.length) return null;
  for (let i = 0; i < ZSTD_MAGIC.length; i += 1) {
    if (entry[bodyStart + i] !== ZSTD_MAGIC[i]) return null;
  }
  const rest = entry.subarray(bodyStart);
  const frameSize = zstdFrameSize(rest);
  if (frameSize === null || frameSize <= 0) return null;

  let bodyBuf: Buffer;
  try {
    bodyBuf = zlib.zstdDecompressSync(rest.subarray(0, frameSize), {
      maxOutputLength: MAX_DECOMPRESSED_BYTES,
    });
  } catch {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    return null;
  }
  return {
    body,
    organization,
    capturedAt: httpDateInTrailer(rest.subarray(frameSize)) ?? fileMtimeMs,
  };
}

export interface ClaudeDesktopUsage {
  windows: QuotaWindow[];
  /** Quando a resposta era verdade (`Date:` do HTTP ou mtime do entry). */
  capturedAt: number;
}

/**
 * A leitura mais nova utilizável para UMA organização. `freshMs` limita a
 * idade aceita (default 30 min — o próprio Desktop reescreve a cada refresh);
 * mais velho que isso a cascata cai para a próxima fonte em vez de exibir
 * número parado no tempo.
 */
export function readClaudeDesktopUsage(
  organizationUuid: string,
  opts: {
    now?: number;
    directory?: string;
    freshMs?: number;
  } = {},
): ClaudeDesktopUsage | null {
  if (process.platform !== 'darwin') return null;
  if (typeof zlib.zstdDecompressSync !== 'function') return null;
  const org = organizationUuid?.trim();
  if (!org) return null;
  const directory = opts.directory ?? claudeDesktopCacheDirectory();
  const now = opts.now ?? Date.now();
  const freshMs = opts.freshMs ?? CLAUDE_DESKTOP_CACHE_FRESH_MS;

  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return null;
  }

  const candidates: { file: string; mtimeMs: number; size: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('_0')) continue;
    const file = path.join(directory, name);
    try {
      const stat = fs.statSync(file);
      if (
        !stat.isFile() ||
        stat.size <= HEADER_BYTES ||
        stat.size > MAX_ENTRY_BYTES
      ) {
        continue;
      }
      candidates.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // sumiu entre a listagem e o stat — o Chromium evicta enquanto olhamos
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates.slice(0, MAX_ENTRIES_EXAMINED)) {
    let head: Buffer;
    try {
      // Header + até uma chave inteira: todo candidato é rejeitado só pela
      // URL — o body de outra conta nunca é lido, muito menos descomprimido.
      const fd = fs.openSync(candidate.file, 'r');
      try {
        head = Buffer.alloc(HEADER_BYTES + MAX_KEY_BYTES);
        const read = fs.readSync(fd, head, 0, head.length, 0);
        head = head.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const key = entryKey(head);
    if (!key || usageOrganizationInKey(key) !== org) continue;

    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(candidate.file);
    } catch {
      continue;
    }
    const parsed = parseEntry(bytes, candidate.mtimeMs);
    // Checagem dupla (prefixo na triagem, bytes parseados aqui): o Chromium
    // pode reescrever o entry entre as duas leituras — a org conferida é a
    // do que foi decodificado, nunca a do que foi visto antes.
    if (!parsed || parsed.organization !== org) continue;
    const capturedAt = parsed.capturedAt ?? candidate.mtimeMs;
    if (Math.abs(now - capturedAt) > freshMs) continue;

    const windows = parseClaudeCachedUtilization(parsed.body, now);
    if (windows.length === 0) continue;
    return { windows, capturedAt };
  }
  return null;
}
