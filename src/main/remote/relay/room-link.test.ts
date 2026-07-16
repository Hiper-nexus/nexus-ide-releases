import { describe, expect, it } from 'vitest';
import { ROOM_KEY_BYTES, WRITE_TOKEN_BYTES } from '../../../vendor/omp/wire';
import {
  createRelayRoomSecrets,
  formatRelayRoomLink,
  normalizeRelayOrigin,
  parseRelayRoomLink,
  verifyGuestWriteToken,
} from './room-link';

const RELAY = 'wss://relay.example';

describe('createRelayRoomSecrets', () => {
  it('gera roomId de 16B hex, roomKey de 32B e writeToken de 16B', () => {
    const secrets = createRelayRoomSecrets();
    expect(secrets.roomId).toMatch(/^[0-9a-f]{32}$/);
    expect(secrets.roomKey.byteLength).toBe(ROOM_KEY_BYTES);
    expect(secrets.writeToken.byteLength).toBe(WRITE_TOKEN_BYTES);
  });

  it('gera segredos distintos a cada chamada', () => {
    const a = createRelayRoomSecrets();
    const b = createRelayRoomSecrets();
    expect(a.roomId).not.toBe(b.roomId);
    expect(Buffer.from(a.roomKey)).not.toEqual(Buffer.from(b.roomKey));
  });
});

describe('formatRelayRoomLink / parseRelayRoomLink', () => {
  it('roundtrip do link full (key ∥ writeToken no fragmento)', () => {
    const secrets = createRelayRoomSecrets();
    const link = formatRelayRoomLink(
      RELAY,
      secrets.roomId,
      secrets.roomKey,
      secrets.writeToken,
    );
    expect(link).toBe(
      `${RELAY}/r/${secrets.roomId}#${Buffer.concat([
        Buffer.from(secrets.roomKey),
        Buffer.from(secrets.writeToken),
      ]).toString('base64url')}`,
    );
    const parsed = parseRelayRoomLink(link);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.wsUrl).toBe(`${RELAY}/r/${secrets.roomId}`);
    expect(parsed.roomId).toBe(secrets.roomId);
    expect(Buffer.from(parsed.roomKey)).toEqual(Buffer.from(secrets.roomKey));
    expect(parsed.writeToken).toBeDefined();
    expect(Buffer.from(parsed.writeToken!)).toEqual(Buffer.from(secrets.writeToken));
  });

  it('roundtrip do link view (só a chave; sem writeToken)', () => {
    const secrets = createRelayRoomSecrets();
    const link = formatRelayRoomLink(RELAY, secrets.roomId, secrets.roomKey);
    const parsed = parseRelayRoomLink(link);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(Buffer.from(parsed.roomKey)).toEqual(Buffer.from(secrets.roomKey));
    expect(parsed.writeToken).toBeUndefined();
  });

  it('aceita a variante dot-joined do oh-my-pi e o fragmento %23', () => {
    const secrets = createRelayRoomSecrets();
    const keyText = Buffer.from(secrets.roomKey).toString('base64url');
    const dotted = parseRelayRoomLink(`${RELAY}/r/${secrets.roomId}.${keyText}`);
    if ('error' in dotted) throw new Error(dotted.error);
    expect(dotted.roomId).toBe(secrets.roomId);
    const mangled = parseRelayRoomLink(`${RELAY}/r/${secrets.roomId}%23${keyText}`);
    if ('error' in mangled) throw new Error(mangled.error);
    expect(Buffer.from(mangled.roomKey)).toEqual(Buffer.from(secrets.roomKey));
  });

  it('rejeita segredo com tamanho inválido', () => {
    const secrets = createRelayRoomSecrets();
    const badKey = Buffer.alloc(31).toString('base64url');
    const parsed = parseRelayRoomLink(`${RELAY}/r/${secrets.roomId}#${badKey}`);
    expect('error' in parsed).toBe(true);
  });

  it('rejeita link sem path de sala e sem fragmento', () => {
    expect('error' in parseRelayRoomLink(`${RELAY}/x/abc#abc`)).toBe(true);
    const secrets = createRelayRoomSecrets();
    expect('error' in parseRelayRoomLink(`${RELAY}/r/${secrets.roomId}`)).toBe(true);
  });

  it('ws:// é permitido apenas para localhost', () => {
    const secrets = createRelayRoomSecrets();
    const keyText = Buffer.from(secrets.roomKey).toString('base64url');
    const local = parseRelayRoomLink(
      `ws://127.0.0.1:7466/r/${secrets.roomId}#${keyText}`,
    );
    expect('error' in local).toBe(false);
    const remote = parseRelayRoomLink(
      `ws://relay.example/r/${secrets.roomId}#${keyText}`,
    );
    expect('error' in remote).toBe(true);
  });

  it('NUNCA aceita o relay público my.omp.sh', () => {
    const secrets = createRelayRoomSecrets();
    const keyText = Buffer.from(secrets.roomKey).toString('base64url');
    const parsed = parseRelayRoomLink(
      `wss://my.omp.sh/r/${secrets.roomId}#${keyText}`,
    );
    expect('error' in parsed).toBe(true);
    expect(normalizeRelayOrigin('wss://my.omp.sh')).toHaveProperty('error');
    expect(() =>
      formatRelayRoomLink('wss://my.omp.sh', secrets.roomId, secrets.roomKey),
    ).toThrow();
  });
});

describe('verifyGuestWriteToken (timing-safe)', () => {
  it('aceita o token correto em base64url', () => {
    const secrets = createRelayRoomSecrets();
    const presented = Buffer.from(secrets.writeToken).toString('base64url');
    expect(verifyGuestWriteToken(secrets.writeToken, presented)).toBe(true);
  });

  it('rejeita token diferente com o mesmo tamanho', () => {
    const secrets = createRelayRoomSecrets();
    const wrong = Buffer.from(createRelayRoomSecrets().writeToken).toString(
      'base64url',
    );
    expect(verifyGuestWriteToken(secrets.writeToken, wrong)).toBe(false);
  });

  it('rejeita token de tamanho diferente, ausente ou malformado', () => {
    const secrets = createRelayRoomSecrets();
    expect(
      verifyGuestWriteToken(
        secrets.writeToken,
        Buffer.alloc(8).toString('base64url'),
      ),
    ).toBe(false);
    expect(verifyGuestWriteToken(secrets.writeToken, undefined)).toBe(false);
    expect(verifyGuestWriteToken(secrets.writeToken, '')).toBe(false);
    expect(verifyGuestWriteToken(secrets.writeToken, 'não-base64url!!')).toBe(false);
  });
});
