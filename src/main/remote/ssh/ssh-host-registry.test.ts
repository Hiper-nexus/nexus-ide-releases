import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  nexusSshRegistryPath,
  parseSshHostRegistry,
  serializeSshHostRegistry,
  upsertSshHostRecord,
} from './ssh-host-registry';

describe('ssh-host-registry', () => {
  it('serializes hosts without password, hostname or IP fields', () => {
    const raw = serializeSshHostRegistry({
      version: 1,
      hosts: [
        {
          alias: 'vps-1',
          source: 'nexus',
          user: 'ubuntu',
          identityFile: '/tmp/.nexus-ide/ssh/keys/vps-1',
          createdAt: '2026-08-14T00:00:00.000Z',
          lastOkAt: '2026-08-14T00:00:00.000Z',
        },
      ],
    });
    expect(raw).toContain('"alias": "vps-1"');
    expect(raw.toLowerCase()).not.toContain('password');
    expect(raw.toLowerCase()).not.toContain('senha');
    expect(raw).not.toContain('hostname');
    expect(raw).not.toContain('10.0.0');
  });

  it('drops forbidden keys when reading a tampered file', () => {
    const parsed = parseSshHostRegistry(
      JSON.stringify({
        version: 1,
        hosts: [
          {
            alias: 'vps-1',
            source: 'nexus',
            createdAt: '2026-08-14T00:00:00.000Z',
            password: 'should-be-ignored',
            hostname: '10.0.0.8',
          },
        ],
      }),
    );
    expect(parsed.hosts).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain('should-be-ignored');
    expect(JSON.stringify(parsed)).not.toContain('10.0.0.8');
  });

  it('writes hosts.json without the bootstrap password', async () => {
    const home = await mkdtemp(join(tmpdir(), 'nexus-ssh-reg-'));
    await upsertSshHostRecord(
      {
        alias: 'vps-1',
        source: 'nexus',
        user: 'ubuntu',
        identityFile: join(home, '.nexus-ide/ssh/keys/vps-1'),
        createdAt: '2026-08-14T00:00:00.000Z',
        lastOkAt: '2026-08-14T00:00:00.000Z',
      },
      home,
    );
    const disk = await readFile(nexusSshRegistryPath(home), 'utf8');
    expect(disk).toContain('vps-1');
    expect(disk.toLowerCase()).not.toContain('password');
    expect(disk).not.toContain('hunter2');
  });
});
