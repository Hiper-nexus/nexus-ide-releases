// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: apps/emdash-desktop/src/main/core/ssh/config/sshConfigParser.test.ts
// See src/vendor/emdash/ssh/LICENSE.md. Nexus changes: import repointed to the
// kebab-case ./ssh-config-parser; added Nexus-authored coverage for the
// Include cycle guard, full-line comments and explicit wildcard-only Host
// blocks (final describe block) — upstream had no direct tests for those.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findSshConfigHostByHostName,
  parseSshConfigContent,
  parseSshConfigFileAt,
} from './ssh-config-parser';

describe('parseSshConfigContent', () => {
  it('lists concrete SSH config aliases with proxy and forwarding preview fields', () => {
    const hosts = parseSshConfigContent(`
Host *.internal
  ProxyJump ignored

Host corp-dev corp-dev-alt
  HostName dev.internal
  User alice
  Port 2222
  IdentityFile ~/.ssh/dev_ed25519
  IdentityAgent "~/.1password/agent.sock"
  ProxyCommand cloudflared access ssh --hostname %h
  ForwardAgent $SSH_AUTH_SOCK

Host plain
  HostName plain.example.com
  ProxyJump bastion.example.com
  ForwardAgent no
`);

    expect(hosts).toEqual([
      {
        host: 'corp-dev',
        hostname: 'dev.internal',
        user: 'alice',
        port: 2222,
        identityFile: expect.stringContaining('/.ssh/dev_ed25519'),
        identityAgent: expect.stringContaining('/.1password/agent.sock'),
        proxyCommand: 'cloudflared access ssh --hostname %h',
        forwardAgent: true,
        forwardAgentValue: '$SSH_AUTH_SOCK',
      },
      {
        host: 'corp-dev-alt',
        hostname: 'dev.internal',
        user: 'alice',
        port: 2222,
        identityFile: expect.stringContaining('/.ssh/dev_ed25519'),
        identityAgent: expect.stringContaining('/.1password/agent.sock'),
        proxyCommand: 'cloudflared access ssh --hostname %h',
        forwardAgent: true,
        forwardAgentValue: '$SSH_AUTH_SOCK',
      },
      {
        host: 'plain',
        hostname: 'plain.example.com',
        proxyJump: 'bastion.example.com',
        forwardAgent: false,
      },
    ]);
  });

  it('keeps aliases without an explicit user so ssh -G can resolve them later', () => {
    const hosts = parseSshConfigContent(`
Host corp-dev
  HostName dev.internal
  ProxyJump bastion
`);

    expect(hosts).toEqual([
      {
        host: 'corp-dev',
        hostname: 'dev.internal',
        proxyJump: 'bastion',
      },
    ]);
  });

  it('matches HostName previews case-insensitively for legacy fallback', () => {
    expect(
      findSshConfigHostByHostName(
        [
          {
            host: 'corp-dev',
            hostname: 'dev.internal',
          },
        ],
        'DEV.INTERNAL'
      )
    ).toEqual({
      host: 'corp-dev',
      hostname: 'dev.internal',
    });
  });

  it('lists aliases from included SSH config files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emdash-ssh-config-'));
    await mkdir(join(dir, 'conf.d'));
    await writeFile(
      join(dir, 'config'),
      `
Host root-alias
  HostName root.internal

Include conf.d/*.conf
`,
      'utf-8'
    );
    await writeFile(
      join(dir, 'conf.d', 'team.conf'),
      `
Host included-alias
  HostName included.internal
  User alice
`,
      'utf-8'
    );

    expect(await parseSshConfigFileAt(join(dir, 'config'))).toEqual([
      {
        host: 'root-alias',
        hostname: 'root.internal',
      },
      {
        host: 'included-alias',
        hostname: 'included.internal',
        user: 'alice',
      },
    ]);
  });

  it('applies the same included snippet at each Include occurrence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emdash-ssh-config-repeat-'));
    await writeFile(
      join(dir, 'shared.conf'),
      `
  User shared
  IdentityAgent ~/.ssh/shared-agent.sock
`,
      'utf-8'
    );
    await writeFile(
      join(dir, 'config'),
      `
Host first
  HostName first.internal
  Include shared.conf

Host second
  HostName second.internal
  Include shared.conf
`,
      'utf-8'
    );

    expect(await parseSshConfigFileAt(join(dir, 'config'))).toEqual([
      {
        host: 'first',
        hostname: 'first.internal',
        user: 'shared',
        identityAgent: expect.stringContaining('/.ssh/shared-agent.sock'),
      },
      {
        host: 'second',
        hostname: 'second.internal',
        user: 'shared',
        identityAgent: expect.stringContaining('/.ssh/shared-agent.sock'),
      },
    ]);
  });
});

// Nexus-authored: upstream shipped the cycle guard without direct tests.
describe('parseSshConfigFileAt robustness', () => {
  it('terminates on cyclic Include graphs and reads each file once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-ssh-config-cycle-'));
    await writeFile(
      join(dir, 'a.conf'),
      `Host a-alias
  HostName a.internal
  Include b.conf
`,
      'utf-8'
    );
    await writeFile(
      join(dir, 'b.conf'),
      `Host b-alias
  HostName b.internal
  Include a.conf
`,
      'utf-8'
    );

    // a.conf includes b.conf, b.conf includes a.conf: the cycle guard cuts the
    // second read of a.conf, so each alias appears exactly once.
    expect(await parseSshConfigFileAt(join(dir, 'a.conf'))).toEqual([
      { host: 'a-alias', hostname: 'a.internal' },
      { host: 'b-alias', hostname: 'b.internal' },
    ]);
  });

  it('cuts self-includes without dropping the rest of the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-ssh-config-self-include-'));
    await writeFile(
      join(dir, 'config'),
      `Host before
  HostName before.internal
Include config
Host after
  HostName after.internal
`,
      'utf-8'
    );

    expect(await parseSshConfigFileAt(join(dir, 'config'))).toEqual([
      { host: 'before', hostname: 'before.internal' },
      { host: 'after', hostname: 'after.internal' },
    ]);
  });

  it('skips full-line comments and blank lines', () => {
    const hosts = parseSshConfigContent(`# leading comment

Host box
  # comment inside a block
  HostName box.internal

# trailing comment
`);

    expect(hosts).toEqual([{ host: 'box', hostname: 'box.internal' }]);
  });

  it('skips wildcard-only Host blocks but keeps concrete aliases', () => {
    const hosts = parseSshConfigContent(`
Host *
  User everyone

Host ?ingle
  User nope

Host solid
  User yes
`);

    expect(hosts).toEqual([{ host: 'solid', user: 'yes' }]);
  });
});
