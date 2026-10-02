import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PixelIcon } from './PixelIcon';

describe('PixelIcon', () => {
  it('never renders below one screen pixel per grid cell (11px) — 9/10px dropped whole strokes', () => {
    for (const size of [8, 9, 10]) {
      const html = renderToStaticMarkup(<PixelIcon name="plus" size={size} />);
      expect(html).toContain('width="11"');
      expect(html).toContain('height="11"');
    }
  });

  it('keeps requested sizes from 11px up', () => {
    const html = renderToStaticMarkup(<PixelIcon name="plus" size={14} />);
    expect(html).toContain('width="14"');
  });

  it('draws a bug glyph (report entry point)', () => {
    const html = renderToStaticMarkup(<PixelIcon name="bug" size={12} />);
    expect(html).toContain('<rect');
  });
});
