import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', secret: null as string | null, hasSecret: false }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../persistence/secrets-store', () => ({
  getSecret: () => state.secret,
  hasSecret: () => state.hasSecret,
  setInternalSecret: (_key: string, value: string) => { state.secret = value; state.hasSecret = true; return { ok: true }; },
}));
beforeEach(() => {
  vi.resetModules();
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-profile-test-'));
  state.secret = null; state.hasSecret = false;
});
afterEach(() => fs.rmSync(state.root, { recursive: true, force: true }));

describe('personal browser profile policy', () => {
  it('keeps agent browsers isolated until the user enables sharing, including restored agent panes', async () => {
    const profile = await import('./browser-personal-profile');
    expect(profile.browserProfileMode('new-user', false)).toBe('isolated');
    profile.changeBrowserProfile('user', { mode: 'personal' });
    expect(profile.browserProfileMode('another-user', false)).toBe('personal');
    expect(profile.browserProfileMode('new-agent', true)).toBe('isolated');
    profile.rememberAgentBrowser('restored-agent');
    vi.resetModules();
    const restored = await import('./browser-personal-profile');
    expect(restored.browserProfileMode('restored-agent', false)).toBe('isolated');
    restored.changeBrowserProfile('user', { shareWithAgents: true });
    expect(restored.browserProfileMode('another-agent', true)).toBe('personal');
    expect(restored.browserProfileMode('new-agent', true)).toBe('isolated');
    expect(restored.browserProfileMode('new-user', false)).toBe('isolated');
    restored.changeBrowserProfile('private-tab', { mode: 'isolated' });
    expect(restored.browserProfileMode('private-tab', false)).toBe('isolated');
  });
  it('does not replace an unreadable stored profile with an empty profile', async () => {
    state.hasSecret = true;
    const { personalCookieProfile } = await import('./browser-personal-profile');
    expect(() => personalCookieProfile()).toThrow(/bloqueado/);
    expect(state.secret).toBeNull();
  });
  it('keeps host-only and partition keys in protocol writes', async () => {
    const { cookieProtocolParams } = await import('./browser-personal-profile');
    const base = { name: '__Host-login', value: 'fixture', domain: 'example.test', path: '/', secure: true, httpOnly: true };
    const ordinary = cookieProtocolParams(base);
    expect(ordinary).not.toHaveProperty('domain');
    expect(ordinary).toHaveProperty('url', 'https://example.test/');
    const partitionKey = { topLevelSite: 'https://top.test', hasCrossSiteAncestor: true };
    expect(cookieProtocolParams({ ...base, partitionKey })).toHaveProperty('partitionKey', partitionKey);
  });
});
