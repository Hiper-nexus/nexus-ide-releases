import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  minimaxCodeAuthStateFiles,
  minimaxCodeDataDir,
  minimaxCodeHasCredential,
  minimaxCodeLoginAccessToken,
  minimaxCodeSignedInRegion,
  minimaxCodeUsesOwnApiKey,
} from './minimax-code-auth';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcode-auth-'));
  roots.push(root);
  return root;
}

function writeState(dataDir: string, region: 'en' | 'cn', body: string): void {
  const dir = path.join(dataDir, 'auth', 'prod', region, 'mcode-public');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth-state.json'), body);
}

it('resolves the CLI data dir from MINIMAX_DATA_DIR, the MAVIS alias or ~/.minimax', () => {
  expect(minimaxCodeDataDir('/operator', {})).toBe(path.join('/operator', '.minimax'));
  expect(minimaxCodeDataDir('/operator', { MINIMAX_DATA_DIR: '/iso/data' })).toBe('/iso/data');
  expect(minimaxCodeDataDir('/operator', { MAVIS_DATA_DIR: '/legacy' })).toBe('/legacy');
  expect(minimaxCodeDataDir('/operator', { MINIMAX_DATA_DIR: 'relative' })).toBe(path.join('/operator', '.minimax'));
  expect(minimaxCodeAuthStateFiles('/operator', {})).toEqual([
    path.join('/operator', '.minimax', 'auth', 'prod', 'en', 'mcode-public', 'auth-state.json'),
    path.join('/operator', '.minimax', 'auth', 'prod', 'cn', 'mcode-public', 'auth-state.json'),
  ]);
});

it('proves the session only from the public state status, per region', () => {
  const operator = home();
  const data = path.join(operator, '.minimax');
  expect(minimaxCodeSignedInRegion(operator, {})).toBeNull();
  writeState(data, 'cn', JSON.stringify({ schemaVersion: 2, status: 'authenticated', expiresAtMs: 1 }));
  // Access vencido não é logout: a CLI renova com o refresh token.
  expect(minimaxCodeSignedInRegion(operator, {})).toBe('cn');
  writeState(data, 'en', JSON.stringify({ schemaVersion: 2, status: 'authenticated' }));
  expect(minimaxCodeSignedInRegion(operator, {})).toBe('en');
});

it('treats signed-out, corrupt or token-only material as no session', () => {
  const operator = home();
  const data = path.join(operator, '.minimax');
  writeState(data, 'en', JSON.stringify({ schemaVersion: 2, status: 'signed_out' }));
  expect(minimaxCodeSignedInRegion(operator, {})).toBeNull();
  writeState(data, 'en', '{not json');
  expect(minimaxCodeSignedInRegion(operator, {})).toBeNull();
  writeState(data, 'en', 'null');
  expect(minimaxCodeSignedInRegion(operator, {})).toBeNull();
  // auth.json com token sem o estado público não conta como prova.
  const dir = path.join(data, 'auth', 'prod', 'cn', 'mcode-public');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ records: { x: { accessToken: 'fixture' } } }));
  expect(minimaxCodeSignedInRegion(operator, {})).toBeNull();
});

it('accepts the CLI own API key source without reading the key', () => {
  const operator = home();
  const data = path.join(operator, '.minimax');
  fs.mkdirSync(data, { recursive: true });
  expect(minimaxCodeUsesOwnApiKey(operator, {})).toBe(false);
  expect(minimaxCodeHasCredential(operator, {})).toBe(false);
  fs.writeFileSync(path.join(data, 'config.yaml'), 'logLevel: info\nminimaxModelSource: token_plan\n');
  expect(minimaxCodeHasCredential(operator, {})).toBe(false);
  // Indented keys belong to other maps; only the top-level source counts.
  fs.writeFileSync(path.join(data, 'config.yaml'), 'provider:\n  minimaxModelSource: minimax_api_key\n');
  expect(minimaxCodeUsesOwnApiKey(operator, {})).toBe(false);
  fs.writeFileSync(path.join(data, 'config.yaml'), 'minimax_api:\n  apiKey: fixture\nminimaxModelSource: "minimax_api_key"\n');
  expect(minimaxCodeUsesOwnApiKey(operator, {})).toBe(true);
  expect(minimaxCodeHasCredential(operator, {})).toBe(true);
});

it('reads the current login access token only for quota, never an expired one', () => {
  const operator = home();
  const data = path.join(operator, '.minimax');
  const now = 1_800_000_000_000;
  const writeAuth = (record: Record<string, unknown>) => {
    const dir = path.join(data, 'auth', 'prod', 'en', 'mcode-public');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
      schemaVersion: 1,
      records: { 'com.minimax.mcode.oauth.prod.en\u0000fixture': record },
    }));
  };
  writeAuth({ accessToken: 'fixture-access', expiresAtMs: now + 60_000 });
  // Token sem o estado público autenticado não é sessão.
  expect(minimaxCodeLoginAccessToken(operator, {}, now)).toBeNull();
  writeState(data, 'en', JSON.stringify({ status: 'authenticated' }));
  expect(minimaxCodeLoginAccessToken(operator, {}, now)).toEqual({ accessToken: 'fixture-access', region: 'en' });
  // Vencido: renovar é da CLI, o Nexus não usa nem gira o refresh.
  writeAuth({ accessToken: 'fixture-access', expiresAtMs: now - 1 });
  expect(minimaxCodeLoginAccessToken(operator, {}, now)).toBeNull();
});

it('honors an isolated data dir instead of the operator home', () => {
  const operator = home();
  const isolated = home();
  writeState(isolated, 'en', JSON.stringify({ status: 'authenticated' }));
  expect(minimaxCodeSignedInRegion(operator, {})).toBeNull();
  expect(minimaxCodeSignedInRegion(operator, { MINIMAX_DATA_DIR: isolated })).toBe('en');
});
