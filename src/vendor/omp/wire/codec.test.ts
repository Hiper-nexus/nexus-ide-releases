import { describe, expect, it } from 'vitest';
import {
  generateRoomKey,
  generateWriteToken,
  importRoomKey,
  open,
  packEnvelope,
  rewriteEnvelopePeer,
  seal,
  unpackEnvelope,
} from './codec';
import { ENVELOPE_HEADER_LENGTH, ROOM_KEY_BYTES, WRITE_TOKEN_BYTES } from './index';

const IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

describe('omp wire codec (AES-256-GCM)', () => {
  it('gera chave de 32 bytes e token de 16 bytes', () => {
    expect(generateRoomKey().byteLength).toBe(ROOM_KEY_BYTES);
    expect(generateWriteToken().byteLength).toBe(WRITE_TOKEN_BYTES);
  });

  it('rejeita import de chave com tamanho errado', () => {
    expect(() => importRoomKey(new Uint8Array(16))).toThrow(/32 bytes/);
  });

  it('roundtrip seal/open preserva o frame JSON', async () => {
    const key = await importRoomKey(generateRoomKey());
    const frame = { t: 'pty', pane: 'pane-1', seq: 42, data: 'aGVsbG8=' };
    const sealed = await seal(key, frame);
    // Layout selado: [12B IV][ciphertext+tag]
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
    expect(sealed.byteLength).toBe(IV_LENGTH + plaintextBytes + GCM_TAG_LENGTH);
    const opened = await open(key, sealed);
    expect(opened).toEqual(frame);
  });

  it('duas selagens do mesmo frame usam IVs distintos', async () => {
    const key = await importRoomKey(generateRoomKey());
    const frame = { t: 'hello', proto: 1, name: 'guest' };
    const first = await seal(key, frame);
    const second = await seal(key, frame);
    expect(Buffer.from(first.subarray(0, IV_LENGTH))).not.toEqual(
      Buffer.from(second.subarray(0, IV_LENGTH)),
    );
  });

  it('detecta tamper: byte alterado no ciphertext falha a tag', async () => {
    const key = await importRoomKey(generateRoomKey());
    const sealed = await seal(key, { t: 'state', value: 'secreto' });
    const tampered = new Uint8Array(sealed);
    tampered[IV_LENGTH + 2] = (tampered[IV_LENGTH + 2]! + 1) & 0xff;
    await expect(open(key, tampered)).rejects.toThrow();
  });

  it('chave errada falha a decriptação', async () => {
    const right = await importRoomKey(generateRoomKey());
    const wrong = await importRoomKey(generateRoomKey());
    const sealed = await seal(right, { t: 'bye', reason: 'fim' });
    await expect(open(wrong, sealed)).rejects.toThrow();
  });

  it('rejeita frame selado curto demais', async () => {
    const key = await importRoomKey(generateRoomKey());
    await expect(open(key, new Uint8Array(IV_LENGTH))).rejects.toThrow(/too short/);
  });
});

describe('omp wire envelope ([4B uint32 BE peerId][payload])', () => {
  it('pack/unpack roundtrip', () => {
    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    const envelope = packEnvelope(7, payload);
    expect(envelope.byteLength).toBe(ENVELOPE_HEADER_LENGTH + payload.byteLength);
    const unpacked = unpackEnvelope(envelope);
    expect(unpacked).not.toBeNull();
    expect(unpacked!.peerId).toBe(7);
    expect(Buffer.from(unpacked!.payload)).toEqual(Buffer.from(payload));
  });

  it('peerId é uint32 big-endian', () => {
    const envelope = packEnvelope(0x01020304, new Uint8Array(0));
    expect([...envelope.subarray(0, 4)]).toEqual([1, 2, 3, 4]);
  });

  it('rewriteEnvelopePeer altera o header in place sem tocar o payload', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const envelope = packEnvelope(0, payload);
    rewriteEnvelopePeer(envelope, 3);
    const unpacked = unpackEnvelope(envelope);
    expect(unpacked!.peerId).toBe(3);
    expect(Buffer.from(unpacked!.payload)).toEqual(Buffer.from(payload));
  });

  it('unpack devolve null para buffer menor que o header', () => {
    expect(unpackEnvelope(new Uint8Array(3))).toBeNull();
  });
});
