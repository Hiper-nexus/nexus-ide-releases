import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) =>
  fs.readFileSync(path.join(DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`regra ${selector} não encontrada`);
  return match[1]!;
}

describe('Retomar missão — CTA da barra do pane (base.css)', () => {
  const css = read('base.css');

  it('usa só os tokens do CTA primário, sem hex', () => {
    const rule = ruleBody(css, '.toolbar__btn--resume,\n.toolbar__btn--resume:focus-visible');
    expect(rule).toMatch(/background:\s*var\(--btn-primary\)/);
    expect(rule).toMatch(/color:\s*var\(--btn-primary-ink\)/);
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(ruleBody(css, '.toolbar__btn--resume:hover')).toMatch(/var\(--btn-primary-hover\)/);
  });

  it('a opacidade de repouso mora nos grupos, e o grupo do Retomar fica de fora (100% sem foco)', () => {
    expect(ruleBody(css, '.toolbar__actions')).not.toMatch(/opacity/);
    expect(ruleBody(css, '.toolbar__actions > :not(.toolbar__group--resume)')).toMatch(/opacity:\s*0\.5/);
    expect(css).toMatch(/\.pane--focused \.toolbar__actions > \*\s*\{\s*opacity:\s*1/);
  });

  it('mantém o rótulo em densidade icons, respeita reduced-motion e rebaixa o Fechar', () => {
    expect(ruleBody(css, ".toolbar[data-density='icons'] .toolbar__btn--resume .toolbar__btn-label")).toMatch(/display:\s*inline/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.toolbar__btn--resume\s*\{\s*transition:\s*none/);
    expect(css).toMatch(/\.toolbar\[data-resume='true'\] \.toolbar__close:not\(:hover, :focus-visible\)\s*\{[^}]*var\(--border\)/);
  });
});

describe('Cortes do Quadro e do Inspetor (mission-board.css)', () => {
  const css = read('mission-board.css');

  it('o motivo de parada quebra linha em vez de levar reticências', () => {
    const rule = ruleBody(css, '.mission-board__reason strong');
    expect(rule).not.toMatch(/text-overflow/);
    expect(rule).not.toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/white-space:\s*normal/);
  });

  it('as abas do Inspetor quebram de linha e nunca encolhem abaixo do rótulo', () => {
    const tabs = ruleBody(css, '.mission-inspector__tabs');
    expect(tabs).toMatch(/flex-wrap:\s*wrap/);
    // `.mission-inspector__tab` aparece também numa lista de seletores: junta todas as regras.
    expect(css).toMatch(/@container mission-inspector-chrome \(max-width: 459px\)\s*\{\s*\.mission-inspector__tabs\s*\{[^}]*repeat\(3, minmax\(max-content, 1fr\)\)/);
    const tab = [...css.matchAll(/(?:^|\n)\.mission-inspector__tab\s*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    expect(tab).toMatch(/min-width:\s*max-content/);
    expect(tab).not.toMatch(/text-overflow/);
    expect(tab).not.toMatch(/overflow:\s*hidden/);
  });
});
