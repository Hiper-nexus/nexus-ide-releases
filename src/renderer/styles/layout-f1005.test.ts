import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// F-1005 — contratos de CSS dos bugs de layout achados na verificação visual.
// O jsdom não faz layout: estes testes travam a REGRA que resolve cada caso;
// a prova de que ela pinta certo é o print do app real (docs/qa/items/F-1005.md).

function css(name: string): string {
  return fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
}

function escape(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Corpo de TODAS as regras cujo seletor termina exatamente em `selector`. */
function rules(source: string, selector: string): string {
  const matches = source.matchAll(
    new RegExp(`(?:^|[}\\n,])\\s*${escape(selector)}\\s*\\{([^}]*)\\}`, 'g'),
  );
  return Array.from(matches, (match) => match[1]).join('\n');
}

describe('F-1005 (6) — rodapé do terminal segue o tema', () => {
  it('o viewport do xterm pinta o fundo do tema do terminal, nunca o #000 do xterm.css', () => {
    const body = rules(css('base.css'), '.term-host .xterm .xterm-viewport');
    expect(body).toMatch(/background-color:\s*var\(--term-bg/);
  });
});

describe('F-1005 (7) — "detalhes ›" não cobre o zoom do grafo', () => {
  it('a barra do grafo reserva a faixa do botão de detalhes', () => {
    const board = css('mission-board.css');
    const toolbar = rules(
      board,
      '.mission-board__graph-region .mission-graph:not(.mission-graph--presentation) .mission-graph__toolbar',
    );
    expect(toolbar).toMatch(/padding-inline-end:[^;]*var\(--mission-inspector-toggle-width\)/);
    const toggle = rules(board, '.mission-board__inspector-toggle');
    expect(toggle).toMatch(/inline-size:\s*var\(--mission-inspector-toggle-width\)/);
  });
});

describe('F-1005 (8) — timeline com uma rolagem só', () => {
  it('o painel da timeline não rola; a lista virtual ocupa a altura que sobra', () => {
    const board = css('mission-board.css');
    const panel = rules(
      board,
      '.mission-inspector__panel:not([hidden]):has(> .mission-inspector__activity-wrap--timeline)',
    );
    expect(panel).toMatch(/overflow:\s*hidden/);
    expect(panel).toMatch(/display:\s*flex/);
    const list = rules(board, '.mission-inspector__activity-wrap--timeline .agent-timeline__list');
    expect(list).toMatch(/flex:\s*1 1 auto/);
    expect(list).toMatch(/min-height:\s*0/);
    expect(list).toMatch(/max-height:\s*none/);
  });
});

describe('F-1005 (10) — flutuantes não tapam controles', () => {
  it('"+ Pane" fica ao lado do orbe, na mesma faixa', () => {
    expect(rules(css('pane-picker.css'), '.pane-picker')).toMatch(
      /right:[^;]*var\(--nexus-orb-safe-inline/,
    );
  });

  it('o card de aprovação sobe acima da faixa dos flutuantes', () => {
    const body = rules(css('pane-approval.css'), '.pane-approval');
    expect(body).toMatch(/bottom:[^;]*var\(--nexus-orb-safe-block/);
    expect(body).toMatch(/bottom:[^;]*var\(--pane-picker-safe-block/);
  });

  it('Configurações, painel lateral (Git) e barra de direção reservam a largura do orbe', () => {
    expect(rules(css('settings.css'), '.settings-detail__content')).toMatch(
      /padding-inline-end:[^;]*var\(--nexus-orb-safe-inline/,
    );
    expect(rules(css('product-wave.css'), '.ctx-panel__body')).toMatch(
      /padding-inline-end:[^;]*var\(--nexus-orb-safe-inline/,
    );
    expect(rules(css('mission-board.css'), '.mission-inspector__panel')).toMatch(
      /padding-inline-end:[^;]*var\(--nexus-orb-safe-inline/,
    );
    expect(rules(css('mission-board.css'), '.mission-board__direct-bar')).toMatch(
      /padding-inline-end:[^;]*var\(--nexus-orb-safe-inline/,
    );
  });

  it('a reserva do orbe no painel do inspetor tem teto (orbe parado + respiro = 72px)', () => {
    // O HUD ativo/expandido publica 120–500px em --nexus-orb-safe-inline; sem teto, num
    // inspetor de 360–440px a coluna útil encolhe até o editor e o botão se sobreporem.
    expect(rules(css('mission-board.css'), '.mission-inspector__panel')).toMatch(
      /padding-inline-end:\s*min\(\s*max\(var\(--space-4\),\s*var\(--nexus-orb-safe-inline,\s*0px\)\),\s*calc\(var\(--space-8\)\s*\+\s*var\(--space-2\)\)\s*\)/,
    );
  });
});
