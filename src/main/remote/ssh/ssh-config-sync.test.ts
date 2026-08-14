import { describe, expect, it } from 'vitest';
import {
  parseImportableSshHosts,
  plantSshConfigInclude,
  removeManagedHostBlock,
  renderManagedHostBlock,
  upsertManagedHostBlock,
} from './ssh-config-sync';

describe('ssh-config-sync', () => {
  it('imports concrete Host aliases without copying keys or IP-named hosts', () => {
    const imported = parseImportableSshHosts(
      `
Host vps-1
  HostName 10.0.0.8
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519
Host 173.249.27.211
  User root
Host *.lab
  User lab
Host radarbi-hostgator
  HostName box.example
  User deploy
`,
      { home: '/Users/me' },
    );
    expect(imported.map((host) => host.alias)).toEqual([
      'vps-1',
      'radarbi-hostgator',
    ]);
    expect(imported[0]?.identityFile).toBe('/Users/me/.ssh/id_ed25519');
    expect(imported.find((host) => host.alias === 'vps-1')?.user).toBe('ubuntu');
  });

  it('writes a Host block with IdentitiesOnly and no password', () => {
    const block = renderManagedHostBlock({
      alias: 'vps-1',
      hostname: '10.0.0.8',
      user: 'ubuntu',
      identityFile: '/Users/me/.nexus-ide/ssh/keys/vps-1',
    });
    expect(block).toContain('Host vps-1');
    expect(block).toContain('IdentityFile /Users/me/.nexus-ide/ssh/keys/vps-1');
    expect(block).toContain('IdentitiesOnly yes');
    expect(block.toLowerCase()).not.toContain('password');
    expect(block.toLowerCase()).not.toContain('senha');

    const next = upsertManagedHostBlock('', block, 'vps-1');
    const replaced = upsertManagedHostBlock(
      next,
      renderManagedHostBlock({
        alias: 'vps-1',
        hostname: '10.0.0.9',
        user: 'ubuntu',
        identityFile: '/Users/me/.nexus-ide/ssh/keys/vps-1',
      }),
      'vps-1',
    );
    expect(replaced).toContain('10.0.0.9');
    expect(replaced.match(/Host vps-1/g)).toHaveLength(1);
    expect(removeManagedHostBlock(replaced, 'vps-1')).not.toContain('vps-1');
  });

  it('plants a single Include for the Nexus-managed config', () => {
    const first = plantSshConfigInclude('', '/Users/me/.nexus-ide/ssh/config');
    expect(first.planted).toBe(true);
    expect(first.next).toContain('Include /Users/me/.nexus-ide/ssh/config');
    const second = plantSshConfigInclude(
      first.next,
      '/Users/me/.nexus-ide/ssh/config',
    );
    expect(second.planted).toBe(false);
  });
});
