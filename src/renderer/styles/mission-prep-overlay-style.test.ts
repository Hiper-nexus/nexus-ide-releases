import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contrato visual do overlay “preparando missão” (DESIGN.md §2/§4/§5): leitura
 * do CSS, na linha dos guards de rail/operador. O overlay é a única peça em
 * movimento da tela no momento do start — o motion dele não pode repintar
 * nada além de transform/opacity (flicker), todo keyframe precisa da guarda
 * de prefers-reduced-motion e cor é token, nunca hex.
 */

const css = fs
  .readFileSync(
    path.resolve(process.cwd(), 'src/renderer/styles/mission-prep-overlay.css'),
    'utf8',
  )
  .replace(/\r\n/g, '\n');

const stripComments = (value: string) => value.replace(/\/\*[\s\S]*?\*\//g, '');
const bare = stripComments(css);

describe('mission-prep-overlay: contrato visual', () => {
  it('não usa cor literal: só tokens e color-mix de tokens', () => {
    expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(bare).not.toMatch(/\brgba?\(|\bhsla?\(/);
  });

  it('z-index e camada vêm da ladder nomeada (overlay duro, abaixo do confirm)', () => {
    expect(bare).toContain('z-index: var(--z-hard-modal)');
    expect(bare).not.toMatch(/z-index:\s*\d/);
  });

  it('todo keyframe anima apenas transform e opacity (nada de repaint/flicker)', () => {
    const keyframes = [
      ...bare.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g),
    ];
    expect(keyframes.length).toBeGreaterThan(0);
    for (const [, name, body] of keyframes) {
      const properties = [...body.matchAll(/^\s*([a-z-]+)\s*:/gm)].map(
        (match) => match[1],
      );
      expect(properties.length, `keyframe ${name} não pode ser vazio`).toBeGreaterThan(0);
      for (const property of properties) {
        expect(
          property === 'transform' || property === 'opacity',
          `keyframe ${name} anima ${property}; só transform/opacity`,
        ).toBe(true);
      }
    }
  });

  it('toda animação própria desliga em prefers-reduced-motion', () => {
    const reduced = bare.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(reduced).not.toBeNull();
    for (const className of [
      '.mission-prep-overlay__message',
      '.mission-prep-overlay__cursor',
      '.mission-prep-overlay__runner',
    ]) {
      expect(reduced?.[1], `${className} precisa parar no reduced-motion`).toContain(
        className,
      );
      expect(reduced?.[1]).toMatch(/animation:\s*none/);
    }
  });

  it('scrim do overlay não é vidro (espera de duração desconhecida, §4)', () => {
    expect(bare).toContain('background: var(--overlay-scrim)');
    expect(bare).not.toMatch(/backdrop-filter/);
  });

  it('painel é card da casa: tokens de superfície, borda, raio e sombra', () => {
    const panel = bare.match(/\.mission-prep-overlay\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(panel).toContain('background: var(--bg-elevated)');
    expect(panel).toContain('border: 1px solid var(--border-strong)');
    expect(panel).toContain('border-radius: var(--radius-card)');
    expect(panel).toContain('box-shadow: var(--shadow-inset-hi), var(--shadow-2)');
  });
});
