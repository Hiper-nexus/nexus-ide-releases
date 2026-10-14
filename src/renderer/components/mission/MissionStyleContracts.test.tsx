/** @vitest-environment jsdom */
import fs from 'node:fs';
import path from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeCssomDeclaration,
  computedCssValue,
  cssDeclarationHasPositiveDuration,
  installStyleContract,
  markFocusVisible,
  styleLengthPx,
  styleTracks,
} from '../style-contract.test-utils';

const rendererStylesPath = path.resolve(
  process.cwd(),
  'src/renderer/styles',
);
const baseCss = fs.readFileSync(
  path.join(rendererStylesPath, 'base.css'),
  'utf8',
);
const missionSetupCss = fs.readFileSync(
  path.join(rendererStylesPath, 'mission-setup.css'),
  'utf8',
);
const missionBoardCss = fs.readFileSync(
  path.join(rendererStylesPath, 'mission-board.css'),
  'utf8',
);
const missionStyles = [baseCss, missionSetupCss, missionBoardCss] as const;

const missionViewports = [
  { width: 1_100, height: 700, boardWidth: 900, inspectorMode: 'stacked' },
  { width: 1_280, height: 800, boardWidth: 1_080, inspectorMode: 'stacked' },
  { width: 1_400, height: 900, boardWidth: 1_200, inspectorMode: 'inline' },
] as const;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ host: HTMLDivElement; root: Root }> = [];

function render(node: ReactNode, width = 1_400, height = 900): HTMLDivElement {
  const host = document.createElement('div');
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push({ host, root });
  act(() => root.render(node));
  return host;
}

function MissionStyleFixture() {
  return (
    <>
      <section className="mission-setup" aria-label="Configuração da missão">
        <nav className="mission-setup__progress" aria-label="Etapas da missão">
          <ol>
            <li data-state="current">Missão</li>
          </ol>
        </nav>
        <section className="mission-setup__step">
          <label className="mission-setup__field">
            Objetivo
            <input type="text" />
          </label>
          <button
            type="button"
            className="mission-setup__button mission-setup__button--primary"
          >
            Continuar para equipe
          </button>
          <button
            type="button"
            className="mission-setup__button mission-setup__button--quiet"
          >
            Remover contexto
          </button>
        </section>
      </section>

      <section className="mission-board" aria-label="Board da missão">
        <button type="button" className="mission-board__button">
          Retomar missão
        </button>
        <button
          type="button"
          className="mission-board__button mission-board__button--secondary"
        >
          Abrir terminais
        </button>
        <button type="button" className="mission-agent-card">
          Agente executor
        </button>
        <div className="mission-board__workspace-layout">
          <div className="mission-board__graph-region">Grafo</div>
          <div
            className="mission-board__splitter"
            role="separator"
            tabIndex={0}
          />
          <aside className="mission-board__inspector-region">
            <div className="mission-inspector">
              <button type="button" className="mission-inspector__tab">
                Detalhes
              </button>
            </div>
          </aside>
          <div
            className="mission-board__inspector-rail"
            role="separator"
            tabIndex={0}
          />
        </div>
      </section>
    </>
  );
}

/**
 * Etapa Equipe: área rolável + dock irmãos, e um cartão de papel por variante.
 * Mesma árvore de classes do TeamStep/MissionSetupRosterRow (sem os dados).
 */
function TeamRow({ compact = false }: { compact?: boolean }) {
  return (
    <li
      className={
        compact ? 'mission-roster-row mission-roster-row--compact' : 'mission-roster-row'
      }
    >
      <div className="mission-roster-row__card">
        <div className="mission-roster-row__summary">
          <span className="mission-roster-row__avatar">⚒</span>
          <div className="mission-roster-row__identity">
            <strong>Implementar interface</strong>
            <span className="mission-roster-row__meta">
              <span className="mission-roster-row__role">Execução</span>
            </span>
            <div className="mission-roster-row__controls">
              <label className="mission-roster-row__control">
                <span>Ferramenta</span>
                <select><option>Codex</option></select>
              </label>
              <label className="mission-roster-row__control mission-roster-row__control--model">
                <span>Modelo</span>
                <select><option>gpt-6.1-sol</option></select>
              </label>
              <label className="mission-roster-row__control">
                <span>Esforço</span>
                <select><option>High</option></select>
              </label>
            </div>
          </div>
          <span className="mission-roster-row__status">Pronto</span>
          <button
            type="button"
            className="mission-setup__button mission-setup__button--quiet mission-roster-row__remove"
            aria-label="Remover Implementar interface"
          >
            x
          </button>
        </div>
        <div className="mission-roster-row__more">
          <details className="mission-setup__disclosure mission-roster-row__details">
            <summary>Instruções para Implementar interface</summary>
          </details>
        </div>
      </div>
    </li>
  );
}

function DockedTeamFixture({ compact = false }: { compact?: boolean }) {
  return (
    <section className="mission-setup">
      <div className="mission-setup__canvas">
        <section className="mission-setup__step mission-setup__step--docked">
          <div className="mission-setup__step-scroll">
            <ul className="mission-roster">
              <TeamRow compact={compact} />
              <TeamRow compact={compact} />
            </ul>
          </div>
          <div className="mission-setup__step-dock">
            <footer className="mission-setup__step-actions">
              <button type="button" className="mission-setup__button mission-setup__button--secondary">
                Voltar para missão
              </button>
              <button type="button" className="mission-setup__button mission-setup__button--primary">
                Continuar para revisão
              </button>
            </footer>
          </div>
        </section>
      </div>
    </section>
  );
}

afterEach(() => {
  for (const { root } of mountedRoots.splice(0).reverse()) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  document.head
    .querySelectorAll('style[data-v2-style-contract]')
    .forEach((style) => style.remove());
});

describe('Mission Setup and Mission Board style contracts', () => {
  it.each([
    { width: 900, canvasWidth: 650, stacked: true },
    { width: 1_100, canvasWidth: 850, stacked: false },
  ])('sizes the express team for its $canvasWidth px canvas in a $width px window', ({ width, canvasWidth, stacked }) => {
    installStyleContract(missionStyles, { width, containerWidth: canvasWidth });
    const host = render(
      <section className="mission-setup">
        <div className="mission-setup__canvas">
          <div className="mission-setup__step mission-setup__step--express">
            <div className="mission-roster-row mission-roster-row--compact">
              <div className="mission-roster-row__identity">
                <strong>Construir o sistema</strong>
                <div className="mission-roster-row__controls">
                  <label className="mission-roster-row__control">
                    <span>Ferramenta</span>
                    <select><option>Claude</option></select>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>,
      width,
    );
    const canvas = host.querySelector('.mission-setup__canvas')!;
    const identity = host.querySelector('.mission-roster-row__identity')!;
    const controls = host.querySelector('.mission-roster-row__controls')!;

    expect(computedCssValue(canvas, 'container-type')).toBe('inline-size');
    expect(computedCssValue(identity, 'grid-template-areas'))
      .toContain(stacked ? "'name'" : "'name controls'");
    expect(computedCssValue(controls, 'flex-wrap')).toBe(stacked ? 'wrap' : 'nowrap');
  });

  it('renders >=2px focus on representative setup and board controls', () => {
    installStyleContract(missionStyles, {
      width: 1_400,
      containerWidth: 1_200,
    });
    const host = render(<MissionStyleFixture />);
    const controls = [
      host.querySelector<HTMLButtonElement>('.mission-setup__button--primary'),
      host.querySelector<HTMLInputElement>('.mission-setup__field input'),
      host.querySelector<HTMLButtonElement>('.mission-board__button'),
      host.querySelector<HTMLButtonElement>('.mission-agent-card'),
      host.querySelector<HTMLElement>('.mission-board__splitter'),
      host.querySelector<HTMLElement>('.mission-board__inspector-rail'),
    ];

    for (const control of controls) {
      if (!control) throw new Error('A representative mission control is missing');
      markFocusVisible(control);
      expect(document.activeElement).toBe(control);
      expect(computedCssValue(control, 'outline')).not.toBe('none');
      expect(styleLengthPx(control, 'outline')).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps primary mission actions >=40px and dense actions >=32px', () => {
    installStyleContract(missionStyles, {
      width: 1_400,
      containerWidth: 1_200,
    });
    const host = render(<MissionStyleFixture />);
    const setupPrimary = host.querySelector<HTMLElement>(
      '.mission-setup__button--primary',
    );
    const setupDense = host.querySelector<HTMLElement>(
      '.mission-setup__button--quiet',
    );
    const boardPrimary = host.querySelector<HTMLElement>(
      '.mission-board__button:not(.mission-board__button--secondary)',
    );
    const boardDense = host.querySelector<HTMLElement>(
      '.mission-board__button--secondary',
    );
    if (!setupPrimary || !setupDense || !boardPrimary || !boardDense) {
      throw new Error('Mission target-size controls did not render');
    }

    expect(styleLengthPx(setupPrimary, 'min-height')).toBeGreaterThanOrEqual(40);
    expect(styleLengthPx(boardPrimary, 'min-height')).toBeGreaterThanOrEqual(40);
    expect(styleLengthPx(setupDense, 'min-height')).toBeGreaterThanOrEqual(32);
    expect(styleLengthPx(boardDense, 'min-height')).toBeGreaterThanOrEqual(32);
  });

  it.each([
    { containerWidth: 1_200, stacked: false },
    { containerWidth: 900, stacked: true },
  ])(
    'keeps the collapsed inspector rail 8px thin on its edge (stacked: $stacked) with a >=32px tall target side by side',
    ({ containerWidth, stacked }) => {
      installStyleContract(missionStyles, { width: 1_400, containerWidth });
      const host = render(<MissionStyleFixture />);
      const rail = host.querySelector<HTMLElement>(
        '.mission-board__inspector-rail',
      );
      if (!rail) throw new Error('Collapsed inspector rail did not render');

      if (stacked) {
        expect(styleLengthPx(rail, 'height')).toBe(8);
        expect(computedCssValue(rail, 'width')).toBe('100%');
        expect(computedCssValue(rail, 'cursor')).toBe('row-resize');
      } else {
        expect(styleLengthPx(rail, 'width')).toBe(8);
        expect(styleLengthPx(rail, 'min-height')).toBeGreaterThanOrEqual(32);
        expect(computedCssValue(rail, 'align-self')).toBe('stretch');
        expect(computedCssValue(rail, 'cursor')).toBe('col-resize');
      }
    },
  );

  it('keeps the inspector region inside the shell band without inline styles per child', () => {
    installStyleContract(missionStyles, { width: 1_400, containerWidth: 1_200 });
    const host = render(<MissionStyleFixture />);
    const inspector = host.querySelector<HTMLElement>(
      '.mission-board__inspector-region',
    );
    if (!inspector) throw new Error('Inspector region did not render');

    expect(computedCssValue(inspector, 'width')).toBe('400px');
    expect(styleLengthPx(inspector, 'min-width')).toBe(360);
    expect(styleLengthPx(inspector, 'max-width')).toBe(440);
    expect(inspector.getAttribute('style')).toBeNull();
  });

  it.each(missionViewports)(
    'keeps the board graph/inspector $inspectorMode at $width×$height after the compact rail allocation',
    ({ width, height, boardWidth, inspectorMode }) => {
      installStyleContract(missionStyles, {
        width,
        containerWidth: boardWidth,
      });
      const host = render(<MissionStyleFixture />, width, height);
      const layout = host.querySelector<HTMLElement>(
        '.mission-board__workspace-layout',
      );
      const graph = host.querySelector<HTMLElement>(
        '.mission-board__graph-region',
      );
      const inspector = host.querySelector<HTMLElement>(
        '.mission-board__inspector-region',
      );
      if (!layout || !graph || !inspector) {
        throw new Error('Mission Board responsive regions did not render');
      }

      const flexDirection = computedCssValue(layout, 'flex-direction');
      if (inspectorMode === 'stacked') {
        expect(flexDirection).toBe('column');
      } else {
        expect(flexDirection).not.toBe('column');
      }
      expect(styleLengthPx(graph, 'min-width')).toBe(0);
      if (inspectorMode === 'stacked') {
        expect(styleLengthPx(inspector, 'min-width')).toBe(0);
        expect(computedCssValue(inspector, 'width')).toBe('100%');
      } else {
        expect(styleLengthPx(inspector, 'min-width')).toBeLessThan(boardWidth);
      }
    },
  );

  it('does not size setup steps against the viewport or a percentage of the scroller', () => {
    expect(missionSetupCss).not.toMatch(/min-height:\s*calc\(100vh/);
    expect(missionSetupCss).not.toMatch(
      /\.mission-setup__canvas\s*\{[^}]*min-height:\s*calc\(100%/,
    );
    expect(missionSetupCss).toMatch(
      /\.mission-setup\s*\{[^}]*overflow:\s*hidden/,
    );
    expect(missionSetupCss).toMatch(
      /\.mission-setup__canvas\s*\{[^}]*overflow:\s*hidden/,
    );
    expect(missionSetupCss).toMatch(
      /\.mission-setup__step\s*\{[^}]*overflow-y:\s*auto/,
    );
    expect(missionSetupCss).toMatch(/\.mission-setup__step-dock/);
    expect(missionSetupCss).toMatch(
      /\.mission-setup__step\s*>\s*\.mission-setup__step-actions/,
    );
  });

  describe('team step: actions dock and role cards', () => {
    it('keeps the dock out of the scroller: the step clips, only the scroll region scrolls', () => {
      const style = installStyleContract(missionStyles, {
        width: 1_400,
        containerWidth: 1_200,
      });
      const host = render(<DockedTeamFixture />);
      const scroll = host.querySelector<HTMLElement>('.mission-setup__step-scroll')!;
      const dock = host.querySelector<HTMLElement>('.mission-setup__step-dock')!;
      const actions = host.querySelector<HTMLElement>('.mission-setup__step-actions')!;

      // O passo com dock não rola: quem rola é só `.mission-setup__step-scroll`.
      const dockedStep = '.mission-setup__step.mission-setup__step--docked';
      expect(activeCssomDeclaration(style, dockedStep, 'overflow')).toBe('hidden');
      expect(
        Number.parseFloat(activeCssomDeclaration(style, dockedStep, 'padding-bottom')),
      ).toBe(0);
      expect(computedCssValue(scroll, 'overflow-y')).toBe('auto');
      // A barra dentro do dock é estática: o sticky do rodapé de passo só vale
      // para filho DIRETO do passo, que era justamente o que cobria os cartões.
      expect(computedCssValue(actions, 'position')).not.toBe('sticky');
      expect(computedCssValue(dock, 'position')).not.toBe('sticky');
      // Dock opaco e separado por fio: nada rolando aparece por trás dele.
      expect(missionSetupCss).toMatch(
        /\.mission-setup__step-dock\s*\{[^}]*background:\s*var\(--bg\)[^}]*border-top:\s*1px solid var\(--border\)/,
      );
      expect(missionSetupCss).toMatch(
        /\.mission-setup__step--docked\s*>\s*\.mission-setup__step-dock/,
      );
    });

    it('reserves the same scrollbar gutter in the list and in the dock, so the buttons share the cards edge', () => {
      // A barra clássica come ~11px da lista e nada do dock: sem a mesma calha
      // reservada nos dois, o Continuar passava da borda dos cartões.
      expect(missionSetupCss).toMatch(
        /\.mission-setup__step-scroll\s*\{[^}]*scrollbar-gutter:\s*stable/,
      );
      expect(missionSetupCss).toMatch(
        /\.mission-setup__step--docked\s*>\s*\.mission-setup__step-dock\s*\{[^}]*overflow:\s*hidden[^}]*scrollbar-gutter:\s*stable/,
      );
    });

    it('keeps the in-card problem reason in the danger color despite the section paragraph rule', () => {
      // `.mission-setup__continuous-section p` (0,1,1) vence `.mission-setup__inline-error`
      // (0,1,0): o motivo saía cinza. jsdom não aplica especificidade, então a
      // regra mais forte fica travada na fonte.
      expect(missionSetupCss).toMatch(
        /\.mission-roster-row__card\s+\.mission-setup__inline-error\s*\{[^}]*color:\s*var\(--danger\)/,
      );
    });

    it.each([
      {
        containerWidth: 900,
        columns: 3,
        nameWrap: 'nowrap',
        headerRows: ["'avatar name status remove'", "'avatar role status remove'"],
      },
      {
        containerWidth: 520,
        columns: 1,
        nameWrap: 'normal',
        headerRows: ["'avatar name name remove'", "'avatar role status status'"],
      },
    ])(
      'lays the Ferramenta/Modelo/Esforço controls on $columns track(s) in a $containerWidth px canvas, the same in every card',
      ({ containerWidth, columns, nameWrap, headerRows }) => {
        installStyleContract(missionStyles, { width: 1_400, containerWidth });
        const host = render(<DockedTeamFixture />);
        const controls = [
          ...host.querySelectorAll<HTMLElement>('.mission-roster-row__controls'),
        ];

        expect(controls).toHaveLength(2);
        for (const control of controls) {
          expect(computedCssValue(control, 'display')).toBe('grid');
          expect(styleTracks(control, 'grid-template-columns')).toHaveLength(columns);
        }
        expect(computedCssValue(controls[0]!, 'grid-template-columns')).toBe(
          computedCssValue(controls[1]!, 'grid-template-columns'),
        );
        // Canvas estreito: o nome do papel quebra em vez de virar "Implementar i…".
        expect(
          computedCssValue(
            host.querySelector<HTMLElement>('.mission-roster-row__identity > strong')!,
            'white-space',
          ),
        ).toBe(nameWrap);
        // E o estado sai da linha do nome (que ganha a largura toda) para a do papel.
        const areas = computedCssValue(
          host.querySelector<HTMLElement>('.mission-roster-row__summary')!,
          'grid-template-areas',
        );
        for (const row of headerRows) expect(areas).toContain(row);
      },
    );

    it('puts name, status and remove in one header grid whose remove column is always reserved', () => {
      installStyleContract(missionStyles, { width: 1_400, containerWidth: 1_200 });
      const host = render(<DockedTeamFixture />);
      const summary = host.querySelector<HTMLElement>('.mission-roster-row__summary')!;
      const identity = host.querySelector<HTMLElement>('.mission-roster-row__identity')!;
      const status = host.querySelector<HTMLElement>('.mission-roster-row__status')!;
      const remove = host.querySelector<HTMLElement>('.mission-roster-row__remove')!;
      const controls = host.querySelector<HTMLElement>('.mission-roster-row__controls')!;

      expect(computedCssValue(summary, 'display')).toBe('grid');
      // A identidade se dissolve na grade do cabeçalho: nome e papel de um lado,
      // estado e remover sempre nas mesmas colunas, controles na faixa de baixo.
      expect(computedCssValue(identity, 'display')).toBe('contents');
      expect(computedCssValue(summary, 'grid-template-areas')).toContain("'avatar name status remove'");
      expect(computedCssValue(summary, 'grid-template-areas')).toContain("'controls controls controls controls'");
      expect(computedCssValue(status, 'grid-area')).toBe('status');
      expect(computedCssValue(remove, 'grid-area')).toBe('remove');
      expect(computedCssValue(controls, 'grid-area')).toBe('controls');
    });

    it('keeps the remove target at the secondary-target minimum (32px, larger on touch/narrow)', () => {
      installStyleContract(missionStyles, { width: 1_400, containerWidth: 1_200 });
      const desktop = render(<DockedTeamFixture />);
      const desktopRemove = desktop.querySelector<HTMLElement>('.mission-roster-row__remove')!;
      expect(styleLengthPx(desktopRemove, 'width')).toBeGreaterThanOrEqual(32);
      expect(styleLengthPx(desktopRemove, 'min-height')).toBeGreaterThanOrEqual(32);
      const desktopSelect = desktop.querySelector<HTMLElement>('.mission-roster-row__control select')!;
      expect(styleLengthPx(desktopSelect, 'min-height')).toBe(32);
      // Controle só de ícone: quem navega por teclado precisa enxergar onde está.
      markFocusVisible(desktopRemove);
      expect(computedCssValue(desktopRemove, 'outline')).not.toBe('none');
      expect(styleLengthPx(desktopRemove, 'outline')).toBeGreaterThanOrEqual(2);

      document.head
        .querySelectorAll('style[data-v2-style-contract]')
        .forEach((style) => style.remove());
      installStyleContract(missionStyles, {
        width: 700,
        containerWidth: 600,
        pointer: 'coarse',
      });
      const touch = render(<DockedTeamFixture />, 700);
      const touchRemove = touch.querySelector<HTMLElement>('.mission-roster-row__remove')!;
      expect(styleLengthPx(touchRemove, 'width')).toBeGreaterThanOrEqual(44);
      expect(styleLengthPx(touchRemove, 'min-height')).toBeGreaterThanOrEqual(44);
      // Os selects do cartão crescem junto com o botão: alvo de toque coerente.
      const touchSelect = touch.querySelector<HTMLElement>('.mission-roster-row__control select')!;
      expect(styleLengthPx(touchSelect, 'min-height')).toBeGreaterThanOrEqual(44);
    });

    it('writes the preset label and captions in sentence case and keeps the technical panel neutral', () => {
      installStyleContract(missionStyles, { width: 1_400, containerWidth: 1_200 });
      const host = render(
        <section className="mission-setup">
          <div className="mission-setup__presets">
            <span className="mission-setup__presets-label">Tamanho da equipe</span>
            <div className="mission-setup__preset-row" role="group" aria-label="Tamanho da equipe">
              <button type="button" className="mission-setup__preset" aria-pressed="false">
                <strong>3</strong>
                <span>Enxuta</span>
              </button>
            </div>
          </div>
        </section>,
      );
      for (const element of [
        host.querySelector<HTMLElement>('.mission-setup__presets-label')!,
        host.querySelector<HTMLElement>('.mission-setup__preset span')!,
      ]) {
        expect(computedCssValue(element, 'text-transform')).not.toBe('uppercase');
      }
      // Painel de Configurações técnicas: neutro, sem tinta de acento (acento é
      // estado, DESIGN.md §2); tingido de rosa ele lia como caixa de erro.
      const technicalPanel =
        missionSetupCss.match(/\.mission-roster-row__technical-grid\s*\{[^}]*\}/)?.[0] ?? '';
      expect(technicalPanel).not.toBe('');
      expect(technicalPanel).not.toMatch(/accent/);
    });

    it('writes the control labels in sentence case on the team card and leaves the express card alone', () => {
      installStyleContract(missionStyles, { width: 1_400, containerWidth: 1_200 });
      const team = render(<DockedTeamFixture />);
      const teamLabel = team.querySelector<HTMLElement>('.mission-roster-row__control > span')!;
      expect(computedCssValue(teamLabel, 'text-transform')).toBe('none');

      const express = render(<DockedTeamFixture compact />);
      const expressRow = express.querySelector<HTMLElement>('.mission-roster-row--compact')!;
      expect(
        computedCssValue(
          expressRow.querySelector<HTMLElement>('.mission-roster-row__control > span')!,
          'text-transform',
        ),
      ).toBe('uppercase');
      // Expresso segue com os controles em fila e a linha em flex: só a Equipe mudou.
      expect(
        computedCssValue(
          expressRow.querySelector<HTMLElement>('.mission-roster-row__controls')!,
          'display',
        ),
      ).toBe('flex');
      expect(
        computedCssValue(
          expressRow.querySelector<HTMLElement>('.mission-roster-row__summary')!,
          'display',
        ),
      ).toBe('flex');
    });
  });

  it('removes active mission motion declarations under reduced motion', () => {
    const motionContracts = [
      { selector: '.mission-setup__step', property: 'animation' },
      { selector: '.mission-setup__progress li', property: 'transition' },
      { selector: '.mission-setup__button', property: 'transition' },
      { selector: '.mission-board__button', property: 'transition' },
      { selector: '.mission-agent-card', property: 'transition' },
    ] as const;
    const normalStyle = installStyleContract(missionStyles, {
      width: 1_400,
      containerWidth: 1_200,
    });
    for (const { selector, property } of motionContracts) {
      expect(
        cssDeclarationHasPositiveDuration(
          activeCssomDeclaration(normalStyle, selector, property),
        ),
      ).toBe(true);
    }

    normalStyle.remove();
    const reducedStyle = installStyleContract(missionStyles, {
      width: 1_400,
      containerWidth: 1_200,
      reducedMotion: true,
    });
    for (const { selector, property } of motionContracts) {
      expect(
        activeCssomDeclaration(reducedStyle, selector, property),
      ).toBe('none');
    }
  });
});
