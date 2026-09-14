import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withPublicationLock } from './release-publication-lock.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { force: true, recursive: true })));
const location = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-publish-lock-test-')); roots.push(root); return path.join(root, 'publisher.lock'); };
describe('publication session serialization', () => {
  it('rejects a parallel publisher while the first session holds the lock', async () => {
    const lockPath = location();
    let finish;
    let entered = false;
    const first = withPublicationLock(() => new Promise(resolve => { finish = resolve; }), { lockPath });
    await expect(withPublicationLock(async () => { entered = true; }, { lockPath })).rejects.toThrow(/another publication|lock/i);
    expect(entered).toBe(false);
    finish('first');
    expect(await first).toBe('first');
    expect(await withPublicationLock(async () => 'next', { lockPath })).toBe('next');
  });
  it('cleans up after failure but never steals a preexisting abandoned lock', async () => {
    const lockPath = location();
    await expect(withPublicationLock(async () => { throw new Error('failed gate'); }, { lockPath })).rejects.toThrow('failed gate');
    expect(fs.existsSync(lockPath)).toBe(false);
    fs.mkdirSync(lockPath);
    await expect(withPublicationLock(async () => {}, { lockPath })).rejects.toThrow(/lock/i);
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});
