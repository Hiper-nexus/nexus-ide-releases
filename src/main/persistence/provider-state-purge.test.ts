import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { purgeProviderStateForCheckout } from './provider-state-purge';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-provider-state-purge-'));
  tempDirs.push(dir);
  return dir;
}

function write(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

describe('purgeProviderStateForCheckout', () => {
  it('removes only the target checkout across every adapter, preserving the others', () => {
    const userData = tempRoot();
    write(
      path.join(userData, 'provider-state', 'grok', 'checkout-a', 'sessions', 'x.json'),
      'grok checkout a conversation',
    );
    write(
      path.join(userData, 'provider-state', 'grok', 'checkout-b', 'sessions', 'y.json'),
      'grok checkout b conversation',
    );
    write(
      path.join(userData, 'provider-state', 'kimi', 'checkout-a', 'sessions', 'z.json'),
      'kimi checkout a conversation',
    );

    const result = purgeProviderStateForCheckout(userData, 'checkout-a');

    expect([...result.removedAdapters].sort()).toEqual(['grok', 'kimi']);
    expect(result.failedAdapters).toEqual([]);
    expect(
      fs.existsSync(path.join(userData, 'provider-state', 'grok', 'checkout-a')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(userData, 'provider-state', 'kimi', 'checkout-a')),
    ).toBe(false);
    // Sibling checkouts and adapters are untouched.
    expect(
      fs.readFileSync(
        path.join(userData, 'provider-state', 'grok', 'checkout-b', 'sessions', 'y.json'),
        'utf8',
      ),
    ).toBe('grok checkout b conversation');
  });

  it('is a no-op when the checkout never existed for any adapter', () => {
    const userData = tempRoot();
    write(
      path.join(userData, 'provider-state', 'grok', 'checkout-a', 'sessions', 'x.json'),
      'grok checkout a conversation',
    );

    const result = purgeProviderStateForCheckout(userData, 'checkout-missing');

    expect(result.removedAdapters).toEqual([]);
    expect(result.failedAdapters).toEqual([]);
    expect(
      fs.existsSync(path.join(userData, 'provider-state', 'grok', 'checkout-a')),
    ).toBe(true);
  });

  it('is a no-op when provider-state was never created', () => {
    const userData = tempRoot();
    const result = purgeProviderStateForCheckout(userData, 'checkout-a');
    expect(result).toEqual({ removedAdapters: [], failedAdapters: [] });
  });

  it('rejects a checkoutId that is not a bare identifier (traversal guard)', () => {
    const userData = tempRoot();
    const outsideFile = path.join(userData, 'outside-marker.txt');
    write(outsideFile, 'must survive');
    write(
      path.join(userData, 'provider-state', 'grok', 'sentinel', 'sessions', 'x.json'),
      'must survive too',
    );

    for (const malicious of ['../outside-marker.txt', '..', 'a/../../b', '/etc']) {
      const result = purgeProviderStateForCheckout(userData, malicious);
      expect(result).toEqual({ removedAdapters: [], failedAdapters: [] });
    }

    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('must survive');
    expect(
      fs.existsSync(path.join(userData, 'provider-state', 'grok', 'sentinel')),
    ).toBe(true);
  });

  it('never follows a symlinked checkout directory', () => {
    const userData = tempRoot();
    const realSecret = path.join(userData, 'real-secret');
    write(path.join(realSecret, 'keep.txt'), 'must survive');
    const adapterDir = path.join(userData, 'provider-state', 'grok');
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.symlinkSync(realSecret, path.join(adapterDir, 'checkout-a'));

    const result = purgeProviderStateForCheckout(userData, 'checkout-a');

    expect(result.removedAdapters).toEqual([]);
    expect(result.failedAdapters).toEqual(['grok']);
    expect(fs.readFileSync(path.join(realSecret, 'keep.txt'), 'utf8')).toBe(
      'must survive',
    );
  });
});
