import {
  cleanupCliMcpSession,
  purgeStaleCliMcpSessions,
} from './cli-mcp-session-artifacts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareGrokMcpSession,
  resolveGrokOverlayAuthSource,
} from './cli-mcp-session-grok';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-grok-overlay-'));
  tempDirs.push(dir);
  return dir;
}

function writeAuth(
  dir: string,
  entries: Record<string, { email?: string; expires_at?: string }>,
): void {
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(entries));
}

function entry(
  email: string,
  expiresAt: string,
): Record<string, { email?: string; expires_at?: string }> {
  return {
    'https://auth.x.ai::test-account': { email, expires_at: expiresAt },
  };
}

describe('resolveGrokOverlayAuthSource', () => {
  it('keeps providerHome when it already is the native profile', () => {
    const home = tempDir();
    const native = path.join(home, '.grok');
    fs.mkdirSync(native, { recursive: true });
    expect(resolveGrokOverlayAuthSource(native, home)).toBe(native);
  });

  it('falls back to a fresh same-account native session over a stale managed copy', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    const stale = new Date(now - 86400_000).toISOString();
    const fresh = new Date(now + 3600_000).toISOString();
    writeAuth(managed, entry('user@example.com', stale));
    writeAuth(path.join(home, '.grok'), entry('user@example.com', fresh));
    expect(resolveGrokOverlayAuthSource(managed, home, now)).toBe(
      path.join(home, '.grok'),
    );
  });

  it('keeps a managed home that already holds any fresh entry', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    writeAuth(
      managed,
      entry('other@example.com', new Date(now + 3600_000).toISOString()),
    );
    writeAuth(
      path.join(home, '.grok'),
      entry('user@example.com', new Date(now - 86400_000).toISOString()),
    );
    expect(resolveGrokOverlayAuthSource(managed, home, now)).toBe(managed);
  });

  it('never leaks a fresh native identity into a different-account pin', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    writeAuth(
      managed,
      entry('pinned@example.com', new Date(now - 86400_000).toISOString()),
    );
    writeAuth(
      path.join(home, '.grok'),
      entry('user@example.com', new Date(now + 3600_000).toISOString()),
    );
    expect(resolveGrokOverlayAuthSource(managed, home, now)).toBe(managed);
  });

  it('covers a pinned account that was never captured', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    writeAuth(
      path.join(home, '.grok'),
      entry('user@example.com', new Date(now + 3600_000).toISOString()),
    );
    expect(resolveGrokOverlayAuthSource(managed, home, now)).toBe(
      path.join(home, '.grok'),
    );
  });

  it('keeps today behavior when nothing is fresh anywhere', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    writeAuth(
      managed,
      entry('user@example.com', new Date(now - 86400_000).toISOString()),
    );
    expect(resolveGrokOverlayAuthSource(managed, home, now)).toBe(managed);
  });
});

describe('prepareGrokMcpSession auth fallback', () => {
  it('links overlay auth.json at the fresh native session, not the stale shadow', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    const artifacts = path.join(root, 'artifacts');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    writeAuth(
      managed,
      entry('user@example.com', new Date(now - 86400_000).toISOString()),
    );
    writeAuth(
      path.join(home, '.grok'),
      entry('user@example.com', new Date(now + 3600_000).toISOString()),
    );
    const prepared = prepareGrokMcpSession(
      'http://127.0.0.1:9/mcp',
      'test-token-grok-auth',
      {
        home,
        providerHome: managed,
        artifactRoot: artifacts,
        governed: true,
        cwd: root,
      },
    );
    const artifactDir = prepared.artifactDir as string;
    expect(artifactDir).toBeTruthy();
    const linked = path.join(artifactDir, 'auth.json');
    expect(fs.readlinkSync(linked)).toBe(path.join(home, '.grok', 'auth.json'));
    expect(prepared.env.GROK_HOME).toBe(artifactDir);
  });
});

describe('F-569 governed sandbox grant', () => {
  it('never grants the real provider home; only the auth pair and the checkout store', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const providerHome = path.join(home, '.grok');
    const userDataPath = path.join(root, 'user-data');
    const artifactRoot = path.join(root, 'ephemeral');
    fs.mkdirSync(providerHome, { recursive: true });
    fs.writeFileSync(path.join(providerHome, 'auth.json'), '{}');
    fs.writeFileSync(path.join(providerHome, 'auth.json.lock'), '');
    // Unrelated real secrets that live next to auth.json in ~/.grok — never
    // part of the grant surface.
    fs.writeFileSync(path.join(providerHome, 'config.toml'), 'other = 1');

    const token = 'grok-f569-sandbox-grant';
    const result = prepareGrokMcpSession('http://127.0.0.1:9/mcp', token, {
      home,
      providerHome,
      artifactRoot,
      userDataPath,
      checkoutId: 'checkout-f569',
      governed: true,
    });
    try {
      const sandboxGrant = [
        ...(result.providerStateReadPaths ?? []),
        ...(result.providerStateWritePaths ?? []),
      ];
      expect(sandboxGrant).not.toContain(providerHome);
      expect(sandboxGrant).not.toContain(path.join(providerHome, 'config.toml'));
      expect(result.providerStateReadPaths).toEqual([
        path.join(providerHome, 'auth.json'),
        path.join(providerHome, 'auth.json.lock'),
      ]);
      expect(result.providerStateWritePaths).toEqual(
        result.providerStateReadPaths,
      );
      expect(result.providerSessionHome).toBe(
        path.join(userDataPath, 'provider-state', 'grok', 'checkout-f569'),
      );
    } finally {
      cleanupCliMcpSession(token);
    }
  });
});

describe('F-566 grok checkout session isolation', () => {
  it.each([false, true])(
    'isolates conversations and preserves auth (governed=%s)',
    (governed) => {
      const root = tempDir();
      const home = path.join(root, 'home');
      const providerHome = path.join(home, '.grok');
      const userDataPath = path.join(root, 'user-data');
      const artifactRoot = path.join(root, 'ephemeral');
      const write = (file: string, value: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value);
      };
      write(
        path.join(providerHome, 'sessions', 'external.json'),
        'external conversation',
      );
      write(path.join(providerHome, 'auth.json'), '{}');
      write(path.join(providerHome, 'active_sessions.json'), 'external index');
      write(
        path.join(providerHome, 'prompt_history', 'external'),
        'external prompt',
      );
      const options = {
        home,
        providerHome,
        artifactRoot,
        userDataPath,
        checkoutId: 'checkout-a',
        governed,
      };
      const token = `grok-isolation-${governed}`;
      const first = prepareGrokMcpSession(
        'http://127.0.0.1:9/mcp',
        token,
        options,
      );
      const overlay = first.artifactDir!;
      const state = path.join(
        userDataPath,
        'provider-state',
        'grok',
        'checkout-a',
      );
      try {
        expect(fs.realpathSync(path.join(overlay, 'sessions'))).not.toBe(
          fs.realpathSync(path.join(providerHome, 'sessions')),
        );
        expect(fs.realpathSync(path.join(overlay, 'sessions'))).toBe(
          fs.realpathSync(path.join(state, 'sessions')),
        );
        expect(
          fs.existsSync(path.join(overlay, 'sessions', 'external.json')),
        ).toBe(false);
        expect(fs.realpathSync(path.join(overlay, 'auth.json'))).toBe(
          fs.realpathSync(path.join(providerHome, 'auth.json')),
        );
        expect(
          fs.realpathSync(path.join(overlay, 'active_sessions.json')),
        ).toBe(fs.realpathSync(path.join(state, 'active_sessions.json')));
        expect(
          fs.readFileSync(path.join(overlay, 'active_sessions.json'), 'utf8'),
        ).not.toContain('external');
        expect(fs.realpathSync(path.join(overlay, 'prompt_history'))).toBe(
          fs.realpathSync(path.join(state, 'prompt_history')),
        );
        write(path.join(overlay, 'sessions', 'pane.json'), 'pane conversation');
        write(path.join(overlay, 'prompt_history', 'pane'), 'pane prompt');
        expect(
          fs.existsSync(path.join(providerHome, 'sessions', 'pane.json')),
        ).toBe(false);
        // CLI atomic writes may replace a file link: never sync that index to the real home.
        fs.unlinkSync(path.join(overlay, 'active_sessions.json'));
        write(path.join(overlay, 'active_sessions.json'), 'pane index');
        const other = prepareGrokMcpSession(
          'http://127.0.0.1:9/mcp',
          `${token}-other`,
          { ...options, checkoutId: 'checkout-b' },
        );
        try {
          expect(
            fs.realpathSync(path.join(other.artifactDir!, 'sessions')),
          ).toBe(
            fs.realpathSync(
              path.join(
                userDataPath,
                'provider-state',
                'grok',
                'checkout-b',
                'sessions',
              ),
            ),
          );
          expect(
            fs.existsSync(
              path.join(other.artifactDir!, 'sessions', 'pane.json'),
            ),
          ).toBe(false);
        } finally {
          cleanupCliMcpSession(`${token}-other`);
        }
      } finally {
        cleanupCliMcpSession(token);
      }
      expect(
        fs.readFileSync(
          path.join(providerHome, 'active_sessions.json'),
          'utf8',
        ),
      ).toBe('external index');
      expect(
        fs.readFileSync(
          path.join(providerHome, 'sessions', 'external.json'),
          'utf8',
        ),
      ).toBe('external conversation');
      expect(
        fs.existsSync(path.join(providerHome, 'prompt_history', 'pane')),
      ).toBe(false);
      // A different token and artifact root model a fresh process after stale overlay purge.
      purgeStaleCliMcpSessions({ home, artifactRoot });
      const resumed = prepareGrokMcpSession(
        'http://127.0.0.1:9/mcp',
        `${token}-resume`,
        { ...options, artifactRoot: path.join(root, 'new-ephemeral') },
      );
      try {
        expect(
          fs.readFileSync(
            path.join(resumed.artifactDir!, 'sessions', 'pane.json'),
            'utf8',
          ),
        ).toBe('pane conversation');
        expect(
          fs.readFileSync(
            path.join(resumed.artifactDir!, 'prompt_history', 'pane'),
            'utf8',
          ),
        ).toBe('pane prompt');
      } finally {
        cleanupCliMcpSession(`${token}-resume`);
      }
    },
  );
});
