import { describe, expect, it } from 'vitest';
import { shouldResetDesignForUrlChange } from './browser-manager';

/**
 * Pure predicate behind the SPA-navigation design reset: pushState routing
 * (did-navigate-in-page) must drop annotations/badges/session exactly like a
 * real navigation, while hash-only hops keep them (same rendered document).
 */
describe('shouldResetDesignForUrlChange', () => {
  it('resets on path changes (SPA pushState routing)', () => {
    expect(
      shouldResetDesignForUrlChange(
        'http://localhost:5173/checkout',
        'http://localhost:5173/home',
      ),
    ).toBe(true);
  });

  it('resets on query-string changes (route state)', () => {
    expect(
      shouldResetDesignForUrlChange(
        'http://localhost:5173/list?page=1',
        'http://localhost:5173/list?page=2',
      ),
    ).toBe(true);
  });

  it('resets on origin changes', () => {
    expect(
      shouldResetDesignForUrlChange(
        'http://localhost:5173/app',
        'http://localhost:5199/app',
      ),
    ).toBe(true);
  });

  it('keeps design state on hash-only hops (same rendered document)', () => {
    expect(
      shouldResetDesignForUrlChange(
        'http://localhost:5173/docs#intro',
        'http://localhost:5173/docs#api',
      ),
    ).toBe(false);
    expect(
      shouldResetDesignForUrlChange(
        'http://localhost:5173/docs',
        'http://localhost:5173/docs#anchor',
      ),
    ).toBe(false);
  });

  it('falls back to plain inequality for unparseable URLs', () => {
    expect(shouldResetDesignForUrlChange('', 'about:blank')).toBe(true);
    expect(shouldResetDesignForUrlChange('not a url', 'not a url')).toBe(false);
  });
});
