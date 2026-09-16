import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkProviderSessionState } from './cli-mcp-session-artifacts';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
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
