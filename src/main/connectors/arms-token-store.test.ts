import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
}));

import {
  authenticateArmsToken,
  generateArmsToken,
  resetArmsTokenStoreForTests,
  revokeArmsToken,
  rotateArmsToken,
  armsStatus,
} from './arms-token-store';

const ARMS_FILE = path.join(os.homedir(), '.nexus', 'arms.json');

describe('arms-token-store — credencial do conector externo', () => {
  beforeEach(() => {
    resetArmsTokenStoreForTests();
    fs.rmSync(ARMS_FILE, { force: true });
  });

  afterEach(() => {
    fs.rmSync(ARMS_FILE, { force: true });
    resetArmsTokenStoreForTests();
  });

  it('gera token que autentica e nunca é persistido em claro', () => {
    const { token } = generateArmsToken();
    expect(token).toMatch(/^nxarms_[A-Za-z0-9_-]+$/);
    expect(authenticateArmsToken(token)).toBe(true);
    const onDisk = fs.readFileSync(ARMS_FILE, 'utf8');
    expect(onDisk).not.toContain(token);
    expect(onDisk).toMatch(/[a-f0-9]{64}/);
    expect(fs.statSync(ARMS_FILE).mode & 0o077).toBe(0); // sem acesso grupo/outros
  });

  it('recusa segundo generate enquanto o primeiro está ativo', () => {
    generateArmsToken();
    expect(() => generateArmsToken()).toThrow(/rotacione/i);
  });

  it('rotate invalida o token anterior', () => {
    const first = generateArmsToken().token;
    const second = rotateArmsToken().token;
    expect(authenticateArmsToken(first)).toBe(false);
    expect(authenticateArmsToken(second)).toBe(true);
    expect(armsStatus().rotatedAt).not.toBeNull();
  });

  it('revoke mata a autenticação e o status conta a história', () => {
    const { token } = generateArmsToken();
    revokeArmsToken();
    expect(authenticateArmsToken(token)).toBe(false);
    expect(armsStatus()).toMatchObject({ configured: false, revoked: true });
    expect(() => rotateArmsToken()).toThrow(/não há token/i);
  });

  it('token errado/curto/não-string nunca autentica', () => {
    generateArmsToken();
    expect(authenticateArmsToken('nxarms_errado_comprido_o_bastante_x')).toBe(
      false,
    );
    expect(authenticateArmsToken('curto')).toBe(false);
    expect(authenticateArmsToken(42 as never)).toBe(false);
    expect(authenticateArmsToken(null)).toBe(false);
  });

  it('status sem arquivo é honesto: nada configurado', () => {
    expect(armsStatus()).toMatchObject({
      configured: false,
      revoked: false,
      createdAt: null,
    });
  });
});
