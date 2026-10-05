import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { embeddedKeyIds, signSums, validateSums } from './sign-linux-update.mjs';

const SHA = 'a'.repeat(64);
const SUMS = `${SHA}  NexusIDE-linux-x64-0.76.198.zip\n${'b'.repeat(64)}  nexus-ide_0.76.198_amd64.deb\n`;

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-linux-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyPath = path.join(dir, 'k.pem');
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const id = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  const sumsPath = path.join(dir, 'SHA256SUMS-linux-x64.txt');
  fs.writeFileSync(sumsPath, SUMS);
  return { dir, keyPath, sumsPath, id, publicKey };
}

describe('sign-linux-update', () => {
  it('as chaves embutidas no app existem e têm o formato de id esperado', () => {
    const ids = embeddedKeyIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('assina, grava o .sig e a assinatura verifica com a pública', () => {
    const w = workspace();
    const result = signSums({ sumsPath: w.sumsPath, keyPath: w.keyPath, knownKeyIds: [w.id] });
    expect(result.keyId).toBe(w.id);
    const signature = Buffer.from(fs.readFileSync(result.outPath, 'utf8').trim(), 'base64');
    expect(signature.length).toBe(64);
    expect(verify(null, Buffer.from(SUMS), w.publicKey, signature)).toBe(true);
  });

  it('recusa chave que o app não conhece, chave aberta e somas ruins', () => {
    const w = workspace();
    expect(() => signSums({ sumsPath: w.sumsPath, keyPath: w.keyPath, knownKeyIds: ['0'.repeat(16)] })).toThrow(/não está embutida/u);
    fs.chmodSync(w.keyPath, 0o644);
    expect(() => signSums({ sumsPath: w.sumsPath, keyPath: w.keyPath, knownKeyIds: [w.id] })).toThrow(/0600/u);
    fs.chmodSync(w.keyPath, 0o600);
    fs.writeFileSync(w.sumsPath, 'lixo\n');
    expect(() => signSums({ sumsPath: w.sumsPath, keyPath: w.keyPath, knownKeyIds: [w.id] })).toThrow(/inválida/u);
  });

  it('exige o ZIP portátil nas somas', () => {
    expect(() => validateSums(`${SHA}  nexus-ide_0.76.198_amd64.deb\n`)).toThrow(/ZIP portátil/u);
    expect(validateSums(SUMS).size).toBe(2);
  });
});
