// Vendored from can1357/oh-my-pi@03c48d073 packages/wire (MIT)
// Fontes: packages/collab-web/src/lib/codec.ts (seal/open WebCrypto) e
// packages/coding-agent/src/collab/protocol.ts (helpers de envelope).
/**
 * Selagem AES-256-GCM para frames do transporte relay (espelho WebCrypto do
 * codec do oh-my-pi — funciona em Node ≥ 20 via `globalThis.crypto.subtle` e
 * no browser, sem dependência de runtime).
 *
 * A chave da sala vive apenas no fragmento do link; o relay só vê bytes
 * opacos. Layout selado: `[12B IV][ciphertext+tag]`.
 *
 * Frames são JSON no boundary da wire; `open` devolve `unknown` e o
 * consumidor valida/casta (mesma doutrina "cast at the JSON boundary" do
 * pacote wire original).
 */
import { ENVELOPE_HEADER_LENGTH, ROOM_KEY_BYTES, WRITE_TOKEN_BYTES } from './index';

const AES_ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function generateRoomKey(): Uint8Array {
  const key = new Uint8Array(ROOM_KEY_BYTES);
  globalThis.crypto.getRandomValues(key);
  return key;
}

export function generateWriteToken(): Uint8Array {
  const token = new Uint8Array(WRITE_TOKEN_BYTES);
  globalThis.crypto.getRandomValues(token);
  return token;
}

export function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== ROOM_KEY_BYTES) {
    throw new Error(`Room key must be ${ROOM_KEY_BYTES} bytes, got ${raw.byteLength}`);
  }
  return globalThis.crypto.subtle.importKey('raw', asStrict(raw), AES_ALGORITHM, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Sela um frame JSON-serializável: `[12B IV][ciphertext+tag]`. */
export async function seal(key: CryptoKey, frame: unknown): Promise<Uint8Array> {
  const iv = new Uint8Array(IV_LENGTH);
  globalThis.crypto.getRandomValues(iv);
  const plaintext = TEXT_ENCODER.encode(JSON.stringify(frame));
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, plaintext),
  );
  const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(ciphertext, IV_LENGTH);
  return out;
}

/** Inverso de {@link seal}. Lança em falha de autenticação ou entrada malformada. */
export async function open(key: CryptoKey, data: Uint8Array): Promise<unknown> {
  if (data.byteLength <= IV_LENGTH) {
    throw new Error('Sealed frame too short');
  }
  const iv = asStrict(data.subarray(0, IV_LENGTH));
  const ciphertext = asStrict(data.subarray(IV_LENGTH));
  const plaintext = new Uint8Array(
    await globalThis.crypto.subtle.decrypt({ name: AES_ALGORITHM, iv }, key, ciphertext),
  );
  return JSON.parse(TEXT_DECODER.decode(plaintext)) as unknown;
}

// ═══════════════════════════════════════════════════════════════════════════
// Envelope da wire: [4B uint32 BE peerId][payload selado]
// Host→relay: peerId 0 broadcast para todos os guests; peerId N unicast.
// Guest→relay: sempre 0; o relay reescreve para o id do remetente.
// ═══════════════════════════════════════════════════════════════════════════

export function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array {
  const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
  new DataView(out.buffer).setUint32(0, peerId, false);
  out.set(sealed, ENVELOPE_HEADER_LENGTH);
  return out;
}

export function unpackEnvelope(
  data: Uint8Array,
): { peerId: number; payload: Uint8Array } | null {
  if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
  const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(
    0,
    false,
  );
  return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

/** Reescreve o peerId in place sem copiar o payload. */
export function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
  new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}

function asStrict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
