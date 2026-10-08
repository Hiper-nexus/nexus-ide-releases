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
  ensureKimiWorkspaceTrust,
  kimiWorkDirKey,
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

describe('F-984 kimi workspace trust key', () => {
  // Raiz real do incidente (07/10 18:25): o Kimi 2.1.1 gravou o próprio trust
  // como `wd_task-f2a55551505a31ef497991782ab75148879_4c46c235dc66` depois de
  // perguntar "Trust this folder?", ao lado do arquivo de nome inteiro do Nexus.
  const incidentRoot =
    '/Users/cleofaspereirarocha/Library/Application Support/NexusIDE/project-runtime/projects/' +
    'project-5c533be885a824a09199ffb9c0d2ee8cb9a88ca6eb881cec920cf98bb0718c0f/' +
    'checkout-72eb2822b28bfda2e715c32e48902f3e75a2009ea593760804ca0bf7b72bc804/worktrees.noindex/' +
    'project-4bd6404c5885df95fc2ad9477d576c3a17870146029c7c433cdee26c29072e0d/' +
    'checkout-d09990af7caf34c0193a760f59eb215e1701f117f326a6862b6d638f0c348727/' +
    'task-f2a55551505a31ef497991782ab75148879788cb4fb43c037a322ad723383efb';

  it('uses the slug the Kimi CLI reads (40-char lowercase basename + sha12 of the root)', () => {
    expect(kimiWorkDirKey(incidentRoot)).toBe('wd_task-f2a55551505a31ef497991782ab75148879_4c46c235dc66');
    expect(kimiWorkDirKey(`${incidentRoot}/`)).toBe(kimiWorkDirKey(incidentRoot));
    expect(kimiWorkDirKey('/tmp/My Project!')).toMatch(/^wd_my-project_[0-9a-f]{12}$/);
    expect(kimiWorkDirKey('/')).toMatch(/^wd_workspace_[0-9a-f]{12}$/);
  });

  it('pre-seeds the trust file under the key the CLI looks up', () => {
    const home = tempDir();
    const cwd = path.join(tempDir(), `task-${'a'.repeat(64)}`);
    fs.mkdirSync(cwd);
    ensureKimiWorkspaceTrust(home, cwd);
    const files = fs.readdirSync(path.join(home, 'workspace-trust'));
    expect(files).toContain(kimiWorkDirKey(cwd));
    expect(kimiWorkDirKey(cwd)).toMatch(new RegExp(`^wd_task-${'a'.repeat(35)}_[0-9a-f]{12}$`));
    expect(files.some((name) => name.includes('a'.repeat(64)))).toBe(false);
    const registry = JSON.parse(fs.readFileSync(path.join(home, 'workspaces.json'), 'utf8'));
    expect(Object.keys(registry.workspaces)).toContain(kimiWorkDirKey(cwd));
  });
});
