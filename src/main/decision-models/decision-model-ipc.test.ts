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
  beforeEach(() => { handlers.clear(); delete process.env.CLOUDFLARE_ACCOUNT_ID; });

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
});
