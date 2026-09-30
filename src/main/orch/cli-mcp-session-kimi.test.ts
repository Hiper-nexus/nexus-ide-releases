import {
  cleanupCliMcpSession,
  purgeStaleCliMcpSessions,
} from './cli-mcp-session-artifacts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNexusHookText } from '../../vendor/emdash/hooks/hook-commands';
import {
  prepareKimiMcpSession,
  projectKimiNativeCatalog,
  restoreKimiOverlayCatalog,
} from './cli-mcp-session-kimi';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-kimi-overlay-'));
  tempDirs.push(dir);
  return dir;
}

describe('F-569 governed sandbox grant', () => {
  it('never grants the real provider home; only credentials/oauth and the checkout store', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const providerHome = path.join(home, '.kimi-code');
    const userDataPath = path.join(root, 'user-data');
    const artifactRoot = path.join(root, 'ephemeral');
    fs.mkdirSync(path.join(providerHome, 'credentials'), { recursive: true });
    fs.writeFileSync(
      path.join(providerHome, 'credentials', 'kimi-code.json'),
      '{}',
    );
    // Unrelated real state that lives next to credentials/ in ~/.kimi-code —
    // never part of the grant surface.
    fs.writeFileSync(path.join(providerHome, 'device_id'), 'device-secret');

    const token = 'kimi-f569-sandbox-grant';
    const result = prepareKimiMcpSession('http://127.0.0.1:9/mcp', token, {
      home,
      providerHome,
      artifactRoot,
      userDataPath,
      checkoutId: 'checkout-f569',
      governed: true,
      allowedSkills: [],
    });
    try {
      const sandboxGrant = [
        ...(result.providerStateReadPaths ?? []),
        ...(result.providerStateWritePaths ?? []),
      ];
      expect(sandboxGrant).not.toContain(providerHome);
      expect(sandboxGrant).not.toContain(path.join(providerHome, 'device_id'));
      expect(result.providerStateReadPaths).toEqual([
        path.join(providerHome, 'credentials'),
      ]);
      expect(result.providerStateWritePaths).toEqual(
        result.providerStateReadPaths,
      );
      expect(result.providerSessionHome).toBe(
        path.join(userDataPath, 'provider-state', 'kimi', 'checkout-f569'),
      );
    } finally {
      cleanupCliMcpSession(token);
    }
  });
});

describe('F-566 kimi checkout session isolation', () => {
  it.each([false, true])(
    'isolates conversations and preserves auth (governed=%s)',
    (governed) => {
      const root = tempDir();
      const home = path.join(root, 'home');
      const providerHome = path.join(home, '.kimi-code');
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
      write(path.join(providerHome, 'credentials/auth.json'), '{}');
      write(path.join(providerHome, 'session_index.jsonl'), 'external index');
      write(
        path.join(providerHome, 'user-history', 'external'),
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
      const token = `kimi-isolation-${governed}`;
      const first = prepareKimiMcpSession(
        'http://127.0.0.1:9/mcp',
        token,
        options,
      );
      const overlay = first.artifactDir!;
      const state = path.join(
        userDataPath,
        'provider-state',
        'kimi',
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
        expect(
          fs.realpathSync(path.join(overlay, 'credentials/auth.json')),
        ).toBe(
          fs.realpathSync(path.join(providerHome, 'credentials/auth.json')),
        );
        expect(fs.realpathSync(path.join(overlay, 'session_index.jsonl'))).toBe(
          fs.realpathSync(path.join(state, 'session_index.jsonl')),
        );
        expect(
          fs.readFileSync(path.join(overlay, 'session_index.jsonl'), 'utf8'),
        ).not.toContain('external');
        expect(fs.realpathSync(path.join(overlay, 'user-history'))).toBe(
          fs.realpathSync(path.join(state, 'user-history')),
        );
        write(path.join(overlay, 'sessions', 'pane.json'), 'pane conversation');
        write(path.join(overlay, 'user-history', 'pane'), 'pane prompt');
        expect(
          fs.existsSync(path.join(providerHome, 'sessions', 'pane.json')),
        ).toBe(false);
        // CLI atomic writes may replace a file link: never sync that index to the real home.
        fs.unlinkSync(path.join(overlay, 'session_index.jsonl'));
        write(path.join(overlay, 'session_index.jsonl'), 'pane index');
        const other = prepareKimiMcpSession(
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
                'kimi',
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
        fs.readFileSync(path.join(providerHome, 'session_index.jsonl'), 'utf8'),
      ).toBe('external index');
      expect(
        fs.readFileSync(
          path.join(providerHome, 'sessions', 'external.json'),
          'utf8',
        ),
      ).toBe('external conversation');
      expect(
        fs.existsSync(path.join(providerHome, 'user-history', 'pane')),
      ).toBe(false);
      // A different token and artifact root model a fresh process after stale overlay purge.
      purgeStaleCliMcpSessions({ home, artifactRoot });
      const resumed = prepareKimiMcpSession(
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
            path.join(resumed.artifactDir!, 'user-history', 'pane'),
            'utf8',
          ),
        ).toBe('pane prompt');
      } finally {
        cleanupCliMcpSession(`${token}-resume`);
      }
    },
  );
});

const KIMI_NATIVE_CATALOG = `default_model = "kimi-code/k3"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = "https://api.kimi.com/coding/v1"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
`;

describe('F-611 kimi overlay model catalog', () => {
  function seedCatalogHome(): {
    home: string;
    providerHome: string;
    artifactRoot: string;
    nativeToml: string;
  } {
    const root = tempDir();
    const home = path.join(root, 'home');
    const nativeHome = path.join(home, '.kimi-code');
    const nativeToml = path.join(nativeHome, 'config.toml');
    fs.mkdirSync(nativeHome, { recursive: true });
    fs.writeFileSync(nativeToml, KIMI_NATIVE_CATALOG);
    return {
      home,
      providerHome: nativeHome,
      artifactRoot: path.join(root, 'ephemeral'),
      nativeToml,
    };
  }

  it('projects native models into an overlay that lost the catalog', () => {
    expect(
      projectKimiNativeCatalog(
        { default_model: 'kimi-code/kimi-for-coding' },
        {
          default_model: 'kimi-code/k3',
          models: {
            'kimi-code/k3': { model: 'k3' },
            'kimi-code/kimi-for-coding': { model: 'kimi-for-coding' },
          },
          providers: { 'managed:kimi-code': { type: 'kimi' } },
        },
      ),
    ).toEqual({
      default_model: 'kimi-code/kimi-for-coding',
      models: {
        'kimi-code/k3': { model: 'k3' },
        'kimi-code/kimi-for-coding': { model: 'kimi-for-coding' },
      },
      providers: { 'managed:kimi-code': { type: 'kimi' } },
    });
  });

  it('writes models/providers into the overlay when native config.toml is a symlink', () => {
    const seeded = seedCatalogHome();
    const managedHome = path.join(seeded.home, 'managed-kimi');
    fs.mkdirSync(managedHome, { recursive: true });
    fs.symlinkSync(seeded.nativeToml, path.join(managedHome, 'config.toml'));
    const token = 'kimi-f611-symlink-catalog';
    const result = prepareKimiMcpSession('http://127.0.0.1:9/mcp', token, {
      home: seeded.home,
      providerHome: managedHome,
      artifactRoot: seeded.artifactRoot,
    });
    try {
      const overlayToml = fs.readFileSync(
        path.join(result.env.KIMI_CODE_HOME, 'config.toml'),
        'utf8',
      );
      expect(overlayToml).toContain('kimi-code/k3');
      expect(overlayToml).toContain('managed:kimi-code');
      expect(isNexusHookText(overlayToml)).toBe(true);
      expect(fs.readFileSync(seeded.nativeToml, 'utf8')).toBe(
        KIMI_NATIVE_CATALOG,
      );
    } finally {
      cleanupCliMcpSession(token);
    }
  });

  it('restores native models after the CLI rewrites overlay config.toml', () => {
    const seeded = seedCatalogHome();
    const overlayToml = path.join(tempDir(), 'overlay', 'config.toml');
    fs.mkdirSync(path.dirname(overlayToml), { recursive: true });
    fs.writeFileSync(
      overlayToml,
      'default_model = "kimi-code/kimi-for-coding"\n',
    );
    expect(restoreKimiOverlayCatalog(overlayToml, seeded.nativeToml)).toBe(
      true,
    );
    const restored = fs.readFileSync(overlayToml, 'utf8');
    expect(restored).toContain('default_model = "kimi-code/kimi-for-coding"');
    expect(restored).toContain('kimi-code/k3');
    expect(restored).toContain('managed:kimi-code');
    expect(isNexusHookText(restored)).toBe(true);
    expect(restoreKimiOverlayCatalog(overlayToml, seeded.nativeToml)).toBe(
      false,
    );
  });

  it('reprojects the catalog when the live overlay config.toml is replaced', async () => {
    const seeded = seedCatalogHome();
    const token = 'kimi-f611-live-rewrite';
    const result = prepareKimiMcpSession('http://127.0.0.1:9/mcp', token, {
      home: seeded.home,
      providerHome: seeded.providerHome,
      artifactRoot: seeded.artifactRoot,
    });
    const overlayToml = path.join(result.env.KIMI_CODE_HOME, 'config.toml');
    try {
      const tmp = `${overlayToml}.tmp`;
      fs.writeFileSync(
        tmp,
        'default_model = "kimi-code/kimi-for-coding"\n',
      );
      fs.renameSync(tmp, overlayToml);
      await vi.waitFor(() => {
        const body = fs.readFileSync(overlayToml, 'utf8');
        expect(body).toContain('kimi-code/k3');
        expect(body).toContain('default_model = "kimi-code/kimi-for-coding"');
      });
    } finally {
      cleanupCliMcpSession(token);
    }
  });
});
