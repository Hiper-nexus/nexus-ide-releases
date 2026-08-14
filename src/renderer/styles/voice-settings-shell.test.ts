import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/styles/voice-settings.css'),
  'utf8',
);

describe('Jarvis voice settings modal shell', () => {
  it('hosts the dialog as a fixed fullscreen overlay', () => {
    const shell = css.slice(
      css.indexOf('.agent-picker {'),
      css.indexOf('.agent-picker__overlay'),
    );
    expect(shell).toMatch(/position:\s*fixed;/);
    expect(shell).toMatch(/inset:\s*0;/);
    expect(shell).toMatch(/z-index:\s*var\(--z-hard-modal\);/);
  });
});
