import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateArtifact, cleanupCliMcpSession, getActiveCliMcpArtifact, linkProviderSessionState, linkSelectedEntries, purgeStaleCliMcpSessions, withCliMcpArtifactTransaction } from './cli-mcp-session-artifacts';

const roots: string[] = [];
const museTokens: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const token of museTokens.splice(0)) cleanupCliMcpSession(token);
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

it('owns private Muse overlays, preserves live records and purges only stale bounded entries', () => {
  const { root } = fixture(), artifactRoot = path.join(root, 'artifacts'), token = 'private-muse-registry'; museTokens.push(token);
  const active = withCliMcpArtifactTransaction('muse', token, artifactRoot, artifactDir => {
    fs.writeFileSync(path.join(artifactDir, 'settings.json'), '{"model":"selected"}');
    activateArtifact(token, { artifactDir, providerHome: null, configFiles: ['settings.json'], syncBack: false }); return artifactDir;
  });
  const stale = path.join(artifactRoot, 'muse', 'a'.repeat(32)); fs.mkdirSync(stale); fs.writeFileSync(path.join(stale, 'settings.json'), '{}');
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'untouched');
  fs.symlinkSync(outside, path.join(artifactRoot, 'muse', 'b'.repeat(32)));
  const result = purgeStaleCliMcpSessions({ artifactRoot });
  expect(result.removed).toBe(2); expect(result.skippedActive).toBe(1); expect(result.failed).toBe(0);
  expect(fs.existsSync(stale)).toBe(false); expect(fs.readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('untouched');
  expect(getActiveCliMcpArtifact(token)?.artifactDir).toBe(active);
  cleanupCliMcpSession(token); expect(fs.existsSync(active)).toBe(false); expect(getActiveCliMcpArtifact(token)).toBeUndefined();
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-provider-state-'));
  roots.push(root);
  const overlay = path.join(root, 'overlay');
  fs.mkdirSync(overlay);
  return {
    root,
    overlay,
    options: { userDataPath: root, checkoutId: 'checkout-a' },
  };
}

describe('durable provider session state', () => {
  it.each(['../escape', '/absolute', 'a\\b', '', '..'])(
    'rejects unsafe checkout identity %j',
    (checkoutId) => {
      const { root, overlay, options } = fixture();
      expect(() =>
        linkProviderSessionState(
          'grok',
          overlay,
          { ...options, checkoutId },
          ['sessions'],
          {},
        ),
      ).toThrow(/checkout identity/);
      expect(fs.existsSync(path.join(root, 'provider-state'))).toBe(false);
    },
  );

  it.each(['../escape', '/absolute', 'a\\b', ''])(
    'rejects unsafe adapter identity %j',
    (kind) => {
      const { root, overlay, options } = fixture();
      expect(() =>
        linkProviderSessionState(
          kind,
          overlay,
          options,
          ['projects'],
          {},
          'claude',
        ),
      ).toThrow(/adapter identity/);
      expect(fs.existsSync(path.join(root, 'provider-state'))).toBe(false);
    },
  );

  it('rejects a pre-existing session link back to the native profile', () => {
    const { root, overlay, options } = fixture();
    const native = path.join(root, 'native-sessions');
    const state = path.join(root, 'provider-state', 'grok', 'checkout-a');
    fs.mkdirSync(native);
    fs.mkdirSync(state, { recursive: true });
    fs.symlinkSync(native, path.join(state, 'sessions'), 'junction');
    expect(() =>
      linkProviderSessionState('grok', overlay, options, ['sessions'], {}),
    ).toThrow(/must not be a symlink/);
    expect(fs.readdirSync(native)).toEqual([]);
  });

  it.each(['darwin', 'linux', 'win32'])(
    'uses the existing directory link helper on %s',
    (platform) => {
      const { root, overlay, options } = fixture();
      vi.spyOn(process, 'platform', 'get').mockReturnValue(
        platform as NodeJS.Platform,
      );
      const link = vi.spyOn(fs, 'symlinkSync');
      const state = linkProviderSessionState(
        'kimi',
        overlay,
        options,
        ['sessions', 'user-history'],
        { 'session_index.jsonl': '' },
      );
      expect(state).toBe(
        path.join(root, 'provider-state', 'kimi', 'checkout-a'),
      );
      const args = [
        path.join(state, 'sessions'),
        path.join(overlay, 'sessions'),
      ];
      expect(link).toHaveBeenCalledWith(
        ...args,
        ...(platform === 'win32' ? ['junction'] : []),
      );
      fs.writeFileSync(path.join(overlay, 'sessions', 'pane'), 'durable');
      fs.rmSync(overlay, { recursive: true });
      expect(
        fs.readFileSync(path.join(state, 'sessions', 'pane'), 'utf8'),
      ).toBe('durable');
    },
  );
});

describe('linkSelectedEntries: link para pasta (F-710)', () => {
  it('liga como pasta a entrada que é link para pasta, sem copiar diretório', () => {
    const { root, overlay } = fixture();
    const realBundled = path.join(root, 'native', 'bundled');
    fs.mkdirSync(realBundled, { recursive: true });
    fs.writeFileSync(path.join(realBundled, 'tool.json'), '{}');
    // A conta gerenciada do Grok liga suas entradas ao perfil nativo.
    const managedHome = path.join(root, 'managed-home');
    fs.mkdirSync(managedHome);
    fs.symlinkSync(realBundled, path.join(managedHome, 'bundled'), 'junction');

    linkSelectedEntries(managedHome, overlay, new Set(['bundled']));

    expect(fs.readFileSync(path.join(overlay, 'bundled', 'tool.json'), 'utf8')).toBe('{}');
    expect(fs.lstatSync(path.join(overlay, 'bundled')).isSymbolicLink()).toBe(true);
  });
});
