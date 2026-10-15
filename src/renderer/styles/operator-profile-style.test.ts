import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contrato visual do Perfil de Operador e do HUD (DESIGN.md §2, §4, §5):
 * tokens em vez de hex, motion só com guarda de reduced-motion e só para
 * estado, sem eyebrow em caixa-alta. É uma leitura do CSS, não render: o
 * navegador de verdade confere o resto.
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

const costOperatorCss = read('cost-operator.css');
const ownRules = rulesOf(costOperatorCss).filter((rule) =>
  /\.operator-(profile|hud)/.test(rule.selector),
);

describe('Perfil de Operador e HUD: contrato visual', () => {
  it('encontra as regras do perfil e do HUD (o guard não está lendo o vazio)', () => {
    expect(ownRules.length).toBeGreaterThan(60);
    expect(ownRules.some((rule) => rule.selector === '.operator-profile')).toBe(true);
    expect(ownRules.some((rule) => rule.selector === '.operator-hud.operator-hud--rail')).toBe(true);
  });

  it('não usa cor literal: só tokens e color-mix de tokens', () => {
    const offenders = ownRules
      .filter((rule) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(rule.body))
      .map((rule) => rule.selector);
    expect(offenders).toEqual([]);
  });

  it('só usa variáveis CSS que existem em base.css', () => {
    const declared = new Set(
      [...read('base.css').matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
    );
    const missing = new Set<string>();
    for (const rule of ownRules) {
      for (const use of rule.body.matchAll(/var\((--[a-z0-9-]+)\s*[,)]/g)) {
        if (!declared.has(use[1])) missing.add(use[1]);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('não tem animação em loop nem decoração do tipo grade, varredura ou faixa colorida', () => {
    const looping = ownRules
      .filter((rule) => /animation[^;]*\binfinite\b/.test(rule.body))
      .map((rule) => rule.selector);
    expect(looping).toEqual([]);

    const css = stripComments(costOperatorCss);
    for (const gone of [
      'operator-profile-drift',
      'operator-profile-scan',
      'operator-hud-shimmer',
      'operator-hud-sweep',
    ]) {
      expect(css, `${gone} voltou`).not.toContain(gone);
    }
    // A faixa tricolor (acento + ok + warn) vivia num ::before do diálogo.
    expect(
      ownRules.filter((rule) => /^\.operator-profile::(before|after)/.test(rule.selector)),
    ).toEqual([]);
  });

  it('títulos de seção são frase em 13px, nunca eyebrow em caixa-alta', () => {
    const headings = ownRules.filter((rule) => /\.operator-profile__section[^,]*h3/.test(rule.selector));
    expect(headings.length).toBeGreaterThan(0);
    for (const rule of headings) {
      expect(rule.body).not.toMatch(/text-transform\s*:\s*uppercase/);
    }
    const sectionTitle = headings.find((rule) => rule.selector === '.operator-profile__section h3');
    expect(sectionTitle?.body).toContain('var(--text-md)');
  });

  it('a entrada do diálogo respeita prefers-reduced-motion', () => {
    const css = stripComments(costOperatorCss);
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
      .map((m) => m[1])
      .join('\n');
    expect(css).toContain('@keyframes operator-profile-in');
    expect(reduced).toMatch(/\.operator-profile \{\s*animation: none;/);
    expect(reduced).toMatch(/\.operator-hud__bar-fill/);
    expect(reduced).toMatch(/\.operator-profile__bar-fill/);
  });

  it('o texto de apoio mantém contraste: nada de opacidade em conquistas travadas', () => {
    const locked = ownRules.filter((rule) => rule.selector.includes('--locked'));
    for (const rule of locked) {
      expect(rule.body).not.toMatch(/\bopacity\s*:/);
    }
  });
});

describe('rail: faixa própria para a entrada do perfil', () => {
  const rail = rulesOf(read('app-shell.css'));
  const rule = (selector: string) => rail.find((r) => r.selector === selector);

  it('o rodapé reserva três faixas: utilidades, perfil e Configurações', () => {
    expect(rule('.workspace-rail__footer')?.body).toMatch(
      /grid-template-rows:\s*minmax\(0, 1fr\) auto auto;/,
    );
    expect(rule('.workspace-rail__footer > .operator-hud--rail')?.body).toMatch(
      /grid-row:\s*2;/,
    );
    expect(rule('.workspace-rail__cockpit-status')?.body).toMatch(/grid-row:\s*3;/);
  });

  it('as utilidades continuam na primeira faixa, a única que cede altura', () => {
    expect(rule('.workspace-rail__utilities')?.body).toMatch(/grid-row:\s*1;/);
  });
});
