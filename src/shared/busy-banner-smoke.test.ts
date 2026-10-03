import { describe, expect, it } from 'vitest';
import { parseBusyBannerSmokeResult } from './busy-banner-smoke';

const nonce = '11111111-1111-4111-8111-111111111111';
const result = {
  nonce, armedAt: 100, shownAt: 11_000, visibleAt: 11_016, clearedAt: 40_200,
  title: 'Nexus ocupado — capturando diagnóstico',
  rect: { x: 30, y: 8, width: 480, height: 28, viewportWidth: 1000, viewportHeight: 700 },
};

describe('busy banner smoke evidence', () => {
  it('accepts bounded evidence of two visible frames followed by clearing', () => {
    expect(parseBusyBannerSmokeResult(result)).toEqual(result);
  });

  it.each([
    { nonce: 'wrong' }, { visibleAt: 10_999 }, { clearedAt: 11_016 },
    { title: 'other status' }, { token: 'private' },
    { rect: { ...result.rect, x: -1 } },
    { rect: { ...result.rect, width: 0 } },
    { rect: { ...result.rect, x: 900 } },
    { rect: { ...result.rect, height: Number.NaN } },
  ])('rejects malformed or non-visible evidence %j', patch => {
    expect(parseBusyBannerSmokeResult({ ...result, ...patch })).toBeNull();
  });
});
