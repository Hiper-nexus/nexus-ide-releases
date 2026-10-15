import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contrato visual do rail (DESIGN.md §2, §4, §6, §11, §13): lista plana e
 * densa — tokens em vez de hex, sem caixa-alta de eyebrow, sem faixa lateral de
 * acento, e movimento só para o estado VIVO (o pulso em opacity, com a guarda
 * de reduced-motion que a ProductStyleContracts confere). É uma leitura do CSS,
 * não render: o navegador de verdade confere o resto.
 */

const stylesDir = path.resolve(process.cwd(), 'src/renderer/styles');
const read = (file: string) =>
  fs.readFileSync(path.join(stylesDir, file), 'utf8').replace(/\r\n/g, '\n');

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selector: string;
  body: string;
}

/** Regras mais internas (`seletor { declarações }`), inclusive dentro de @media. */
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selector: match[1].trim(), body: match[2] });
  }
  return rules;
}

const appShellCss = read('app-shell.css');
const railRules = rulesOf(appShellCss).filter((rule) =>
  /\.workspace-(rail|cleanup)/.test(rule.selector),
);
/** Toda regra que declara este seletor, inclusive quando ele divide a regra com outros (vírgula). */
const rulesFor = (selector: string) =>
  railRules.filter((candidate) =>
    candidate.selector.split(',').some((part) => part.trim() === selector),
  );
const rule = (selector: string) => rulesFor(selector)[0];

describe('rail: contrato visual da lista plana', () => {
  it('encontra as regras do rail (o guard não está lendo o vazio)', () => {
    expect(railRules.length).toBeGreaterThan(150);
    expect(rule('.workspace-rail__mission')).toBeDefined();
    expect(rule('.workspace-rail__group-toggle')).toBeDefined();
    expect(rule('.workspace-cleanup')).toBeDefined();
  });

  it('não usa cor literal: só tokens e color-mix de tokens (nem em fallback de var)', () => {
    const offenders = railRules
      .filter((candidate) =>
        /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(candidate.body),
      )
      .map((candidate) => candidate.selector);
    expect(offenders).toEqual([]);
  });

  it('só usa variáveis CSS que existem em base.css ou no próprio shell', () => {
    const declared = new Set(
      [...`${read('base.css')}\n${appShellCss}`.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(
        (match) => match[1],
      ),
    );
    const missing = new Set<string>();
    for (const candidate of railRules) {
      for (const use of candidate.body.matchAll(/var\((--[a-z0-9-]+)\s*[,)]/g)) {
        if (!declared.has(use[1])) missing.add(use[1]);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('nenhum texto do rail é eyebrow em caixa-alta', () => {
    const offenders = railRules
      .filter((candidate) => /text-transform\s*:\s*uppercase/.test(candidate.body))
      .map((candidate) => candidate.selector);
    expect(offenders).toEqual([]);
  });

  it('sem faixa lateral de acento: seleção e "atual" são fundo e texto, não listra', () => {
    const offenders = railRules
      // `.workspace-rail` é a divisória do shell com o palco, não uma marca de item.
      .filter((candidate) => candidate.selector !== '.workspace-rail')
      .filter(
        (candidate) =>
          /box-shadow\s*:[^;]*inset\s+-?\d+px\s+0\s+0\b/.test(candidate.body) ||
          /border-(left|right)\s*:/.test(candidate.body),
      )
      .map((candidate) => candidate.selector);
    expect(offenders).toEqual([]);
  });

  it('só os pulsos de "ao vivo" repetem para sempre, e só em opacity (state-breathe)', () => {
    const sanctioned = new Set([
      '.workspace-rail__live-dot',
      '.workspace-rail__agent-dot--working',
      '.workspace-rail__agent-dot--starting',
      '.workspace-rail__mission--running .workspace-rail__mission-indicator',
    ]);
    const looping = railRules.filter((candidate) =>
      /animation[^;]*\binfinite\b/.test(candidate.body),
    );
    expect(looping.map((candidate) => candidate.selector).sort()).toEqual(
      [...sanctioned].sort(),
    );
    for (const candidate of looping) {
      expect(candidate.body, candidate.selector).toContain('state-breathe');
    }
  });

  it('o ponto de cabeçalho e de resumo é marcador parado: o pulso mora nas folhas', () => {
    for (const selector of [
      '.workspace-rail__workspace-live .workspace-rail__live-dot',
      '.workspace-rail__agents-live .workspace-rail__live-dot',
    ]) {
      expect(rule(selector)?.body, selector).toMatch(/animation:\s*none/);
    }
  });

  it('a missão é uma linha só: o título corta com reticências e a palavra do estado desce', () => {
    const label = rule('.workspace-rail__row-label')?.body ?? '';
    expect(label).toMatch(/white-space:\s*nowrap/);
    expect(label).toMatch(/text-overflow:\s*ellipsis/);
    // O título da missão não volta a quebrar em duas linhas.
    const missionLabel = rule('.workspace-rail__mission .workspace-rail__row-label')?.body ?? '';
    expect(missionLabel).not.toMatch(/line-clamp|white-space:\s*normal/);
    // Glifo | título | idade; a palavra do estado ocupa a segunda linha.
    expect(rule('.workspace-rail__mission')?.body).toMatch(/display:\s*grid/);
    expect(rule('.workspace-rail__mission-status')?.body).toMatch(/grid-column:\s*2\s*\/\s*-1/);
  });

  it('ações de linha só aparecem no hover ou no foco, sem mover o rótulo', () => {
    for (const selector of [
      '.workspace-rail__workspace-action',
      '.workspace-rail__mission-remove',
    ]) {
      expect(rule(selector)?.body, selector).toMatch(/opacity:\s*0/);
      expect(rule(selector)?.body, selector).toMatch(/position:\s*absolute/);
      // Ação destrutiva invisível não intercepta o clique da linha em repouso.
      expect(rule(selector)?.body, selector).toMatch(/pointer-events:\s*none/);
    }
    expect(
      rule('.workspace-rail__mission-row:hover .workspace-rail__mission-remove')?.body,
    ).toMatch(/pointer-events:\s*auto/);
    // Recolher o projeto aparece no hover — e fica à vista com a contagem quando recolhido.
    expect(rule('.workspace-rail__workspace-toggle')?.body).toMatch(/opacity:\s*0/);
    expect(rule('.workspace-rail__workspace-toggle--collapsed')?.body ?? '').not.toMatch(
      /opacity:\s*0/,
    );
  });

  it('os destinos são uma coluna só (sem grade de duas colunas)', () => {
    const fixed = rulesFor('.workspace-rail__fixed')
      .map((candidate) => candidate.body)
      .join('\n');
    expect(fixed).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(fixed).not.toMatch(/repeat\(2/);
    expect(rule('.workspace-rail__fixed-item--wide')).toBeUndefined();
  });

  it('a seleção usa o toque de acento só no fundo, sem borda', () => {
    const selected = rule('.workspace-rail__row--selected')?.body ?? '';
    expect(selected).toMatch(/background:\s*color-mix\(in srgb, var\(--accent\)/);
    expect(selected).not.toMatch(/\bborder\b/);
  });
});
