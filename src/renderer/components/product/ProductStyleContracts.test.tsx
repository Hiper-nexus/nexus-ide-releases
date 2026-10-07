/** @vitest-environment jsdom */
import fs from 'node:fs';
import path from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeCssomDeclaration,
  computedCssValue,
  cssDeclarationHasPositiveDuration,
  installStyleContract,
  markFocusVisible,
  styleLengthPx,
  styleTracks,
} from '../style-contract.test-utils';
import { AppShell } from './AppShell';
import { MemoryWorkspace } from './MemoryWorkspace';
import { WorkspaceRail } from './WorkspaceRail';

const rendererStylesPath = path.resolve(
  process.cwd(),
  'src/renderer/styles',
);
const baseCss = fs.readFileSync(
  path.join(rendererStylesPath, 'base.css'),
  'utf8',
);
const appShellCss = fs.readFileSync(
  path.join(rendererStylesPath, 'app-shell.css'),
  'utf8',
);
const productWorkspacesCss = fs.readFileSync(
  path.join(rendererStylesPath, 'product-workspaces.css'),
  'utf8',
);
const productStyles = [baseCss, appShellCss, productWorkspacesCss] as const;

const requiredViewports = [
  { width: 1_100, height: 700, inspectorMode: 'stacked' },
  { width: 1_280, height: 800, inspectorMode: 'inline' },
  { width: 1_400, height: 900, inspectorMode: 'inline' },
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

function ProductShellFixture() {
  return (
    <AppShell
      rail={
        <WorkspaceRail
          activeWorkspaces={[]}
          recentWorkspaces={[]}
          selection={{ kind: 'settings' }}
          onCreateNew={vi.fn()}
          onSelectWorkspace={vi.fn()}
          onSelectMission={vi.fn()}
          onOpenTaskBoard={vi.fn()}
          onOpenMemory={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenTerminals={vi.fn()}
        />
      }
      content={<section className="product-workspace">Canvas do destino</section>}
      inspector={<section>Contexto do destino</section>}
      inspectorLabel="Contexto do destino"
    />
  );
}

async function settleEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  for (const { root } of mountedRoots.splice(0).reverse()) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  document.head
    .querySelectorAll('style[data-v2-style-contract]')
    .forEach((style) => style.remove());
  Reflect.deleteProperty(window, 'nexus');
  delete document.documentElement.dataset.platform;
  vi.restoreAllMocks();
});

describe('Nexus V2 shell and product workspace style contracts', () => {
  it.each(requiredViewports)(
    'keeps the persistent rail compact at $width×$height',
    ({ width, height }) => {
      installStyleContract(productStyles, { width });
      const host = render(<ProductShellFixture />, width, height);
      const shell = host.querySelector<HTMLElement>('.nexus-shell');
      if (!shell) throw new Error('AppShell did not render its root');

      const railWidth = styleLengthPx(shell, '--nexus-shell-rail-width');
      expect(railWidth).toBeGreaterThanOrEqual(160);
      expect(railWidth).toBeLessThanOrEqual(280);
    },
  );

  it.each(requiredViewports)(
    'uses the usable $inspectorMode canvas/inspector composition at $width×$height',
    ({ width, height, inspectorMode }) => {
      installStyleContract(productStyles, { width });
      const host = render(<ProductShellFixture />, width, height);
      const body = host.querySelector<HTMLElement>(
        '.nexus-shell__body--with-inspector',
      );
      if (!body) throw new Error('AppShell inspector composition is unavailable');

      const columnCount = styleTracks(body, 'grid-template-columns').length;
      expect(columnCount).toBe(inspectorMode === 'stacked' ? 1 : 2);
    },
  );

  it.each(requiredViewports)(
    'keeps declared shell tracks inside $width×$height',
    ({ width, height }) => {
      installStyleContract(productStyles, { width });
      const host = render(<ProductShellFixture />, width, height);
      const shell = host.querySelector<HTMLElement>('.nexus-shell');
      const body = host.querySelector<HTMLElement>(
        '.nexus-shell__body--with-inspector',
      );
      if (!shell || !body) {
        throw new Error('AppShell track-fit contract could not be rendered');
      }

      const railWidth = styleLengthPx(shell, '--nexus-shell-rail-width');
      const canvasMinimum = styleLengthPx(
        shell,
        '--nexus-shell-workspace-min',
      );
      const inspectorMinimum = styleLengthPx(
        shell,
        '--nexus-shell-inspector-min',
      );
      const splitInspector =
        styleTracks(body, 'grid-template-columns').length === 2;
      const declaredMinimum =
        railWidth +
        (splitInspector
          ? canvasMinimum + inspectorMinimum
          : Math.max(canvasMinimum, inspectorMinimum));

      expect(declaredMinimum).toBeLessThanOrEqual(width);
    },
  );

  it('renders visible 2px focus and dense targets on shell navigation controls', () => {
    installStyleContract(productStyles, { width: 1_400 });
    const host = render(<ProductShellFixture />);
    const skipLink = host.querySelector<HTMLAnchorElement>(
      '.nexus-shell__skip-link',
    );
    const createMission = host.querySelector<HTMLButtonElement>(
      '[aria-label="Novo pedido"]',
    );
    const settings = host.querySelector<HTMLButtonElement>(
      '[aria-label="Abrir Configurações"]',
    );
    if (!skipLink || !createMission || !settings) {
      throw new Error('Representative shell controls did not render');
    }

    for (const control of [skipLink, createMission, settings]) {
      markFocusVisible(control);
      expect(document.activeElement).toBe(control);
      expect(computedCssValue(control, 'outline')).not.toBe('none');
      expect(styleLengthPx(control, 'outline')).toBeGreaterThanOrEqual(2);
    }
    expect(styleLengthPx(createMission, 'min-height')).toBeGreaterThanOrEqual(32);
    expect(styleLengthPx(settings, 'min-height')).toBeGreaterThanOrEqual(32);
  });

  it('keeps the macOS traffic-light band clear of rail controls', () => {
    document.documentElement.dataset.platform = 'mac';
    installStyleContract(productStyles, { width: 1_400 });
    const host = render(<ProductShellFixture />);
    const identity = host.querySelector<HTMLElement>(
      '.workspace-rail__identity',
    );
    if (!identity) throw new Error('Workspace rail identity did not render');

    expect(styleLengthPx(identity, 'padding-top')).toBeGreaterThanOrEqual(32);
  });

  it('does not suppress the focus outline on the rendered product retry action', async () => {
    installStyleContract(productStyles, { width: 1_400 });
    const memoryList = vi.fn(async () => {
      throw new Error('memory unavailable');
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        product: {
          memoryList,
          memoryRemember: vi.fn(),
        },
      },
    });
    const host = render(<MemoryWorkspace />);
    await settleEffects();
    const retry = host.querySelector<HTMLButtonElement>('.product-pane__retry');
    if (!retry) throw new Error('MemoryWorkspace did not render its retry action');

    markFocusVisible(retry);
    expect(document.activeElement).toBe(retry);
    expect(computedCssValue(retry, 'outline')).not.toBe('none');
    expect(styleLengthPx(retry, 'outline')).toBeGreaterThanOrEqual(2);
    const retryMinimum = Math.max(
      styleLengthPx(retry, 'min-height'),
      styleLengthPx(retry, 'min-block-size'),
    );
    expect(retryMinimum).toBeGreaterThanOrEqual(32);
  });

  it('removes active shell transition declarations under reduced motion', () => {
    const selectors = [
      '.nexus-shell__skip-link',
      '.workspace-rail__new',
    ] as const;
    const normalStyle = installStyleContract(productStyles, { width: 1_400 });
    for (const selector of selectors) {
      expect(
        cssDeclarationHasPositiveDuration(
          activeCssomDeclaration(normalStyle, selector, 'transition'),
        ),
      ).toBe(true);
    }

    normalStyle.remove();
    const reducedStyle = installStyleContract(productStyles, {
      width: 1_400,
      reducedMotion: true,
    });
    for (const selector of selectors) {
      expect(
        activeCssomDeclaration(reducedStyle, selector, 'transition'),
      ).toBe('none');
    }
  });

  it('animates inspector presence with opacity/transform only and drops it under reduced motion', () => {
    // O inspector é irmão do palco do xterm: largura/altura nunca animam.
    const keyframes = [
      ...appShellCss.matchAll(
        /@keyframes product-inspector-[\w-]+\s*\{([\s\S]*?\})\s*\}/g,
      ),
    ];
    expect(keyframes).toHaveLength(2);
    for (const [, body] of keyframes) {
      const properties = [...body!.matchAll(/([a-z-]+)\s*:/g)].map(
        (match) => match[1],
      );
      expect(properties.length).toBeGreaterThan(0);
      for (const property of properties) {
        expect(['opacity', 'transform']).toContain(property);
      }
    }

    const selectors = [
      '.product-inspector[data-enter="animated"]',
      '.product-inspector[data-state="closing"]',
    ] as const;
    const normalStyle = installStyleContract(productStyles, { width: 1_400 });
    for (const selector of selectors) {
      expect(
        cssDeclarationHasPositiveDuration(
          activeCssomDeclaration(normalStyle, selector, 'animation'),
        ),
      ).toBe(true);
    }

    normalStyle.remove();
    const reducedStyle = installStyleContract(productStyles, {
      width: 1_400,
      reducedMotion: true,
    });
    for (const selector of selectors) {
      expect(activeCssomDeclaration(reducedStyle, selector, 'animation')).toBe(
        'none',
      );
    }
  });
  it('gives the project list a floor and lets the rail utilities yield instead', () => {
    installStyleContract(productStyles, { width: 1_100, height: 700 });
    const host = render(<ProductShellFixture />, 1_100, 700);
    const nav = host.querySelector<HTMLElement>('.workspace-rail__navigation');
    if (!nav) throw new Error('Workspace rail navigation did not render');

    const tracks = styleTracks(nav, 'grid-template-rows').map((track) =>
      track.replaceAll(' ', ''),
    );
    const projects = tracks.find((track) => track.endsWith(',1fr)'));
    if (!projects) {
      throw new Error('Rail has no elastic project track to protect');
    }
    const floor = Number.parseFloat(projects.replace(/^minmax\(/, ''));
    expect(floor).toBeGreaterThanOrEqual(140);

    // Alguma faixa precisa poder encolher abaixo do próprio conteúdo, senão o
    // piso da lista só empurra o rodapé para fora da janela.
    expect(tracks.some((track) => /^minmax\(0(px)?,/.test(track))).toBe(true);
  });

  it('drops the quota cockpit from the rail on short windows', () => {
    const tall = installStyleContract(productStyles, {
      width: 1_100,
      height: 900,
    });
    expect(
      activeCssomDeclaration(tall, '.workspace-rail__cockpit', 'display'),
    ).not.toBe('none');
    tall.remove();

    const short = installStyleContract(productStyles, {
      width: 1_100,
      height: 640,
    });
    expect(
      activeCssomDeclaration(short, '.workspace-rail__cockpit', 'display'),
    ).toBe('none');
  });

  it('keeps Configurações and its shortcuts on one 32px strip at any window height', () => {
    // Regressão do rodapé: Configurações media 40px (32px em janela baixa)
    // enquanto chave/mic ficavam presos em 24px e o selo Local em ~20px.
    for (const viewport of [
      { width: 1_400, height: 900 },
      { width: 1_280, height: 800 },
    ]) {
      const style = installStyleContract(productStyles, viewport);
      const host = render(<ProductShellFixture />, viewport.width, viewport.height);
      const strip = host.querySelector<HTMLElement>('.workspace-rail__cockpit-status');
      if (!strip) throw new Error('Rail footer strip did not render');
      const settings = strip.querySelector<HTMLElement>('.workspace-rail__settings');
      const shortcuts = strip.querySelectorAll<HTMLElement>('button:not(.workspace-rail__settings)');
      if (!settings) throw new Error('Configurações did not render in the strip');

      expect(shortcuts).toHaveLength(2);
      expect(styleLengthPx(settings, 'min-height')).toBe(32);
      for (const shortcut of shortcuts) {
        expect(shortcut.classList.contains('workspace-rail__row-grid-action')).toBe(true);
        expect(styleLengthPx(shortcut, 'height')).toBe(32);
        expect(styleLengthPx(shortcut, 'width')).toBe(32);
      }
      style.remove();
    }
  });

  it('keeps the rail resize handle inside the 200-480px band', () => {
    installStyleContract(productStyles, { width: 1_400, height: 900 });
    const host = render(<ProductShellFixture />, 1_400, 900);
    const handle = host.querySelector<HTMLElement>('.nexus-shell__rail-resize');
    if (!handle) throw new Error('Rail resize handle did not render');

    expect(handle.getAttribute('role')).toBe('separator');
    expect(Number(handle.getAttribute('aria-valuemin'))).toBe(240);
    expect(Number(handle.getAttribute('aria-valuemax'))).toBe(480);
    expect(styleLengthPx(handle, 'width')).toBeGreaterThanOrEqual(4);
  });
  it('keeps mission row actions out of the resting row and reveals them on hover/focus', () => {
    // Regra herdada do DESIGN do Agent Orchestrator (§4): a linha em repouso é
    // identidade + estado; ações aparecem no hover/foco sem mover o rótulo.
    const style = installStyleContract(productStyles, { width: 1_400, height: 900 });
    expect(
      activeCssomDeclaration(style, '.workspace-rail__mission-remove', 'opacity'),
    ).toBe('0');
    expect(
      activeCssomDeclaration(
        style,
        '.workspace-rail__mission-row:hover .workspace-rail__mission-remove',
        'opacity',
      ),
    ).toBe('1');
    expect(
      activeCssomDeclaration(
        style,
        '.workspace-rail__mission-row:focus-within .workspace-rail__mission-remove',
        'opacity',
      ),
    ).toBe('1');
  });
});

describe('rail em modo foco (Configurações)', () => {
  it('mantém o rodapé na última faixa quando a lista e as utilidades somem', () => {
    const active = installStyleContract(productStyles, { width: 1_280, height: 800 });
    // O modo foco esconde lista e utilidades com display:none; sem posição
    // explícita a colocação automática puxava o rodapé para a faixa elástica
    // e "Configurações" ficava no meio do rail com um vazio embaixo (28/09).
    expect(activeCssomDeclaration(active, '.nexus-shell--focus .workspace-rail__scroll', 'display')).toBe('none');
    expect(activeCssomDeclaration(active, '.nexus-shell--focus .workspace-rail__utilities', 'display')).toBe('none');

    const host = render(<ProductShellFixture />, 1_280, 800);
    const nav = host.querySelector<HTMLElement>('.workspace-rail__navigation');
    const footer = host.querySelector<HTMLElement>('.workspace-rail__footer');
    if (!nav || !footer) throw new Error('Workspace rail did not render');

    const navRows = styleTracks(nav, 'grid-template-rows').length;
    expect(activeCssomDeclaration(active, '.workspace-rail__scroll', 'grid-row')).toBe(String(navRows - 1));
    expect(activeCssomDeclaration(active, '.workspace-rail__footer', 'grid-row')).toBe(String(navRows));
    const footerRows = styleTracks(footer, 'grid-template-rows').length;
    expect(activeCssomDeclaration(active, '.workspace-rail__utilities', 'grid-row')).toBe('1');
    expect(activeCssomDeclaration(active, '.workspace-rail__cockpit-status', 'grid-row')).toBe(String(footerRows));
  });
});
