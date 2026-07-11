import { describe, expect, it } from 'vitest';
import { normalizeSshRemotePath, resolveSshPathInsideRoot } from './ssh-path';

describe('ssh-path', () => {
  it('normalizes and blocks escape from root', () => {
    expect(normalizeSshRemotePath('/a/b/../c')).toBe('/a/c');
    expect(resolveSshPathInsideRoot('/proj', 'src/x.ts')).toBe('/proj/src/x.ts');
    expect(resolveSshPathInsideRoot('/proj', '../etc/passwd')).toBeNull();
  });

  it('treats filesystem root / as containing all absolute children', () => {
    expect(resolveSshPathInsideRoot('/', 'a')).toBe('/a');
    expect(resolveSshPathInsideRoot('/', '/etc')).toBe('/etc');
    expect(resolveSshPathInsideRoot('/', '/a/b/../c')).toBe('/a/c');
    // still normalize away traversal past root
    expect(resolveSshPathInsideRoot('/', '../../etc/passwd')).toBe('/etc/passwd');
  });
});
