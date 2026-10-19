import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const keyring = vi.hoisted(() => ({ blob: null as string | null }));
vi.mock('./agy-windows-keyring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agy-windows-keyring')>()),
  readAgyWindowsKeyringBlob: vi.fn(() => keyring.blob),
}));

import {
  AGY_WINDOWS_LEFTOVER_SESSION_REASON,
  agyWindowsUnreadableSessionReason,
  captureNativeAuth,
} from './managed-credentials';

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const keyringBlob = JSON.stringify({
  token: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r', expiry: '2026-09-28T20:00:00Z' },
  auth_method: 'consumer',
  id_token: jwt({ sub: '111', email: 'operador@example.com' }),
});
/** `~/.gemini/oauth_creds.json` do Gemini CLI: token solto, sem o `{token, id_token}` da vaga. */
const geminiCliBlob = JSON.stringify({
  access_token: 'g-a',
  refresh_token: 'g-r',
  token_type: 'Bearer',
  expiry_date: 1_900_000_000_000,
  id_token: jwt({ sub: '222', email: 'gemini-cli@example.com' }),
});
/** Arquivo do AGY 1.1 (`antigravity-cli/antigravity-oauth-token`) sem `id_token`. */
const agyLegacyFileBlob = JSON.stringify({
  token: { access_token: 'l-a', token_type: 'Bearer', refresh_token: 'l-r' },
  auth_method: 'consumer',
});

const homes: string[] = [];
function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agy-keyring-'));
  homes.push(home);
  return home;
}
function writeGemini(home: string, relative: string, blob: string): void {
  const file = path.join(home, '.gemini', relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, blob);
}
function operatorHome(): string {
  const home = tempHome();
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  return home;
}

afterEach(() => {
  vi.restoreAllMocks();
  keyring.blob = null;
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('captura da sessão AGY guardada só no keyring do Windows (F-677)', () => {
  it('sem arquivo de token, a sessão nativa vem da vaga gemini:antigravity', () => {
    const home = operatorHome();
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
    const home = operatorHome();
    keyring.blob = '{"token":{}}';
    expect(captureNativeAuth('agy', home)).toBeNull();
  });
});

describe('no Windows a vaga vem antes dos arquivos de ~/.gemini (F-1580)', () => {
  it('com a vaga ocupada, a sobra do Gemini CLI em oauth_creds.json não é capturada', () => {
    const home = operatorHome();
    writeGemini(home, 'oauth_creds.json', geminiCliBlob);
    keyring.blob = keyringBlob;
    expect(captureNativeAuth('agy', home, { platform: 'win32' })).toMatchObject({
      blob: keyringBlob,
      email: 'operador@example.com',
      authRelativePath: 'oauth_creds.json',
    });
  });

  it('com a vaga vazia, arquivo fora do formato da vaga nunca vira conta AGY e o motivo é dito', () => {
    const home = operatorHome();
    writeGemini(home, 'oauth_creds.json', geminiCliBlob);
    writeGemini(home, path.join('antigravity-cli', 'antigravity-oauth-token'), agyLegacyFileBlob);
    expect(captureNativeAuth('agy', home, { platform: 'win32' })).toBeNull();
    expect(agyWindowsUnreadableSessionReason(home, { platform: 'win32' }))
      .toBe(AGY_WINDOWS_LEFTOVER_SESSION_REASON);
    expect(AGY_WINDOWS_LEFTOVER_SESSION_REASON).toContain('Conectar minha conta');
  });

  it('com a vaga vazia, arquivo no formato da vaga é capturado inteiro, sem desembrulhar', () => {
    const home = operatorHome();
    writeGemini(home, path.join('antigravity-cli', 'antigravity-oauth-token'), keyringBlob);
    expect(captureNativeAuth('agy', home, { platform: 'win32' })).toMatchObject({
      blob: keyringBlob,
      authRelativePath: 'oauth_creds.json',
    });
    expect(agyWindowsUnreadableSessionReason(home, { platform: 'win32' })).toBeNull();
  });

  it('sem vaga e sem arquivo não há motivo a mostrar (é só sessão ausente)', () => {
    const home = operatorHome();
    expect(agyWindowsUnreadableSessionReason(home, { platform: 'win32' })).toBeNull();
  });

  it('macOS e Linux continuam lendo os arquivos primeiro, como antes', () => {
    const home = operatorHome();
    writeGemini(home, path.join('antigravity-cli', 'antigravity-oauth-token'), agyLegacyFileBlob);
    keyring.blob = keyringBlob;
    for (const platform of ['darwin', 'linux'] as const) {
      const capture = captureNativeAuth('agy', home, { platform });
      expect(capture?.blob).toBe(JSON.stringify(JSON.parse(agyLegacyFileBlob).token));
      expect(agyWindowsUnreadableSessionReason(home, { platform })).toBeNull();
    }
  });
});
