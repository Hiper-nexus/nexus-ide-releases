import { describe, expect, it } from 'vitest';
import { resolveSshConfigHomePath } from './ssh-config-path-expansion';

describe('resolveSshConfigHomePath', () => {
  it('expands ~ and ~/', () => {
    expect(resolveSshConfigHomePath('~', '/home/u')).toBe('/home/u');
    expect(resolveSshConfigHomePath('~/.ssh/id_ed25519', '/home/u')).toBe(
      '/home/u/.ssh/id_ed25519',
    );
  });

  it('leaves absolute paths unchanged', () => {
    expect(resolveSshConfigHomePath('/etc/ssh/key', '/home/u')).toBe('/etc/ssh/key');
  });

  it('expands the __PROGRAMDATA__ token Windows ssh -G prints unexpanded', () => {
    const originalProgramData = process.env.ProgramData;
    try {
      process.env.ProgramData = '/mnt/c/ProgramData';
      expect(
        resolveSshConfigHomePath('__PROGRAMDATA__/ssh/ssh_known_hosts', '/home/u'),
      ).toBe('/mnt/c/ProgramData/ssh/ssh_known_hosts');
    } finally {
      if (originalProgramData === undefined) {
        delete process.env.ProgramData;
      } else {
        process.env.ProgramData = originalProgramData;
      }
    }
  });

  it('leaves the token alone when ProgramData is unset, rather than guessing', () => {
    const originalProgramData = process.env.ProgramData;
    try {
      delete process.env.ProgramData;
      expect(resolveSshConfigHomePath('__PROGRAMDATA__\\ssh\\ssh_known_hosts', '/home/u')).toBe(
        '__PROGRAMDATA__\\ssh\\ssh_known_hosts',
      );
    } finally {
      if (originalProgramData !== undefined) {
        process.env.ProgramData = originalProgramData;
      }
    }
  });

  it('does not rewrite a filename that merely begins with the token', () => {
    expect(resolveSshConfigHomePath('__PROGRAMDATA__evil/x', '/home/u')).toBe(
      '__PROGRAMDATA__evil/x',
    );
  });
});
