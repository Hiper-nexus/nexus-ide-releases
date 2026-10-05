import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  UPDATE_SIGNING_KEYS,
  keyIdOf,
  parseSums,
  trustedSha256For,
  verifyDetachedSignature,
  type UpdateSigningKey,
} from './linux-update-signing';

function testKey(): { key: UpdateSigningKey; sign: (text: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    key: { id: keyIdOf(pem), publicKeyPem: pem },
    sign: (text) => sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64'),
  };
}

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SUMS = `${SHA_A}  NexusIDE-linux-x64-0.76.198.zip\n${SHA_B}  nexus-ide_0.76.198_amd64.deb\n`;

describe('chaves embutidas', () => {
  it('cada id declarado é o id real da chave pública correspondente', () => {
    expect(UPDATE_SIGNING_KEYS.length).toBeGreaterThan(0);
    for (const key of UPDATE_SIGNING_KEYS) expect(keyIdOf(key.publicKeyPem)).toBe(key.id);
  });
});

describe('verifyDetachedSignature', () => {
  it('aceita a assinatura da chave certa e diz qual foi', () => {
    const { key, sign: signText } = testKey();
    expect(verifyDetachedSignature(Buffer.from(SUMS), signText(SUMS), [key])).toEqual({ ok: true, keyId: key.id });
  });

  it('aceita a chave nova numa lista com a antiga (rotação)', () => {
    const old = testKey();
    const next = testKey();
    expect(verifyDetachedSignature(Buffer.from(SUMS), next.sign(SUMS), [old.key, next.key])).toEqual({
      ok: true,
      keyId: next.key.id,
    });
  });

  it('recusa conteúdo alterado, chave errada e lixo', () => {
    const a = testKey();
    const b = testKey();
    const signature = a.sign(SUMS);
    expect(verifyDetachedSignature(Buffer.from(SUMS + 'x'), signature, [a.key])).toEqual({ ok: false });
    expect(verifyDetachedSignature(Buffer.from(SUMS), signature, [b.key])).toEqual({ ok: false });
    for (const bad of ['', '   ', 'not base64!', 'QUJD', 'A'.repeat(300), signature.slice(0, -4)]) {
      expect(verifyDetachedSignature(Buffer.from(SUMS), bad, [a.key])).toEqual({ ok: false });
    }
  });

  it('nunca lança com chave malformada', () => {
    const { sign: signText } = testKey();
    expect(
      verifyDetachedSignature(Buffer.from(SUMS), signText(SUMS), [{ id: 'x', publicKeyPem: 'não é pem' }]),
    ).toEqual({ ok: false });
  });
});

describe('parseSums', () => {
  it('lê o formato publicado pelo build', () => {
    const sums = parseSums(SUMS);
    expect(sums?.get('NexusIDE-linux-x64-0.76.198.zip')).toBe(SHA_A);
    expect(sums?.size).toBe(2);
  });

  it('rejeita o arquivo inteiro se uma linha fugir do formato', () => {
    for (const text of [
      '',
      `${SHA_A} NexusIDE.zip\n`, // um espaço só
      `${SHA_A.toUpperCase()}  NexusIDE.zip\n`,
      `${SHA_A}  ../NexusIDE.zip\n`,
      `${SHA_A}  dir/NexusIDE.zip\n`,
      `${SHA_A}  ..\n`,
      `${SHA_A}  a.zip\n${SHA_B}  a.zip\n`, // duplicado
      `${SHA_A}  a.zip\nlixo\n`,
      `${'a'.repeat(63)}  a.zip\n`,
      `${SHA_A}  a b.zip\n`,
    ]) {
      expect(parseSums(text), JSON.stringify(text)).toBeNull();
    }
  });

  it('rejeita arquivo grande demais', () => {
    expect(parseSums(`${SHA_A}  a.zip\n`.repeat(400))).toBeNull();
  });
});

describe('trustedSha256For', () => {
  it('entrega o SHA-256 só do asset pedido e só com assinatura válida', () => {
    const { key, sign: signText } = testKey();
    const signature = signText(SUMS);
    expect(trustedSha256For(SUMS, signature, 'NexusIDE-linux-x64-0.76.198.zip', [key])).toEqual({
      sha256: SHA_A,
      keyId: key.id,
    });
    expect(trustedSha256For(SUMS, signature, 'outro.zip', [key])).toBeNull();
    expect(trustedSha256For(SUMS.replace(SHA_A, 'c'.repeat(64)), signature, 'NexusIDE-linux-x64-0.76.198.zip', [key])).toBeNull();
  });

  it('com as chaves embutidas, uma assinatura de teste não passa', () => {
    const { sign: signText } = testKey();
    expect(trustedSha256For(SUMS, signText(SUMS), 'NexusIDE-linux-x64-0.76.198.zip')).toBeNull();
  });
});
