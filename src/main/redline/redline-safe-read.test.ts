import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRegularFileCapped, readRegularFileCappedAsync } from './redline-safe-read';

describe('readRegularFileCapped', () => {
  it('acquires capped periodic file evidence asynchronously and preserves stamp semantics', async () => {
    writeFileSync(file(), '{"a":1}');
    const pending = readRegularFileCappedAsync(file(), 1024);
    expect(pending).toBeInstanceOf(Promise);
    const result = await pending;
    expect(result).toMatchObject({ kind: 'text', text: '{"a":1}' });
    if (result.kind === 'text') expect(await readRegularFileCappedAsync(file(), 1024, result.stamp)).toEqual({ kind: 'unchanged' });
    expect(await readRegularFileCappedAsync(file(), 2)).toMatchObject({ kind: 'none' });
  });
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'redline-safe-read-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const file = () => path.join(dir, 'f.json');

  it('strongStamp notices a same-size rewrite with a restored mtime (M1)', async () => {
    const pinned = new Date('2026-10-14T12:00:00Z');
    writeFileSync(file(), '{"a":1}');
    utimesSync(file(), pinned, pinned);
    const first = readRegularFileCapped(file(), 1024, undefined, { strongStamp: true });
    expect(first.kind).toBe('text');
    const stamp = first.kind === 'text' ? first.stamp : '';
    expect(readRegularFileCapped(file(), 1024, stamp, { strongStamp: true })).toEqual({ kind: 'unchanged' });
    writeFileSync(file(), '{"a":2}');
    utimesSync(file(), pinned, pinned);
    expect(readRegularFileCapped(file(), 1024, stamp, { strongStamp: true }))
      .toMatchObject({ kind: 'text', text: '{"a":2}' });
    expect(await readRegularFileCappedAsync(file(), 1024, stamp, { strongStamp: true }))
      .toMatchObject({ kind: 'text', text: '{"a":2}' });
  });

  it('a close failure after a complete async read does not reject (L2)', async () => {
    writeFileSync(file(), '{"a":1}');
    const realOpen = fsp.open.bind(fsp);
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        throw new Error('EIO on close');
      };
      return handle;
    });
    try {
      await expect(readRegularFileCappedAsync(file(), 1024)).resolves.toMatchObject({ kind: 'text', text: '{"a":1}' });
    } finally {
      spy.mockRestore();
    }
  });

  it('reads a regular file and returns a stamp', () => {
    writeFileSync(file(), '{"a":1}');
    const result = readRegularFileCapped(file(), 1024);
    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.text).toBe('{"a":1}');
      expect(result.stamp).toMatch(/^\d+(\.\d+)?:7$/);
    }
  });

  it('reads multi-byte UTF-8 intact', () => {
    writeFileSync(file(), '{"a":"ação 𝕏"}');
    const result = readRegularFileCapped(file(), 1024);
    expect(result.kind === 'text' && result.text).toBe('{"a":"ação 𝕏"}');
  });

  it('returns unchanged when the stamp matches, without reading', () => {
    writeFileSync(file(), 'abc');
    const first = readRegularFileCapped(file(), 1024);
    expect(first.kind).toBe('text');
    const stamp = first.kind === 'text' ? first.stamp : '';
    expect(readRegularFileCapped(file(), 1024, stamp)).toEqual({ kind: 'unchanged' });
  });

  it('notices a change of mtime or size', () => {
    writeFileSync(file(), 'abc');
    utimesSync(file(), 1_780_000_000, 1_780_000_000);
    const first = readRegularFileCapped(file(), 1024);
    const stamp = first.kind === 'text' ? first.stamp : '';
    utimesSync(file(), 1_780_000_100, 1_780_000_100);
    expect(readRegularFileCapped(file(), 1024, stamp).kind).toBe('text');
  });

  it('reports a missing file', () => {
    expect(readRegularFileCapped(file(), 1024)).toEqual({ kind: 'none', stamp: 'missing' });
  });

  it('refuses a file above the cap without reading it', () => {
    writeFileSync(file(), 'x'.repeat(2048));
    expect(readRegularFileCapped(file(), 1024)).toEqual({ kind: 'none', stamp: 'rejected:2048' });
  });

  it('accepts a file of exactly the cap', () => {
    writeFileSync(file(), 'x'.repeat(1024));
    expect(readRegularFileCapped(file(), 1024).kind).toBe('text');
  });

  it('refuses a directory', () => {
    mkdirSync(file());
    expect(readRegularFileCapped(file(), 1024).kind).toBe('none');
  });

  it.skipIf(process.platform === 'win32')('does not hang on a FIFO', () => {
    execFileSync('mkfifo', [file()]);
    expect(readRegularFileCapped(file(), 1024).kind).toBe('none');
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink to an endless device', () => {
    symlinkSync('/dev/zero', file());
    expect(readRegularFileCapped(file(), 1024).kind).toBe('none');
  });

  it('follows a symlink to a regular file (dotfile managers)', () => {
    const real = path.join(dir, 'real.json');
    writeFileSync(real, 'ok');
    symlinkSync(real, file());
    const result = readRegularFileCapped(file(), 1024);
    expect(result.kind === 'text' && result.text).toBe('ok');
  });

  it('refuses any symlink with noFollow (files Nexus writes itself)', () => {
    const real = path.join(dir, 'real.json');
    writeFileSync(real, 'ok');
    symlinkSync(real, file());
    expect(readRegularFileCapped(file(), 1024, undefined, { noFollow: true })).toEqual({
      kind: 'none',
      stamp: 'unreadable',
    });
    expect(readRegularFileCapped(real, 1024, undefined, { noFollow: true }).kind).toBe('text');
  });

  it('an empty file is text (the caller decides it is not valid)', () => {
    writeFileSync(file(), '');
    const result = readRegularFileCapped(file(), 1024);
    expect(result.kind === 'text' && result.text).toBe('');
  });
});
