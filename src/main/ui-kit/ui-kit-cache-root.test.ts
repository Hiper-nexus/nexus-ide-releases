// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveUiKitCacheDir } from './ui-kit-cache';

/**
 * The test that was missing, and whose absence let the whole feature ship dead.
 *
 * Every cache test injected `rootDir`, so nothing exercised the path a packaged
 * app takes: `setUiKitCacheRootResolver` was called from a TEST and from
 * nowhere else, so in the app every cache read threw `NO_CACHE_ROOT` — the
 * panel reported "no project open" and the catalog tools rejected outright.
 *
 * A unit test cannot resolve Electron's userData, so the guard is static: the
 * boot MUST wire the resolver next to the handlers. That is exactly the fact
 * no behavioural test could see.
 */
describe('the cache root is wired at boot', () => {
  const mainSource = fs.readFileSync(
    path.join(__dirname, '..', 'main.ts'),
    'utf8',
  );

  it('main.ts sets the resolver from the app userData', () => {
    expect(mainSource).toContain('setUiKitCacheRootResolver');
    expect(mainSource).toMatch(
      /setUiKitCacheRootResolver\(\(\) => app\.getPath\('userData'\)\)/,
    );
  });

  it('wires it in the same boot step that registers the handlers', () => {
    // Registering the IPC without the root is the broken state that shipped.
    const step = mainSource.slice(
      mainSource.indexOf("bootStep('registerUiKitIpc'"),
      mainSource.indexOf("bootStep('registerUiKitIpc'") + 400,
    );
    expect(step).toContain('setUiKitCacheRootResolver');
    expect(step).toContain('registerUiKitIpc()');
    expect(step.indexOf('setUiKitCacheRootResolver')).toBeLessThan(
      step.indexOf('registerUiKitIpc()'),
    );
  });

  it('still refuses to guess a root when nothing configured one', () => {
    // Outside Electron there is no userData to fall back to, and inventing a
    // directory would scatter cache files somewhere nobody looks.
    expect(() => resolveUiKitCacheDir('shadcn')).toThrow(/cache root is not configured/);
  });

  it('prefers an explicitly injected root', () => {
    expect(resolveUiKitCacheDir('shadcn', { rootDir: '/given' })).toBe(
      path.normalize('/given/ui-kit/shadcn'),
    );
  });
});
