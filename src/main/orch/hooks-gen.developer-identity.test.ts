import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupSessionArtifacts,
  DEVELOPER_IDENTITY_HOME_ENTRIES,
  prepareEphemeralHome,
} from './hooks-gen';

const TOKEN = `dev-identity-test-${process.pid}-${Date.now()}`;

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dev-identity-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  cleanupSessionArtifacts(TOKEN);
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function write(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

describe('F-579 developer identity in the ephemeral HOME', () => {
  it('carryDeveloperIdentity links the exact identity entries and nothing else', () => {
    write(path.join(home, '.gitconfig'), '[user]\n\temail = dev@example.test\n');
    write(path.join(home, '.git-credentials'), 'https://x@github.test\n');
    write(path.join(home, '.netrc'), 'machine github.test\n');
    write(path.join(home, '_netrc'), 'machine github.test\n');
    write(path.join(home, '.ssh', 'id_test'), 'key');
    write(path.join(home, '.ssh', 'config'), 'Host *\n');
    write(path.join(home, '.gnupg', 'x'), 'gpg');
    write(path.join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n');
    write(path.join(home, '.config', 'git', 'config'), '[user]\n');
    write(path.join(home, '.zshrc'), 'alias x=y\n');

    const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} }, {
      carryDeveloperIdentity: true,
    });

    for (const rel of DEVELOPER_IDENTITY_HOME_ENTRIES) {
      expect(
        fs.existsSync(path.join(overlay.dir, rel)),
        `missing ${rel}`,
      ).toBe(true);
      if (process.platform !== 'win32') {
        expect(
          fs.lstatSync(path.join(overlay.dir, rel)).isSymbolicLink(),
          `${rel} should be a symlink`,
        ).toBe(true);
      }
      expect(fs.realpathSync(path.join(overlay.dir, rel))).toBe(
        fs.realpathSync(path.join(home, rel)),
      );
    }
    // `.config` é um diretório REAL no overlay contendo só gh e git — nunca
    // o `.config` inteiro do operador.
    const overlayConfig = path.join(overlay.dir, '.config');
    expect(fs.lstatSync(overlayConfig).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.lstatSync(overlayConfig).isSymbolicLink()).toBe(false);
    }
    expect(fs.readdirSync(overlayConfig).sort()).toEqual(['gh', 'git']);
    // O que não é identidade não entra.
    expect(fs.existsSync(path.join(overlay.dir, '.zshrc'))).toBe(false);
    // `.claude.json` do overlay é o stub Nexus, não o arquivo real.
    const stub = JSON.parse(
      fs.readFileSync(path.join(overlay.dir, '.claude.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(stub.hasCompletedOnboarding).toBe(true);
    expect(fs.lstatSync(path.join(overlay.dir, '.claude.json')).isFile()).toBe(
      true,
    );
  });

  it('skips identity entries that do not exist in the real HOME', () => {
    write(path.join(home, '.gitconfig'), '[user]\n\temail = dev@example.test\n');

    const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} }, {
      carryDeveloperIdentity: true,
    });

    expect(fs.existsSync(path.join(overlay.dir, '.gitconfig'))).toBe(true);
    expect(fs.existsSync(path.join(overlay.dir, '.ssh'))).toBe(false);
    expect(fs.existsSync(path.join(overlay.dir, '.config'))).toBe(false);
    expect(fs.existsSync(path.join(overlay.dir, '.netrc'))).toBe(false);
  });

  it('carries nothing by default (fail-closed read-only lane)', () => {
    write(path.join(home, '.gitconfig'), '[user]\n');
    write(path.join(home, '.ssh', 'id_test'), 'key');

    const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} });

    for (const rel of DEVELOPER_IDENTITY_HOME_ENTRIES) {
      expect(fs.existsSync(path.join(overlay.dir, rel)), rel).toBe(false);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'carryNativeHome links the whole HOME minus Claude/Nexus conversation state',
    () => {
      write(path.join(home, '.zshrc'), 'zshrc');
      write(path.join(home, '.zshenv'), 'zshenv');
      write(path.join(home, '.npmrc'), 'npmrc');
      write(path.join(home, '.config', 'typesafe', 'env'), 'env');
      write(path.join(home, '.aws', 'credentials'), 'aws');
      write(path.join(home, 'Documents', 'notes.txt'), 'notes');
      write(path.join(home, '.claude.json.backup'), '{"backup":true}');
      write(path.join(home, '.claude', 'projects', 'x.jsonl'), 'conv');
      write(path.join(home, '.nexus', 'anything'), 'nexus');
      write(
        path.join(home, 'Library', 'Keychains', 'login.keychain-db'),
        'db',
      );
      write(path.join(home, '.Trash', 'junk'), 'junk');
      write(path.join(home, '.claude-mem', 'data'), 'mem');

      const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} }, {
        carryNativeClaudeAuth: false,
        carryNativeHome: true,
      });

      for (const rel of [
        '.zshrc',
        '.zshenv',
        '.npmrc',
        '.config',
        '.aws',
        'Documents',
        '.claude-mem',
      ]) {
        const target = path.join(overlay.dir, rel);
        expect(fs.lstatSync(target).isSymbolicLink(), rel).toBe(true);
        expect(fs.realpathSync(target)).toBe(
          fs.realpathSync(path.join(home, rel)),
        );
      }
      // `.claude` do overlay é diretório REAL e não carrega a conversa real.
      const overlayClaude = path.join(overlay.dir, '.claude');
      expect(fs.lstatSync(overlayClaude).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(overlayClaude).isDirectory()).toBe(true);
      expect(
        fs.existsSync(path.join(overlayClaude, 'projects', 'x.jsonl')),
      ).toBe(false);
      // `.claude.json` do overlay é o stub; backups e estado Nexus ficam fora.
      const stub = JSON.parse(
        fs.readFileSync(path.join(overlay.dir, '.claude.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(stub.hasCompletedOnboarding).toBe(true);
      expect(fs.existsSync(path.join(overlay.dir, '.claude.json.backup'))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(overlay.dir, '.nexus'))).toBe(false);
      expect(fs.existsSync(path.join(overlay.dir, '.Trash'))).toBe(false);
      // Sem a política keychain (F-575), Library nunca entra pelo tier 2.
      expect(fs.existsSync(path.join(overlay.dir, 'Library'))).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'carryNativeHome keeps the F-575 per-file keychain policy as the only Library path',
    () => {
      write(
        path.join(home, 'Library', 'Keychains', 'login.keychain-db'),
        'db',
      );
      write(path.join(home, 'Library', 'other-stuff'), 'x');
      write(path.join(home, '.zshrc'), 'zshrc');

      const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} }, {
        carryNativeClaudeAuth: true,
        gateHooks: false,
        carryNativeHome: true,
      });

      const keychain = path.join(
        overlay.dir,
        'Library',
        'Keychains',
        'login.keychain-db',
      );
      // O keychain-db continua sendo linkado arquivo a arquivo (F-575) — o
      // diretório Library em si NUNCA vira symlink para o real.
      expect(fs.lstatSync(keychain).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(keychain)).toBe(
        fs.realpathSync(
          path.join(home, 'Library', 'Keychains', 'login.keychain-db'),
        ),
      );
      expect(
        fs.lstatSync(path.join(overlay.dir, 'Library')).isSymbolicLink(),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(overlay.dir, 'Library', 'other-stuff')),
      ).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'teardown removes the overlay without ever following the links',
    () => {
      write(path.join(home, '.zshrc'), 'zshrc-content');
      write(path.join(home, '.aws', 'credentials'), 'aws-content');
      write(path.join(home, '.config', 'typesafe', 'env'), 'env-content');
      write(path.join(home, 'Documents', 'notes.txt'), 'notes-content');

      const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} }, {
        carryNativeClaudeAuth: false,
        carryNativeHome: true,
      });
      expect(fs.existsSync(overlay.dir)).toBe(true);

      cleanupSessionArtifacts(TOKEN);

      expect(fs.existsSync(overlay.dir)).toBe(false);
      for (const [rel, content] of [
        ['.zshrc', 'zshrc-content'],
        [path.join('.aws', 'credentials'), 'aws-content'],
        [path.join('.config', 'typesafe', 'env'), 'env-content'],
        [path.join('Documents', 'notes.txt'), 'notes-content'],
      ] as const) {
        expect(fs.readFileSync(path.join(home, rel), 'utf8')).toBe(content);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'git inside the overlay reads the operator global config',
    () => {
      write(
        path.join(home, '.gitconfig'),
        '[user]\n\temail = overlay@example.test\n',
      );

      const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} }, {
        carryDeveloperIdentity: true,
      });

      const env: NodeJS.ProcessEnv = { ...process.env, HOME: overlay.dir };
      delete env.GIT_CONFIG_GLOBAL;
      delete env.GIT_CONFIG_NOSYSTEM;
      delete env.XDG_CONFIG_HOME;
      const result = spawnSync(
        'git',
        ['config', '--global', '--get', 'user.email'],
        { env, encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('overlay@example.test');
    },
  );
});
