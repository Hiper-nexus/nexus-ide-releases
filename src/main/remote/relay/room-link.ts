// Formato de sala/segredo adaptado de can1357/oh-my-pi@03c48d073
// packages/coding-agent/src/collab/protocol.ts (MIT).
/**
 * Sala + segredos do transporte relay do companion mobile.
 *
 * Link full  = `<wss-url>/r/<roomId>#<base64url(roomKey ∥ writeToken)>`
 * Link view  = `<wss-url>/r/<roomId>#<base64url(roomKey)>`
 *
 * O segredo vive no fragmento (`#`) — nunca em path/query — então não chega
 * ao relay nem a logs HTTP. O parser também aceita as variantes do oh-my-pi:
 * dot-joined (`/r/<roomId>.<key>`) e `%23` (fragmento percent-encodado por
 * stacks de URL estritas).
 *
 * NUNCA logar roomKey/writeToken/links.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ROOM_KEY_BYTES, WRITE_TOKEN_BYTES } from '../../../vendor/omp/wire';

/** roomId = 16 bytes hex (32 chars) — cabe no `[A-Za-z0-9_-]{10,64}` do relay. */
const ROOM_ID_HEX_BYTES = 16;

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

/**
 * O relay público do oh-my-pi jamais deve receber tráfego do Nexus — nem por
 * engano de configuração. Fail closed.
 */
const FORBIDDEN_RELAY_HOSTNAMES: ReadonlySet<string> = new Set(['my.omp.sh']);

export interface RelayRoomSecrets {
  roomId: string;
  /** Chave AES-256-GCM da sala (32 bytes). */
  roomKey: Uint8Array;
  /** Token de escrita (16 bytes) — posse prova capacidade de mutação. */
  writeToken: Uint8Array;
}

export interface ParsedRelayRoomLink {
  /** ws(s)://host[:port]/r/<roomId> — sem query, sem fragmento. */
  wsUrl: string;
  roomId: string;
  roomKey: Uint8Array;
  /** Presente apenas em links full. */
  writeToken?: Uint8Array;
}

export function createRelayRoomSecrets(): RelayRoomSecrets {
  return {
    roomId: randomBytes(ROOM_ID_HEX_BYTES).toString('hex'),
    roomKey: new Uint8Array(randomBytes(ROOM_KEY_BYTES)),
    writeToken: new Uint8Array(randomBytes(WRITE_TOKEN_BYTES)),
  };
}

/**
 * Normaliza uma URL de relay (ws/wss/http/https) para uma origem ws/wss.
 * `ws://` só é aceito para localhost; my.omp.sh é sempre rejeitado.
 */
export function normalizeRelayOrigin(
  relayUrl: string,
): { origin: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return { error: 'invalid relay URL' };
  }
  if (FORBIDDEN_RELAY_HOSTNAMES.has(url.hostname.toLowerCase())) {
    return { error: 'this public relay is not allowed for Nexus traffic' };
  }
  let scheme: string;
  switch (url.protocol) {
    case 'wss:':
    case 'https:':
      scheme = 'wss:';
      break;
    case 'ws:':
    case 'http:':
      scheme = 'ws:';
      break;
    default:
      return { error: `unsupported relay URL scheme: ${url.protocol}` };
  }
  if (scheme === 'ws:' && !LOCAL_HOSTNAMES.has(url.hostname)) {
    return { error: 'relay link must be wss:// (plain ws:// is only allowed for localhost)' };
  }
  const port = url.port ? `:${url.port}` : '';
  return { origin: `${scheme}//${url.hostname}${port}` };
}

/**
 * Renderiza o link compartilhável. Com `writeToken` gera o link full
 * (`base64url(key ∥ token)`); sem ele, o link view (chave de 32 bytes).
 */
export function formatRelayRoomLink(
  relayUrl: string,
  roomId: string,
  roomKey: Uint8Array,
  writeToken?: Uint8Array,
): string {
  const normalized = normalizeRelayOrigin(relayUrl);
  if ('error' in normalized) throw new Error(normalized.error);
  const secret = writeToken
    ? Buffer.concat([Buffer.from(roomKey), Buffer.from(writeToken)])
    : Buffer.from(roomKey);
  return `${normalized.origin}/r/${roomId}#${secret.toString('base64url')}`;
}

/**
 * Parser + validador. Aceita o formato canônico (`#`), o dot-joined do
 * oh-my-pi (`/r/<roomId>.<key>`) e o `%23` mangleado por stacks estritas.
 */
export function parseRelayRoomLink(
  link: string,
): ParsedRelayRoomLink | { error: string } {
  let text = link.trim().replace(/%23/gi, '#');
  if (!text.includes('://')) text = `wss://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: 'invalid relay room link' };
  }
  const normalized = normalizeRelayOrigin(url.origin);
  if ('error' in normalized) return normalized;
  const match = ROOM_PATH_RE.exec(url.pathname);
  if (!match) {
    return { error: 'relay room link must contain a /r/<roomId> path' };
  }
  const roomId = match[1]!;
  const fragment =
    match[2] ?? (url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  if (!fragment) {
    return { error: 'relay room link is missing the secret fragment' };
  }
  const secret = B64URL_RE.test(fragment)
    ? new Uint8Array(Buffer.from(fragment, 'base64url'))
    : null;
  if (
    !secret ||
    (secret.byteLength !== ROOM_KEY_BYTES &&
      secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES)
  ) {
    return {
      error: `relay room secret must be ${ROOM_KEY_BYTES} (view) or ${
        ROOM_KEY_BYTES + WRITE_TOKEN_BYTES
      } (full) base64url bytes`,
    };
  }
  const roomKey = secret.subarray(0, ROOM_KEY_BYTES);
  const writeToken =
    secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined;
  return {
    wsUrl: `${normalized.origin}/r/${roomId}`,
    roomId,
    roomKey,
    ...(writeToken ? { writeToken } : {}),
  };
}

/** base64url (pi-wire) ou base64 padrão com até dois `=` (PWA publicado usa `btoa`). */
const WRITE_TOKEN_RE = /^[A-Za-z0-9_+/-]+={0,2}$/;

/**
 * Verificação timing-safe do write token apresentado em um hello de guest
 * (base64url, formato pi-wire; base64 padrão com padding também é aceito e
 * normalizado antes de decodificar). Peers sem token válido são read-only.
 */
export function verifyGuestWriteToken(
  expected: Uint8Array,
  presented: string | undefined,
): boolean {
  if (expected.byteLength === 0 || !presented) return false;
  if (!WRITE_TOKEN_RE.test(presented)) return false;
  const normalized = presented
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const bytes = Buffer.from(normalized, 'base64url');
  return (
    bytes.byteLength === expected.byteLength &&
    timingSafeEqual(bytes, Buffer.from(expected))
  );
}
