import { describe, expect, it } from 'vitest';
import { encodeQrMatrix, encodeQrSvg } from './index';

// The decode round-trip (opencv QR decoder) was validated externally against
// this vendored node-qrcode core for real LAN URLs. These tests lock the
// structural invariants a valid QR must hold, so a broken vendor drop is caught.
function isFinder(m: boolean[][], top: number, left: number): boolean {
  // 7x7 finder: dark border ring + 3x3 dark core, light ring between.
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      const dist = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      const expected = dist === 0 || dist === 1 || dist === 3;
      if (m[top + r][left + c] !== expected) return false;
    }
  }
  return true;
}

describe('vendored qrcode', () => {
  it('encodes a LAN URL into a square matrix with the 3 finder patterns', () => {
    const m = encodeQrMatrix('https://192.168.1.42:53211/#code=ABC123');
    const size = m.length;
    expect(size).toBeGreaterThanOrEqual(21);
    expect(m.every((row) => row.length === size)).toBe(true);
    expect(isFinder(m, 0, 0)).toBe(true); // top-left
    expect(isFinder(m, 0, size - 7)).toBe(true); // top-right
    expect(isFinder(m, size - 7, 0)).toBe(true); // bottom-left
  });

  it('grows the version for longer payloads', () => {
    const small = encodeQrMatrix('hi').length;
    const big = encodeQrMatrix('x'.repeat(200)).length;
    expect(big).toBeGreaterThan(small);
  });

  it('renders a self-contained SVG string', () => {
    const svg = encodeQrSvg('nexus-pair-7Q2X');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox=');
    expect(svg).toContain('<path');
    // Self-contained: no fetchable external refs (the only http is the SVG
    // namespace URI, which is never dereferenced).
    expect(svg).not.toContain('href=');
    expect(svg).not.toContain('<image');
  });

  it('SVG width option is honored', () => {
    expect(encodeQrSvg('x', { width: 256 })).toContain('width="256"');
  });
});
