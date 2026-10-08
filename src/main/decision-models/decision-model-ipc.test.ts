import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } }));
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({}) }));
vi.mock('../persistence/secrets-store', () => ({
  getSecret: () => null, hasSecret: () => false,
  setSecret: () => ({ ok: true }), isSecureStorageAvailable: () => true,
}));

import { bindTrustedMainWindow } from '../security/trusted-ipc';
import { registerDecisionModelIpc } from './decision-model-ipc';

function trustedEvent() {
  const sender = { getURL: () => 'nexus-app://bundle/index.html', isDestroyed: () => false,
    isCrashed: () => false, once: () => {}, mainFrame: {} };
  bindTrustedMainWindow({ webContents: sender, isDestroyed: () => false } as any, 'nexus-app://bundle/index.html');
  return { sender, senderFrame: sender.mainFrame };
}

describe('trusted Clef configuration IPC', () => {
  beforeEach(() => { handlers.clear(); delete process.env.NEXUS_CLEF_ACCOUNT_ID; });

  it('requires an account as well as a token and never exposes the token', () => {
    registerDecisionModelIpc({ getSettings: () => ({ mode: 'auto', clefModel: 'clef', cloudflareAccountId: '', visionEnabled: false }),
      hasStoredKey: () => true, keyMasked: () => 'clo…3456' });
    const status = handlers.get('decisionModels:status')!(trustedEvent());
    expect(status.isReady).toBe(false);
    expect(status.hasStoredKey).toBe(true);
    expect(status.keyMasked).toBe('clo…3456');
    expect(status).not.toHaveProperty('token');
    expect(status).not.toHaveProperty('apiKey');
  });

  it('reports whether Jev is configured so the UI can warn about a provider fallback', () => {
    for (const jev of [true, false]) {
      registerDecisionModelIpc({ hasJev: () => jev });
      expect(handlers.get('decisionModels:status')!(trustedEvent()).jevReady).toBe(jev);
    }
  });

  it('rejects invalid token payloads before accessing the vault', () => {
    const setKey = vi.fn(() => ({ ok: true }));
    registerDecisionModelIpc({ setKey });
    expect(handlers.get('decisionModels:setKey')!(trustedEvent(), { token: 42 }).ok).toBe(false);
    expect(handlers.get('decisionModels:setKey')!(trustedEvent(), { token: 'token\nheader' }).ok).toBe(false);
    expect(setKey).not.toHaveBeenCalled();
  });

  it('denies configuration from an unregistered page', () => {
    const setKey = vi.fn(() => ({ ok: true }));
    registerDecisionModelIpc({ setKey });
    const event = trustedEvent();
    expect(() => handlers.get('decisionModels:setKey')!({ ...event, senderFrame: {} }, { token: 'example-token' })).toThrow('não autorizado');
    expect(setKey).not.toHaveBeenCalled();
  });

  it('tests the configured Cloudflare account and requested variant without returning the token', async () => {
    registerDecisionModelIpc({
      getSettings: () => ({ mode: 'auto', clefModel: 'clef', cloudflareAccountId: '0123456789abcdef0123456789abcdef', visionEnabled: false }),
      resolveToken: () => 'synthetic-private-token',
      testConnection: async connection => ({ ok: connection.token === 'synthetic-private-token'
        && connection.accountId === '0123456789abcdef0123456789abcdef', detail: `Connected ${connection.model}` }),
    });
    const result = await handlers.get('decisionModels:test')!(trustedEvent(), { model: 'clef-flash' });
    expect(result).toEqual({ ok: true, detail: 'Connected clef-flash' });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-token');
  });

  it('reports the OpenAI key as Luna readiness and tests it without a Cloudflare account', async () => {
    const testLuna = vi.fn(async () => ({ ok: true, detail: 'Conectado — gpt-6-luna (beta)' }));
    registerDecisionModelIpc({ hasLuna: () => true, resolveLunaKey: () => 'sk-test-secret', testLuna,
      getSettings: () => ({ mode: 'luna', clefModel: 'clef', cloudflareAccountId: '', visionEnabled: false }) });
    expect(handlers.get('decisionModels:status')!(trustedEvent()).lunaReady).toBe(true);
    const result = await handlers.get('decisionModels:test')!(trustedEvent(), { provider: 'luna' });
    expect(result).toEqual({ ok: true, detail: 'Conectado — gpt-6-luna (beta)' });
    expect(JSON.stringify(result)).not.toContain('sk-test-secret');
    expect(testLuna).toHaveBeenCalledWith('sk-test-secret');
  });

  it('does not run an inference test when account or token is absent', async () => {
    registerDecisionModelIpc({ resolveToken: () => undefined });
    expect(await handlers.get('decisionModels:test')!(trustedEvent(), {})).toMatchObject({ ok: false });
  });
});
