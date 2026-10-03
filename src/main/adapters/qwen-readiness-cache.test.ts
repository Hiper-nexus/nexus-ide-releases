import { describe, expect, it, vi } from 'vitest';
import { QwenReadinessCache } from './qwen-readiness-cache';
import type { QwenProbeOptions, QwenReadinessResult } from './qwen-readiness';

describe('credential-bound Qwen readiness cache', () => {
  it('keeps an invalid verdict during an outage for the same credential and clears it on rotation', async () => {
    let result: QwenReadinessResult = { state: 'invalid-credential' };
    const probe = vi.fn(async (options: QwenProbeOptions = {}) => {
      options.onIdentity?.(options.key === 'new-key' ? 'new-identity' : 'old-identity');
      return result;
    });
    const cache = new QwenReadinessCache(probe, false);
    await cache.request({ key: 'old-key' });
    expect(cache.snapshot().state).toBe('invalid-credential');
    result = { state: 'unknown' };
    await cache.request({ key: 'old-key', force: true });
    expect(cache.snapshot().state).toBe('invalid-credential');
    await cache.request({ key: 'new-key' });
    expect(cache.snapshot().state).toBe('unknown');
    result = { state: 'present' };
    await cache.request({ key: 'new-key', force: true });
    expect(cache.snapshot().state).toBe('present');
    expect(JSON.stringify(cache)).not.toContain('new-key');
    await cache.stop();
  });
  it('invalidates a stale in-flight rejection and physically drains it on shutdown', async () => {
    let resolve!: (value: QwenReadinessResult) => void;
    const cache = new QwenReadinessCache(async () => new Promise<QwenReadinessResult>(yes => { resolve = yes; }), false);
    const pending = cache.request({ key: 'old-key' });
    cache.invalidate();
    let stopped = false;
    const stop = cache.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolve({ state: 'invalid-credential' });
    await pending; await stop;
    expect(cache.snapshot().state).toBe('unknown');
  });
});
