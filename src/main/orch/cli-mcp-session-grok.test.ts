import {
  cleanupCliMcpSession,
  purgeStaleCliMcpSessions,
} from './cli-mcp-session-artifacts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  grokAuthDestinationConfined,
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

describe('F-1485: origem mais nova que o snapshot vence', () => {
  it('nada fresco: a cópia nativa MAIS NOVA da mesma conta vence o snapshot gerenciado velho', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    // Cada renovação invalida o refresh token anterior: só o mais novo serve.
    writeAuth(managed, entry('user@example.com', new Date(now - 5 * 86400_000).toISOString()));
    writeAuth(path.join(home, '.grok'), entry('user@example.com', new Date(now - 3600_000).toISOString()));
    expect(resolveGrokOverlayAuthSource(managed, home, now)).toBe(path.join(home, '.grok'));
  });

  it('nada fresco: nativa mais velha (ou de outra conta) não substitui o snapshot gerenciado', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    writeAuth(managed, entry('user@example.com', new Date(now - 3600_000).toISOString()));
    writeAuth(path.join(home, '.grok'), entry('user@example.com', new Date(now - 5 * 86400_000).toISOString()));
    expect(resolveGrokOverlayAuthSource(managed, home, now)).toBe(managed);
    writeAuth(path.join(home, '.grok'), entry('outra@example.com', new Date(now - 60_000 * 10).toISOString()));
    expect(resolveGrokOverlayAuthSource(managed, home, now)).toBe(managed);
  });

  it('o vigia vivo do pane devolve a renovação no fechamento, no próprio arquivo da origem', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const native = path.join(home, '.grok');
    const artifacts = path.join(root, 'artifacts');
    fs.mkdirSync(native, { recursive: true });
    const now = Date.now();
    writeAuth(native, entry('user@example.com', new Date(now - 3600_000).toISOString()));
    const before = fs.statSync(path.join(native, 'auth.json')).ino;
    const token = 'test-token-grok-f1485-live';
    const pane = prepareGrokMcpSession('http://127.0.0.1:9/mcp', token, {
      home, providerHome: native, artifactRoot: artifacts, governed: true, cwd: root,
    });
    const renewed = JSON.stringify(entry('user@example.com', new Date(now + 6 * 3600_000).toISOString()));
    const overlay = path.join(pane.artifactDir as string, 'auth.json');
    fs.writeFileSync(`${overlay}.tmp`, renewed);
    fs.renameSync(`${overlay}.tmp`, overlay);
    cleanupCliMcpSession(token);
    expect(fs.readFileSync(path.join(native, 'auth.json'), 'utf8')).toBe(renewed);
    expect(fs.statSync(path.join(native, 'auth.json')).ino).toBe(before);
  });
});

describe('F-1485: credencial devolvida só vai para destino FISICAMENTE confinado', () => {
  const linkDir = (target: string, link: string) =>
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

  it('home de conta salva que é junção para fora: o vigia vivo não grava lá fora', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const external = path.join(root, 'externo');
    const artifacts = path.join(root, 'artifacts');
    const accountDir = path.join(home, '.nexus', 'managed-accounts', 'grok', 'acct-a');
    fs.mkdirSync(accountDir, { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    const now = Date.now();
    const old = JSON.stringify(entry('user@example.com', new Date(now - 3600_000).toISOString()));
    fs.writeFileSync(path.join(external, 'auth.json'), old);
    linkDir(external, path.join(accountDir, 'home'));
    const token = 'test-token-grok-f1485-junction';
    const pane = prepareGrokMcpSession('http://127.0.0.1:9/mcp', token, {
      home, providerHome: path.join(accountDir, 'home'), artifactRoot: artifacts, governed: true, cwd: root,
    });
    const overlay = path.join(pane.artifactDir as string, 'auth.json');
    fs.writeFileSync(`${overlay}.tmp`, JSON.stringify(entry('user@example.com', new Date(now + 6 * 3600_000).toISOString())));
    fs.renameSync(`${overlay}.tmp`, overlay);
    cleanupCliMcpSession(token);
    expect(fs.readFileSync(path.join(external, 'auth.json'), 'utf8')).toBe(old);
  });

  it('aceita ~/.grok e o home real de uma conta salva; recusa junção, arquivo-link e caminho fora', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const native = path.join(home, '.grok');
    const managed = path.join(home, '.nexus', 'managed-accounts', 'grok', 'acct-a', 'home');
    const external = path.join(root, 'externo');
    fs.mkdirSync(native, { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    expect(grokAuthDestinationConfined(path.join(native, 'auth.json'), home)).toBe(true);
    expect(grokAuthDestinationConfined(path.join(managed, 'auth.json'), home)).toBe(true);
    expect(grokAuthDestinationConfined(path.join(native, 'outro.json'), home)).toBe(false);
    expect(grokAuthDestinationConfined(path.join(native, '..', '..', 'externo', 'auth.json'), home)).toBe(false);
    expect(grokAuthDestinationConfined(path.join(external, 'auth.json'), home)).toBe(false);
    // GROK_HOME do pane fora do home do operador não é destino.
    expect(grokAuthDestinationConfined(path.join(external, 'auth.json'), home, { extraHome: external })).toBe(false);
    const linkedAccount = path.join(home, '.nexus', 'managed-accounts', 'grok', 'acct-b');
    linkDir(path.join(home, '.nexus', 'managed-accounts', 'grok', 'acct-a'), linkedAccount);
    expect(grokAuthDestinationConfined(path.join(linkedAccount, 'home', 'auth.json'), home)).toBe(false);
    fs.writeFileSync(path.join(external, 'alvo.json'), '{}');
    try {
      fs.symlinkSync(path.join(external, 'alvo.json'), path.join(native, 'auth.json'), 'file');
    } catch {
      return; // Windows sem privilégio de symlink de arquivo: a junção acima já cobre o caso.
    }
    expect(grokAuthDestinationConfined(path.join(native, 'auth.json'), home)).toBe(false);
  });

  it('GROK_HOME do pane dentro do home: aceito real, recusado com junção num ancestral', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const realParent = path.join(home, 'perfis');
    const custom = path.join(realParent, 'grok-a');
    const external = path.join(root, 'externo');
    fs.mkdirSync(custom, { recursive: true });
    fs.mkdirSync(path.join(external, 'grok-b'), { recursive: true });
    expect(grokAuthDestinationConfined(path.join(custom, 'auth.json'), home, { extraHome: custom })).toBe(true);
    linkDir(external, path.join(home, 'atalho'));
    const viaJunction = path.join(home, 'atalho', 'grok-b');
    expect(grokAuthDestinationConfined(path.join(viaJunction, 'auth.json'), home, { extraHome: viaJunction })).toBe(false);
  });

  it('hardlink estranho no auth.json é recusado; os hardlinks dos overlays do Nexus não', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const native = path.join(home, '.grok');
    const artifacts = path.join(root, 'artifacts');
    const external = path.join(root, 'externo');
    fs.mkdirSync(native, { recursive: true });
    fs.mkdirSync(path.join(artifacts, 'grok', 'overlay-a'), { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    const target = path.join(native, 'auth.json');
    fs.writeFileSync(target, '{}');
    fs.linkSync(target, path.join(artifacts, 'grok', 'overlay-a', 'auth.json'));
    expect(grokAuthDestinationConfined(target, home, { artifactRoot: artifacts })).toBe(true);
    fs.linkSync(target, path.join(external, 'copia.json'));
    expect(grokAuthDestinationConfined(target, home, { artifactRoot: artifacts })).toBe(false);
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
