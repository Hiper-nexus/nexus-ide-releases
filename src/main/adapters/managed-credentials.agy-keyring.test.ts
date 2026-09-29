import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const keyring = vi.hoisted(() => ({ blob: null as string | null }));
vi.mock('./agy-windows-keyring', () => ({
  readAgyWindowsKeyringBlob: vi.fn(() => keyring.blob),
}));

import { captureNativeAuth } from './managed-credentials';

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const keyringBlob = JSON.stringify({
  token: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r', expiry: '2026-09-28T20:00:00Z' },
  auth_method: 'consumer',
  id_token: jwt({ sub: '111', email: 'operador@example.com' }),
});

const homes: string[] = [];
function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agy-keyring-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  vi.restoreAllMocks();
  keyring.blob = null;
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('captura da sessão AGY guardada só no keyring do Windows (F-677)', () => {
  it('sem arquivo de token, a sessão nativa vem da vaga gemini:antigravity', () => {
    const home = tempHome();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    keyring.blob = keyringBlob;
    const capture = captureNativeAuth('agy', home);
    expect(capture).toMatchObject({ blob: keyringBlob, email: 'operador@example.com' });
  });

  it('HOME que não é o do operador (overlay, teste) nunca lê a vaga global', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome());
    keyring.blob = keyringBlob;
    expect(captureNativeAuth('agy', tempHome())).toBeNull();
  });

  it('vaga vazia ou inválida continua sem sessão', () => {
    const home = tempHome();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    keyring.blob = '{"token":{}}';
    expect(captureNativeAuth('agy', home)).toBeNull();
  });
});
