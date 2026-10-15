import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, hexToSrgb, srgbToHex } from './palette-gen';
import { PALETTES, type UiPalette } from './ui-theme';

/**
 * Contrato visual do rail (DESIGN.md §2, §4, §6, §11, §13): lista plana e
 * densa — tokens em vez de hex, sem caixa-alta de eyebrow, sem faixa lateral de
 * acento, movimento só para o estado VIVO (o pulso em opacity, com a guarda
 * de reduced-motion que a ProductStyleContracts confere), alvos de pelo menos
 * 32px e texto de hierarquia com AA sobre a superfície que o rail pinta. É uma
 * leitura do CSS e das paletas, não render: o navegador de verdade confere o
 * resto.
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

  it('o recolher do projeto invisível em repouso não intercepta o clique da linha', () => {
    expect(rule('.workspace-rail__workspace-toggle')?.body).toMatch(/pointer-events:\s*none/);
    // Quem fica à vista (hover, foco, recolhido com a contagem) recebe o clique.
    for (const selector of [
      '.workspace-rail__workspace-row-wrapper:hover .workspace-rail__workspace-toggle',
      '.workspace-rail__workspace-row-wrapper:focus-within .workspace-rail__workspace-toggle',
      '.workspace-rail__workspace-toggle--collapsed',
    ]) {
      expect(rule(selector)?.body, selector).toMatch(/opacity:\s*1/);
      expect(rule(selector)?.body, selector).toMatch(/pointer-events:\s*auto/);
    }
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

const spacePx = new Map(
  [
    ...(rulesOf(read('base.css')).find((candidate) => candidate.selector === ':root')?.body ?? '')
      .matchAll(/(--space-[\w-]+)\s*:\s*(\d+(?:\.\d+)?)px/g),
  ].map((match) => [match[1], Number(match[2])] as const),
);

/** `Npx`, tokens de espaço (`--space-*`) e `calc(a ± b)` entre eles, em px; NaN quando não resolve. */
function lengthPx(value: string): number {
  const resolved = value
    .replace(/var\((--space-[\w-]+)\)/g, (_all, token: string) => `${spacePx.get(token) ?? 'NaN'}px`)
    .replace(/^\s*calc\(([\s\S]*)\)\s*$/, '$1');
  const term = /([+-]?)\s*(\d+(?:\.\d+)?)px/g;
  const total = [...resolved.matchAll(term)].reduce(
    (sum, match) => sum + (match[1] === '-' ? -1 : 1) * Number(match[2]),
    0,
  );
  return resolved.replace(term, '').trim() === '' ? total : Number.NaN;
}

/** Cada valor (px) de `property` declarado para `selector` nas regras dadas. */
const sizesOf = (rules: Rule[], selector: string, property: string) =>
  rules
    .filter((candidate) => candidate.selector.split(',').some((part) => part.trim() === selector))
    .flatMap((candidate) => {
      const declared = candidate.body.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+);`));
      return declared ? [lengthPx(declared[1])] : [];
    });

describe('rail: alvos de toque (DESIGN.md §13: 32px no desktop, maior no toque)', () => {
  const DESKTOP_FLOOR = 32;
  const TOUCH_FLOOR = 44;
  /** Controle do rail → declarações que lhe dão o alvo (linha: altura mínima; ícone: os dois eixos). */
  const TARGETS: Record<string, string[]> = {
    '.workspace-rail__search-btn': ['min-height'],
    '.workspace-rail__mission-cta': ['min-height'],
    '.workspace-rail__row': ['min-height'],
    // Recentes e o resumo de agentes mediam 24px: disclosure é botão, não rótulo.
    '.workspace-rail__group-toggle': ['min-height'],
    '.workspace-rail__agents-toggle': ['min-height'],
    '.workspace-rail__missions-more': ['min-height'],
    '.workspace-rail__workspace-toggle': ['height', 'min-width'],
    '.workspace-rail__workspace-action': ['height', 'width'],
    '.workspace-rail__mission-remove': ['height', 'width'],
    '.workspace-rail__row-grid-action': ['height', 'width'],
    '.workspace-cleanup button': ['min-height'],
  };

  it('resolve tokens de espaço e calc() (o guard não está lendo o vazio)', () => {
    expect(lengthPx('var(--space-6)')).toBe(32);
    expect(lengthPx('calc(var(--space-6) + var(--space-3))')).toBe(44);
    expect(lengthPx('var(--space-5)')).toBe(24);
    // Só o que é espaço resolve: qualquer outro token vira NaN e reprova o alvo.
    expect(lengthPx('var(--radius-md)')).toBeNaN();
  });

  it.each(Object.entries(TARGETS))('%s mede pelo menos 32px', (selector, properties) => {
    for (const property of properties) {
      const sizes = sizesOf(railRules, selector, property);
      expect(sizes.length, `${selector} não declara ${property}`).toBeGreaterThan(0);
      expect(Math.min(...sizes), `${selector} · ${property}`).toBeGreaterThanOrEqual(DESKTOP_FLOOR);
    }
  });

  it('no toque (pointer: coarse) as linhas e os disclosures sobem para 44px', () => {
    const coarse = [
      ...stripComments(appShellCss).matchAll(
        /@media \(pointer: coarse\)\s*\{((?:[^{}]*\{[^{}]*\})+)\s*\}/g,
      ),
    ].flatMap((match) => rulesOf(match[1]));
    expect(coarse.length).toBeGreaterThan(0);
    for (const selector of [
      '.workspace-rail__new',
      '.workspace-rail__row',
      '.workspace-rail__group-toggle',
      '.workspace-rail__agents-toggle',
      '.workspace-rail__cockpit-status .workspace-rail__settings',
    ]) {
      const sizes = sizesOf(coarse, selector, 'min-height');
      expect(sizes.length, `${selector} fora do bloco pointer: coarse`).toBeGreaterThan(0);
      expect(Math.min(...sizes), selector).toBeGreaterThanOrEqual(TOUCH_FLOOR);
    }
  });
});

describe('rail: contraste do texto sobre --bg-bar e sobre a linha selecionada, em todo tema de PALETTES', () => {
  const AA = 4.5;
  /** Token de texto do CSS → chave da paleta. Alias novo falha alto no teste abaixo, de propósito. */
  const TEXT_KEY: Record<string, keyof UiPalette> = {
    '--text': 'text',
    '--text-main': 'text',
    '--text-dim': 'textDim',
    '--text-muted': 'textDim', // alias de --text-dim em base.css
    '--text-faint': 'textFaint',
  };
  const SURFACE_KEY: Record<string, keyof UiPalette> = {
    '--bg': 'bg',
    '--bg-elevated': 'bgElevated',
    '--bg-bar': 'bgBar',
  };
  const INK = /(?:^|[;\s])color\s*:\s*var\((--text[\w-]*)\)\s*;/;
  const themes = Object.entries(PALETTES) as Array<[string, UiPalette]>;

  /** Regras do rail que pintam texto com a hierarquia de texto (`color: var(--text…)`). */
  const railText = railRules.flatMap((candidate) => {
    const token = candidate.body.match(INK)?.[1];
    return token ? [{ selector: candidate.selector.replace(/\s+/g, ' '), token }] : [];
  });

  // Superfícies lidas do CSS: o fundo que o rail pinta e o toque de acento da seleção.
  const railSurface = rule('.workspace-rail')?.body.match(/background\s*:\s*var\((--[\w-]+)\)/)?.[1] ?? '';
  /** A linha selecionada pinta texto sobre a tinta em repouso e com o mouse em cima. */
  const SELECTED = ['.workspace-rail__row--selected', '.workspace-rail__row--selected:hover'] as const;
  const TINT = /background\s*:\s*color-mix\(in srgb,\s*var\(--accent\)\s+(\d+(?:\.\d+)?)%,\s*transparent\)/;
  /** Quanto de acento a regra põe sobre o fundo (a última declaração vence); NaN se não há. */
  const shareOf = (selector: string) =>
    Number(
      rulesFor(selector)
        .map((candidate) => candidate.body.match(TINT)?.[1])
        .filter(Boolean)
        .pop(),
    ) / 100;
  /**
   * Tokens de texto que a regra reaponta para os filhos (`--text-faint: var(--text-dim)`):
   * o degrau que a linha pinta DE FATO, que é o que o contraste precisa medir.
   */
  const remapOf = (selector: string) =>
    new Map(
      rulesFor(selector).flatMap((candidate) =>
        [...candidate.body.matchAll(/(?:^|[;\s])(--text[\w-]*)\s*:\s*var\((--text[\w-]*)\)\s*;/g)].map(
          (match) => [match[1], match[2]] as const,
        ),
      ),
    );

  /** Fundo do rail neste tema. */
  const barOf = (palette: UiPalette) => palette[SURFACE_KEY[railSurface]];
  /** Fundo da linha selecionada neste tema: o acento a `share` sobre o fundo do rail. */
  const selectedOver = (palette: UiPalette, share: number) => {
    const from = hexToSrgb(palette.accent);
    const to = hexToSrgb(barOf(palette));
    const mix = (index: 0 | 1 | 2) => from[index] * share + to[index] * (1 - share);
    return srgbToHex([mix(0), mix(1), mix(2)]);
  };

  it('lê do CSS o fundo do rail e o acento da seleção, e o texto de hierarquia que o rail usa', () => {
    // Os 7 temas selecionáveis: laço vazio aprovaria tudo.
    expect(themes.length).toBeGreaterThanOrEqual(7);
    expect(SURFACE_KEY[railSurface], `fundo do .workspace-rail: "${railSurface}"`).toBeDefined();
    // Repouso E hover declaram a tinta: sem a do hover, o hover genérico (mais
    // específico) apagaria a seleção e pintaria o texto sobre outra superfície.
    for (const selector of SELECTED) {
      expect(shareOf(selector), `${selector}: tinta de acento`).toBeGreaterThan(0);
      expect(shareOf(selector), `${selector}: tinta de acento`).toBeLessThan(0.5);
    }
    expect(railText.length).toBeGreaterThan(50);
    expect(
      railText.filter(({ token }) => !(token in TEXT_KEY)).map(({ selector, token }) => `${selector} → ${token}`),
    ).toEqual([]);
  });

  // O rail inteiro pousa em --bg-bar. Tema claro: o --text-faint de #6b7080 media 4,36:1 ali
  // (só --bg e --bg-elevated eram conferidos), em "Reportar bug" e nos títulos de seção de 11px.
  it.each(['.workspace-rail__report', '.workspace-rail__group-title'])(
    '%s: o texto pequeno segura 4,5:1 sobre --bg-bar em todos os temas',
    (selector) => {
      const token = rule(selector)?.body.match(INK)?.[1] ?? '';
      expect(TEXT_KEY[token], `${selector} precisa de um token de texto (color: ${token})`).toBeDefined();
      for (const [theme, palette] of themes) {
        expect(
          contrastRatio(palette[TEXT_KEY[token]], barOf(palette)),
          `${selector} (${token}) · ${theme}`,
        ).toBeGreaterThanOrEqual(AA);
      }
    },
  );

  it.each(themes.map(([theme]) => theme))(
    '%s: todo texto de hierarquia do rail segura 4,5:1 sobre --bg-bar',
    (theme) => {
      const palette = PALETTES[theme as keyof typeof PALETTES];
      const below = railText
        .map(({ selector, token }) => ({
          selector,
          token,
          ratio: contrastRatio(palette[TEXT_KEY[token]], barOf(palette)),
        }))
        .filter(({ ratio }) => ratio < AA)
        .map(({ selector, token, ratio }) => `${selector} (${token}) = ${ratio.toFixed(2)}`);
      expect(below).toEqual([]);
    },
  );

  /**
   * Sobre a linha selecionada (acento sobre a barra, DESIGN.md §16) o texto
   * segura 4,5:1 como em qualquer outro lugar — sem lista de exceção. Mede os três
   * degraus como a linha os pinta DE FATO: `--text-faint` não chega a 4,5 sobre a
   * tinta no nexus-light, e a regra o reaponta para `--text-dim` dentro da linha
   * (`--text-faint: var(--text-dim)`); a medição segue esse reapontamento lido do
   * CSS. Tinta maior, token novo ou o reapontamento removido derrubam o par aqui.
   */
  it.each(themes.map(([theme]) => theme))(
    '%s: sobre a linha selecionada (repouso e hover) text, dim e faint seguram 4,5:1',
    (theme) => {
      const palette = PALETTES[theme as keyof typeof PALETTES];
      const below = SELECTED.flatMap((selector) => {
        const remap = remapOf(selector);
        expect(shareOf(selector), `${selector}: tinta de acento`).toBeGreaterThan(0);
        const surface = selectedOver(palette, shareOf(selector));
        return (['--text', '--text-dim', '--text-faint'] as const).flatMap((token) => {
          const painted = remap.get(token) ?? token;
          expect(TEXT_KEY[painted], `${selector}: ${token} → ${painted}`).toBeDefined();
          const ratio = contrastRatio(palette[TEXT_KEY[painted]], surface);
          return ratio < AA
            ? [`${selector} · ${token}${painted === token ? '' : ` → ${painted}`} = ${ratio.toFixed(2)}`]
            : [];
        });
      });
      expect(below).toEqual([]);
    },
  );
});
