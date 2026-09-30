import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(
  path.join(__dirname, '../styles/voice-hud.css'),
  'utf8',
);

function rule(selector: string): string {
  const exact = `\n${selector}`;
  const exactStart = css.lastIndexOf(exact);
  const start = exactStart >= 0 ? exactStart + 1 : css.indexOf(selector);
  if (start < 0) return '';
  const end = css.indexOf('}', start);
  return css.slice(start, end + 1);
}

describe('Jarvis HUD idle motion budget', () => {
  it('keeps the idle orb, rings, and core static', () => {
    expect(rule('.voice-orb {')).toContain('animation: none');
    expect(rule('.voice-orb__ring--outer {')).toContain('animation: none');
    expect(rule('.voice-orb__ring--middle {')).toContain('animation: none');
    expect(rule('.voice-orb__ring--inner {')).toContain('animation: none');
    expect(rule('.voice-orb__core {')).toContain('animation: none');
  });

  it('turns motion back on only for active voice phases', () => {
    expect(css).toContain('.voice-hud--listening .voice-orb');
    expect(css).toContain('.voice-hud--speaking .voice-orb');
    expect(css).toContain('animation: voice-orb-breathe');
    expect(css).toContain('animation: voice-orb-spin');
  });
});
