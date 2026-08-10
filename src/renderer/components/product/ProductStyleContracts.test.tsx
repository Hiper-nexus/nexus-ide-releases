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
      expect(railWidth).toBeLessThanOrEqual(200);
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
      '[aria-label="Criar nova missão"]',
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
});
