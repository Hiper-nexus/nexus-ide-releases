import { describe, expect, it } from 'vitest';
import {
  acquireWakeLock,
  releaseWakeLock,
  wakeLockHolder,
  type WakeLockDeps,
} from './wake-lock';

function fakeDeps(opts: {
  ownPid: number;
  files?: Record<string, string>;
  alivePids?: number[];
}): WakeLockDeps & { files: Record<string, string> } {
  const files = { ...(opts.files ?? {}) };
  const alive = new Set(opts.alivePids ?? [opts.ownPid]);
  return {
    files,
    lockFile: '/fake/jarvis-wake.lock',
    readFile: (f) => {
      if (!(f in files)) throw new Error('ENOENT');
      return files[f];
    },
    writeFile: (f, data) => {
      files[f] = data;
    },
    removeFile: (f) => {
      delete files[f];
    },
    fileExists: (f) => f in files,
    isPidAlive: (pid) => alive.has(pid),
    ownPid: () => opts.ownPid,
  };
}

describe('wake-lock', () => {
  it('adquire o lock quando o arquivo não existe', () => {
    const deps = fakeDeps({ ownPid: 100 });
    expect(acquireWakeLock(deps)).toBe(true);
    expect(deps.files['/fake/jarvis-wake.lock']).toBe('100');
  });

  it('é idempotente quando o lock já é nosso', () => {
    const deps = fakeDeps({
      ownPid: 100,
      files: { '/fake/jarvis-wake.lock': '100' },
    });
    expect(acquireWakeLock(deps)).toBe(true);
  });

  it('recusa quando outra instância VIVA detém o lock', () => {
    const deps = fakeDeps({
      ownPid: 100,
      files: { '/fake/jarvis-wake.lock': '200' },
      alivePids: [100, 200],
    });
    expect(acquireWakeLock(deps)).toBe(false);
    expect(wakeLockHolder(deps)).toBe(200);
  });

  it('rouba o lock de um PID morto (lock órfão)', () => {
    const deps = fakeDeps({
      ownPid: 100,
      files: { '/fake/jarvis-wake.lock': '200' },
      alivePids: [100],
    });
    expect(acquireWakeLock(deps)).toBe(true);
    expect(deps.files['/fake/jarvis-wake.lock']).toBe('100');
  });

  it('trata lockfile corrompido como livre', () => {
    const deps = fakeDeps({
      ownPid: 100,
      files: { '/fake/jarvis-wake.lock': 'garbage' },
    });
    expect(acquireWakeLock(deps)).toBe(true);
  });

  it('release só apaga o lock quando é nosso', () => {
    const ours = fakeDeps({
      ownPid: 100,
      files: { '/fake/jarvis-wake.lock': '100' },
    });
    releaseWakeLock(ours);
    expect(ours.files['/fake/jarvis-wake.lock']).toBeUndefined();

    const theirs = fakeDeps({
      ownPid: 100,
      files: { '/fake/jarvis-wake.lock': '200' },
      alivePids: [100, 200],
    });
    releaseWakeLock(theirs);
    expect(theirs.files['/fake/jarvis-wake.lock']).toBe('200');
  });

  it('holder é null quando o lock é nosso ou o dono morreu', () => {
    const ours = fakeDeps({
      ownPid: 100,
      files: { '/fake/jarvis-wake.lock': '100' },
    });
    expect(wakeLockHolder(ours)).toBeNull();

    const dead = fakeDeps({
      ownPid: 100,
      files: { '/fake/jarvis-wake.lock': '200' },
      alivePids: [100],
    });
    expect(wakeLockHolder(dead)).toBeNull();
  });
});
