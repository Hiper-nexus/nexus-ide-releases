import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectSshServer, importSshConfigHosts } from './ssh-bootstrap';
import { nexusSshRegistryPath, readSshHostRegistry } from './ssh-host-registry';
import type { SshExecFile } from './ssh-bootstrap';

function execOk(): SshExecFile {
  return async (file, args) => {
    if (file === 'ssh-keygen') {
      const keyPath = String(args[args.indexOf('-f') + 1]);
      await writeFile(keyPath, 'PRIVATE', { mode: 0o600 });
      await writeFile(`${keyPath}.pub`, 'ssh-ed25519 AAAA nexus-ide:vps-1\n');
      return { stdout: '', stderr: '' };
    }
    if (file === 'ssh' && args.includes('PreferredAuthentications=password,keyboard-interactive')) {
      return { stdout: 'NEXUS_SSH_KEY_INSTALLED\n', stderr: '' };
    }
    if (file === 'ssh') {
      return { stdout: 'NEXUS_SSH_KEY_OK\n', stderr: '' };
    }
    throw new Error(`unexpected ${file}`);
  };
}

describe('ssh-bootstrap', () => {
  it('persists the alias without the password and wipes the request secret', async () => {
    const home = await mkdtemp(join(tmpdir(), 'nexus-ssh-boot-'));
    const request = {
      alias: 'vps-1',
      host: '10.0.0.8',
      user: 'ubuntu',
      password: 'hunter2-once',
    };
    const result = await connectSshServer(request, {
      home,
      exec: execOk(),
      now: () => '2026-08-14T00:00:00.000Z',
    });
    expect(result).toEqual({ ok: true, alias: 'vps-1' });
    expect(request.password).toBe('');
    const disk = await readFile(nexusSshRegistryPath(home), 'utf8');
    expect(disk).toContain('vps-1');
    expect(disk).not.toContain('hunter2-once');
    expect(disk.toLowerCase()).not.toContain('password');
    const registry = await readSshHostRegistry(home);
    expect(registry.hosts[0]).toMatchObject({
      alias: 'vps-1',
      source: 'nexus',
      user: 'ubuntu',
    });
    expect(registry.hosts[0]).not.toHaveProperty('hostname');
  });

  it('does not mark connected when password auth fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'nexus-ssh-fail-'));
    const result = await connectSshServer(
      {
        alias: 'vps-1',
        host: '10.0.0.8',
        user: 'ubuntu',
        password: 'wrong',
      },
      {
        home,
        exec: async (file) => {
          if (file === 'ssh-keygen') {
            const keyPath = join(home, '.nexus-ide/ssh/keys/vps-1');
            await writeFile(keyPath, 'PRIVATE', { mode: 0o600 });
            await writeFile(`${keyPath}.pub`, 'ssh-ed25519 AAAA nexus-ide:vps-1\n');
            return { stdout: '', stderr: '' };
          }
          throw new Error('Permission denied (password)');
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('auth');
    expect(result.error).toMatch(/Autenticação recusada/);
    expect(result.error).not.toContain('10.0.0.8');
    const registry = await readSshHostRegistry(home);
    expect(registry.hosts).toEqual([]);
  });

  it('imports existing Hosts as guests without stealing their keys', async () => {
    const home = await mkdtemp(join(tmpdir(), 'nexus-ssh-imp-'));
    await mkdir(join(home, '.ssh'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, '.ssh/config'),
      `Host corp-dev\n  HostName 10.1.2.3\n  User deploy\n  IdentityFile ~/.ssh/id_ed25519\n`,
    );
    const result = await importSshConfigHosts({
      home,
      now: () => '2026-08-14T00:00:00.000Z',
    });
    expect(result.ok).toBe(true);
    expect(result.imported).toEqual([
      {
        alias: 'corp-dev',
        source: 'imported',
        user: 'deploy',
        port: undefined,
        ready: true,
        hasNexusKey: false,
      },
    ]);
    const disk = await readFile(nexusSshRegistryPath(home), 'utf8');
    expect(disk).toContain('corp-dev');
    expect(disk).not.toContain('10.1.2.3');
  });
});
