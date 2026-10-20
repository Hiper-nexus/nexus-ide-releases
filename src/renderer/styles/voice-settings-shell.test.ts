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

describe('Jarvis voice settings — nav do painel estreito', () => {
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('item da nav não encolhe na coluna de altura limitada (o texto vazava no vizinho)', () => {
    expect(rule('.voice-settings__nav-item')).toMatch(/flex:\s*0 0 auto;/u);
    expect(rule('.voice-settings__nav')).toMatch(/overflow-y:\s*auto;/u);
  });

  it('o painel mede a própria largura: embutido e modal são container de inline-size', () => {
    expect(css).toMatch(
      /\.voice-settings--embedded \.voice-settings__container,\s*\.agent-picker__panel--voice\s*\{\s*container:\s*voice-settings \/ inline-size;/u,
    );
  });

  it('estreito, a nav vira faixa de abas acima do conteúdo e esconde o subtítulo', () => {
    const at = css.indexOf('@container voice-settings (max-width: 600px)');
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf('/* ── Responsive', at));
    expect(block).toMatch(/\.voice-settings__shell\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/u);
    expect(block).toMatch(/\.voice-settings__nav\s*\{[^}]*flex-direction:\s*row;/u);
    expect(block).toMatch(
      /\.voice-settings__nav-item > span:not\(\.voice-settings__nav-icon\)\s*\{\s*display:\s*none;/u,
    );
  });
});
