// Nexus-authored tests for the ssh-config-service alias resolution layer.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  listSshConfigHosts,
  resolveSshConnectDefaults,
} from './ssh-config-service';
import type { SshConfigRunner } from '../../../vendor/emdash/ssh/resolve-ssh-config';

const SSH_G_CORP: SshConfigRunner = async () => ({
  stdout: `
hostname dev.internal
user deploy
port 2201
identityfile ~/.ssh/id_ed25519
proxyjump bastion.example.com
`,
  stderr: '',
});

describe('resolveSshConnectDefaults', () => {
  const aliases = [
    {
      host: 'corp-dev',
      hostname: 'dev-preview.internal',
      user: 'preview-user',
      proxyJump: 'preview-bastion',
    },
  ];

  it('resolves a known alias through ssh -G (canonical values win)', async () => {
    const defaults = await resolveSshConnectDefaults('corp-dev', {
      listHosts: async () => aliases,
      runner: SSH_G_CORP,
    });

    expect(defaults).toEqual({
      alias: 'corp-dev',
      host: 'dev.internal',
      port: 2201,
      username: 'deploy',
      proxyJump: 'bastion.example.com',
      proxyCommand: undefined,
      identityFiles: ['~/.ssh/id_ed25519'],
    });
  });

  it('returns null for a host that is not a declared alias (never rewrites explicit hosts)', async () => {
    await expect(
      resolveSshConnectDefaults('10.0.0.5', { listHosts: async () => aliases, runner: SSH_G_CORP }),
    ).resolves.toBeNull();
    await expect(
      resolveSshConnectDefaults('corp-prod', { listHosts: async () => aliases, runner: SSH_G_CORP }),
    ).resolves.toBeNull();
  });

  it('falls back to parser preview fields when ssh -G is unavailable', async () => {
    const defaults = await resolveSshConnectDefaults('corp-dev', {
      listHosts: async () => aliases,
      runner: async () => {
        throw new Error('spawn ssh ENOENT');
      },
    });

    expect(defaults).toEqual({
      alias: 'corp-dev',
      host: 'dev-preview.internal',
      port: undefined,
      username: 'preview-user',
      proxyJump: 'preview-bastion',
      proxyCommand: undefined,
      identityFiles: undefined,
    });
  });

  it('returns null when the alias listing itself fails (best-effort, fail soft)', async () => {
    await expect(
      resolveSshConnectDefaults('corp-dev', {
        listHosts: async () => {
          throw new Error('EACCES');
        },
        runner: SSH_G_CORP,
      }),
    ).resolves.toBeNull();
  });

  it('maps the OpenSSH default port 22 to undefined', async () => {
    const runner: SshConfigRunner = async () => ({
      stdout: 'hostname plain.internal\nuser root\nport 22\n',
      stderr: '',
    });

    await expect(
      resolveSshConnectDefaults('corp-dev', { listHosts: async () => aliases, runner }),
    ).resolves.toMatchObject({ host: 'plain.internal', port: undefined });
  });
});

describe('listSshConfigHosts', () => {
  it('parses aliases from an explicit config path (Include expansion active)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-ssh-service-'));
    await writeFile(
      join(dir, 'config'),
      `Host svc-alias
  HostName svc.internal
Include extra.conf
`,
      'utf-8',
    );
    await writeFile(
      join(dir, 'extra.conf'),
      `Host svc-included
  HostName included.internal
`,
      'utf-8',
    );

    await expect(listSshConfigHosts(join(dir, 'config'))).resolves.toEqual([
      { host: 'svc-alias', hostname: 'svc.internal' },
      { host: 'svc-included', hostname: 'included.internal' },
    ]);
  });

  it('returns an empty list when the config cannot be read', async () => {
    await expect(
      listSshConfigHosts('/definitely/not/a/real/ssh/config'),
    ).resolves.toEqual([]);
  });
});
