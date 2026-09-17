import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JEV_CHANNELS } from '../../shared/jev-channels';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  };
});

const secrets = vi.hoisted(() => ({
  hasStoredJevApiKey: vi.fn(() => true),
  isJevSecretStorageAvailable: vi.fn(() => true),
  maskedJevApiKey: vi.fn(() => 'api…ghij'),
  setJevApiKey: vi.fn(() => ({ ok: true })),
}));

const client = vi.hoisted(() => ({
  getJevStats: vi.fn(() => ({
    calls: 3,
    failures: 1,
    inputTokens: 900,
    estimatedUsd: 0.0000378,
    skippedNoKey: 0,
  })),
  testJevConnection: vi.fn(async () => ({ ok: true, detail: 'Conectado — modelos: jev-latest' })),
}));

const autopilot = vi.hoisted(() => ({
  isJevAutopilotEnabled: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle },
}));

vi.mock('./jev-secrets', () => secrets);
vi.mock('./jev-client', () => client);
vi.mock('./jev-autopilot', () => autopilot);

import { registerJevIpc } from './jev-ipc';

describe('registerJevIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMock.handlers.clear();
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.NEXUS_JEV_MODEL;
    registerJevIpc();
  });

  it('status returns presence, autopilot, model and stats (no decrypt on presence)', async () => {
    const handler = electronMock.handlers.get(JEV_CHANNELS.status);
    expect(handler).toBeDefined();
    const status = (await handler?.(null)) as Record<string, unknown>;
    expect(status.hasStoredKey).toBe(true);
    expect(status.hasEnv).toBe(false);
    expect(status.keyMasked).toBe('api…ghij');
    expect(status.secureStorageAvailable).toBe(true);
    expect(status.autopilot).toBe(true);
    expect(status.model).toBe('jev-latest');
    expect(status.stats).toEqual({
      calls: 3,
      failures: 1,
      inputTokens: 900,
      estimatedUsd: 0.0000378,
    });
    expect(secrets.hasStoredJevApiKey).toHaveBeenCalled();
  });

  it('status hasEnv reflects process.env', async () => {
    process.env.TYPESAFE_API_KEY = 'env-key';
    const handler = electronMock.handlers.get(JEV_CHANNELS.status);
    const status = (await handler?.(null)) as Record<string, unknown>;
    expect(status.hasEnv).toBe(true);
  });

  it('setKey valida com zod e delega ao vault', async () => {
    const handler = electronMock.handlers.get(JEV_CHANNELS.setKey);
    expect(await handler?.(null, { key: 'apikey_new' })).toEqual({ ok: true });
    expect(secrets.setJevApiKey).toHaveBeenCalledWith('apikey_new');
  });

  it('setKey rejeita payload inválido', async () => {
    const handler = electronMock.handlers.get(JEV_CHANNELS.setKey);
    expect(await handler?.(null, { key: 42 })).toEqual({
      ok: false,
      error: 'invalid key request',
    });
    expect(secrets.setJevApiKey).not.toHaveBeenCalled();
  });

  it('test delega ao testJevConnection', async () => {
    const handler = electronMock.handlers.get(JEV_CHANNELS.test);
    expect(await handler?.(null)).toEqual({
      ok: true,
      detail: 'Conectado — modelos: jev-latest',
    });
    expect(client.testJevConnection).toHaveBeenCalled();
  });
});
