import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REMOTE_DEVICE_REQUEST_TYPES,
  authorizeRemoteDeviceRequest,
  normalizeRemoteDeviceScopes,
} from './device-scopes';

describe('device-scopes (MOB-12)', () => {
  it('legacy grant (no field) gets every current scope; malformed fails closed', () => {
    expect(normalizeRemoteDeviceScopes(undefined)).toEqual(['read', 'input', 'approve', 'close']);
    expect(normalizeRemoteDeviceScopes(null)).toEqual([]);
    expect(normalizeRemoteDeviceScopes('read')).toEqual([]);
    expect(normalizeRemoteDeviceScopes(['close', 'admin', 'read', 'read'])).toEqual(['read', 'close']);
  });

  it('each command needs its scope; unknown types are refused', () => {
    expect(authorizeRemoteDeviceRequest('pane.input', ['read'])).toEqual({
      allowed: false,
      error: 'not authorized: scope-missing:input',
    });
    expect(authorizeRemoteDeviceRequest('pane.input', ['input'])).toEqual({ allowed: true });
    expect(authorizeRemoteDeviceRequest('agentSession.respondToApproval', ['read', 'input'])).toMatchObject({
      allowed: false,
      error: 'not authorized: scope-missing:approve',
    });
    expect(authorizeRemoteDeviceRequest('pane.close', ['read'])).toMatchObject({ allowed: false });
    expect(authorizeRemoteDeviceRequest('files.read', ['input'])).toMatchObject({
      error: 'not authorized: scope-missing:read',
    });
    // Sonda de vida e listas filtradas: qualquer aparelho autenticado.
    for (const type of ['status', 'ops.snapshot', 'panes.list']) {
      expect(authorizeRemoteDeviceRequest(type, [])).toEqual({ allowed: true });
    }
    for (const type of ['git.push', 'mission.complete', '__proto__', 'constructor', '']) {
      expect(authorizeRemoteDeviceRequest(type, ['read', 'input', 'approve', 'close'])).toEqual({
        allowed: false,
        error: `unknown command: ${type}`,
      });
    }
  });

  it('the scope table matches the commands handleAuthedMessage dispatches', () => {
    // Paridade: um comando novo na bridge sem linha na tabela é recusado em
    // produção (fail closed) — e este teste aponta qual faltou.
    const source = fs.readFileSync(path.join(__dirname, 'remote-bridge.ts'), 'utf8');
    const start = source.indexOf('export async function handleAuthedMessage(');
    const end = source.indexOf('\nfunction onConnection(', start);
    const body = source.slice(start, end);
    const cases = new Set([...body.matchAll(/case '([^']+)':/g)].map((match) => match[1]));
    cases.add('agentSession.respondToApproval'); // tratado antes do switch
    expect([...cases].sort()).toEqual([...REMOTE_DEVICE_REQUEST_TYPES].sort());
  });
});
