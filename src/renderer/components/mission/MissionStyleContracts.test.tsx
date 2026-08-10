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
        </div>
      </section>
    </>
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
