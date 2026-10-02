import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * O `.toolbar__meta` empurra para fora do recorte (`max-height` + `row-gap`) o
 * chip que não cabe. Sem uma escora, a ALTURA do meta muda de 22px (uma linha)
 * para 28px (linha recortada existe) e a primeira linha sobe 3px sempre que um
 * chip quebra — medido num Chromium real: título/badge/RAM 3px mais altos só
 * porque o chip da conta não coube. A escora (`::before`, 0 de largura, altura
 * do meta) fixa a altura da primeira linha: o conteúdo fica no mesmo `y` com ou
 * sem quebra.
 */
const BASE_CSS = path.join(path.dirname(new URL(import.meta.url).pathname), 'base.css');

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`regra ${selector} não encontrada em base.css`);
  return match[1]!;
}

describe('.toolbar__meta — primeira linha com altura fixa', () => {
  const css = stripComments(fs.readFileSync(BASE_CSS, 'utf8'));
  const meta = ruleBody(css, '.toolbar__meta');
  const strut = ruleBody(css, '.toolbar__meta::before');

  it('o recorte e o espaçamento vêm de variáveis locais, não de números soltos', () => {
    expect(meta).toMatch(/--toolbar-meta-height:\s*28px/);
    expect(meta).toMatch(/--toolbar-meta-gap:\s*6px/);
    expect(meta).toMatch(/max-height:\s*var\(--toolbar-meta-height\)/);
    expect(meta).toMatch(/(^|[\s;])gap:\s*var\(--toolbar-meta-gap\)/);
  });

  it('a escora tem a altura do recorte e não ocupa largura nem espaçamento', () => {
    expect(strut).toMatch(/content:\s*''/);
    expect(strut).toMatch(/width:\s*0/);
    expect(strut).toMatch(/height:\s*var\(--toolbar-meta-height\)/);
    // O gap do flex também separa a escora do primeiro item: ela devolve esse espaço.
    expect(strut).toMatch(/margin-right:\s*calc\(-1\s*\*\s*var\(--toolbar-meta-gap\)\)/);
  });

  it('o chip que não cabe continua indo para uma linha fora do recorte', () => {
    expect(meta).toMatch(/flex-wrap:\s*wrap/);
    expect(meta).toMatch(/overflow:\s*hidden/);
    expect(meta).toMatch(/row-gap:\s*160px/);
  });
});
