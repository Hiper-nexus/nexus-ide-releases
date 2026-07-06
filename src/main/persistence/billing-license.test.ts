import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyLicenseToken } from './billing-ipc';

// applyLicenseToken grava em ~/.nexus/license.json — injetamos um path de
// teste (licensePath) para não tocar no arquivo real.
let tmpDir: string;
let licensePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lic-'));
  licensePath = path.join(tmpDir, 'license.json');
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function signJwt(payload: unknown, privateKey: crypto.KeyObject): string {
  const header = b64url({ alg: 'EdDSA', typ: 'JWT' });
  const body = b64url(payload);
  const sig = crypto
    .sign(null, Buffer.from(`${header}.${body}`), privateKey)
    .toString('base64url');
  return `${header}.${body}.${sig}`;
}

describe('applyLicenseToken (verificação de assinatura)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  function readPlan(): string | undefined {
    try {
      return JSON.parse(fs.readFileSync(licensePath, 'utf8')).plan;
    } catch {
      return undefined;
    }
  }

  it('token assinado válido eleva o plano', () => {
    const token = signJwt({ plan: 'team', status: 'active' }, privateKey);
    expect(
      applyLicenseToken(token, { publicKeyPem: pubPem, licensePath }),
    ).toEqual({ ok: true });
    expect(readPlan()).toBe('team');
  });

  it('SEGURANÇA: payload forjado (assinatura errada) é RECUSADO — não eleva', () => {
    // Atacante troca o payload por plan=team mas não tem a chave privada.
    const good = signJwt({ plan: 'free' }, privateKey);
    const parts = good.split('.');
    const forgedPayload = b64url({ plan: 'team', status: 'active' });
    const forged = `${parts[0]}.${forgedPayload}.${parts[2]}`;
    const res = applyLicenseToken(forged, { publicKeyPem: pubPem, licensePath });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/assinatura/);
    expect(readPlan()).toBeUndefined();
  });

  it('SEGURANÇA: sem chave de verificação, recusa (nunca eleva)', () => {
    const token = signJwt({ plan: 'team' }, privateKey);
    const res = applyLicenseToken(token, { licensePath }); // sem publicKeyPem
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/chave de verificação/);
    expect(readPlan()).toBeUndefined();
  });

  it('assinatura de OUTRA chave é recusada', () => {
    const other = crypto.generateKeyPairSync('ed25519').privateKey;
    const token = signJwt({ plan: 'team' }, other);
    expect(
      applyLicenseToken(token, { publicKeyPem: pubPem, licensePath }).ok,
    ).toBe(false);
  });

  it('token expirado é recusado mesmo com assinatura válida', () => {
    const token = signJwt(
      { plan: 'pro', exp: Math.floor(Date.now() / 1000) - 10 },
      privateKey,
    );
    const res = applyLicenseToken(token, { publicKeyPem: pubPem, licensePath });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/expirada/);
  });

  it('token malformado (não-3-partes) é recusado', () => {
    expect(
      applyLicenseToken('a.b', { publicKeyPem: pubPem, licensePath }).ok,
    ).toBe(false);
  });
});
