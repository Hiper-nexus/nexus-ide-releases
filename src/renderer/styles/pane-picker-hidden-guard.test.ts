import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * O atributo `hidden` do HTML é `display: none` por uma regra do NAVEGADOR, de
 * especificidade mínima. Qualquer `.classe { display: … }` a vence em silêncio:
 * o elemento continua na tela, e nenhum teste de DOM percebe, porque o atributo
 * ESTÁ lá. Foi assim que o cabeçalho de busca do "+ Pane" ficou visível durante
 * o passo de confirmação na 0.76.362, enquanto a lista ao lado — que não declara
 * `display` — escondia direito.
 *
 * Esta guarda cobre as duas pontas: quem o JSX esconde por `hidden` e quem o CSS
 * dá `display` próprio.
 */
const css = readFileSync(
  join(__dirname, 'pane-picker.css'),
  'utf8',
);
const tsx = readFileSync(
  join(__dirname, '..', 'components', 'PanePicker.tsx'),
  'utf8',
);

/** `.foo { … display: x … }` → true quando a classe declara display próprio. */
function declaresDisplay(klass: string): boolean {
  const block = new RegExp(`\\.${klass}\\s*\\{([^}]*)\\}`).exec(css);
  return block ? /(^|[;\s])display\s*:/.test(block[1]) : false;
}

function hasHiddenOverride(klass: string): boolean {
  return new RegExp(`\\.${klass}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`).test(css);
}

describe('pane-picker: hidden vs. display próprio', () => {
  it('toda classe escondida por hidden no JSX e com display próprio tem o override', () => {
    // Classes que o PanePicker esconde via `hidden={…}`.
    const hiddenInJsx = [...tsx.matchAll(/hidden=\{[^}]*\}[\s\S]{0,200}?className="([a-z-]+)"/g)]
      .map((m) => m[1]);
    // O cabeçalho é o caso conhecido; a lista entra pelo className literal.
    const candidates = new Set([...hiddenInJsx, 'pane-picker__head', 'pane-picker__list']);
    for (const klass of candidates) {
      if (declaresDisplay(klass)) {
        expect(
          hasHiddenOverride(klass),
          `.${klass} declara display próprio e é escondida por hidden: ` +
            `falta \`.${klass}[hidden] { display: none; }\``,
        ).toBe(true);
      }
    }
  });

  it('o cabeçalho de busca é o caso que falhou em produção', () => {
    expect(declaresDisplay('pane-picker__head')).toBe(true);
    expect(hasHiddenOverride('pane-picker__head')).toBe(true);
  });
});
