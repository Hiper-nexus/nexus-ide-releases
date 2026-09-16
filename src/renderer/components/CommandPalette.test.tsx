/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { useCommandPaletteStore } from '../state/command-palette-store';
import { useContextualPanelNavStore } from '../state/contextual-panel-nav-store';
import { useLayoutStore } from '../state/layout-store';
import { useMissionSetupStore } from '../state/mission-setup-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useAttentionInboxStore } from '../state/attention-inbox-store';
import { useSessionStateStore } from '../state/session-state-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(node));
  return host;
}

function actionButton(
  host: HTMLElement,
  label: string | RegExp,
): HTMLButtonElement {
  const action = Array.from(
    host.querySelectorAll<HTMLButtonElement>('button[role="option"]'),
  ).find((button) => {
    const text = button.textContent?.trim() ?? '';
    return typeof label === 'string' ? text.includes(label) : label.test(text);
  });
  if (!action) throw new Error(`Palette action not found: ${String(label)}`);
  return action;
}

beforeEach(() => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });

  useLayoutStore.setState({
    viewKind: 'grid',
    focusedPaneId: 'pane-1',
    root: {
      kind: 'leaf',
      id: 'leaf-1',
      pane: { id: 'pane-1', kind: 'shell', title: 'Terminal' },
    },
  } as never);
  useSessionStateStore.setState({ paneStates: new Map() } as never);
  useOrchStore.setState({ missions: [], missionSummaries: [] });
  useContextualPanelNavStore.setState({ requestedTab: null, requestId: 0 });
  useProductNavigationStore.setState({
    destination: { kind: 'terminal' },
    settingsReturnDestination: null,
  });
  useCommandPaletteStore.setState({ open: true });
  useAttentionInboxStore.setState({ open: false });
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  if (originalScrollIntoView) {
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollIntoView',
      originalScrollIntoView,
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
  vi.restoreAllMocks();
});

describe('CommandPalette product navigation', () => {
  it.each([
    ['Nova missão', { kind: 'mission-setup' }],
    ['Quadro de tarefas', { kind: 'task-board' }],
    ['Memória do projeto', { kind: 'memory' }],
    ['Configurações', { kind: 'settings' }],
  ] as const)(
    'routes %s through the canonical destination and closes the overlay',
    (label, expected) => {
      if (label === 'Nova missão') {
        useMissionSetupStore.setState({
          entryContext: { kind: 'pet-studio', revision: 1 },
        } as never);
      }
      const host = render(<CommandPalette />);
      expect(host.querySelector('[role="dialog"]')).not.toBeNull();

      act(() => actionButton(host, label).click());

      expect(useProductNavigationStore.getState().destination).toEqual(expected);
      expect(useCommandPaletteStore.getState().open).toBe(false);
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      if (label === 'Nova missão') {
        expect(
          Reflect.get(useMissionSetupStore.getState(), 'entryContext'),
        ).toBeNull();
      }
    },
  );

  it('exposes one mission creation command and no retired product labels', () => {
    const host = render(<CommandPalette />);
    const labels = Array.from(
      host.querySelectorAll<HTMLButtonElement>('button[role="option"]'),
      (button) => button.textContent?.trim() ?? '',
    );

    expect(labels.filter((label) => label.includes('Nova missão'))).toHaveLength(
      1,
    );
    expect(labels.some((label) => label.includes('Missão rápida'))).toBe(false);
    expect(labels.some((label) => label.includes('Painel de operações'))).toBe(
      false,
    );
    expect(labels.some((label) => label.includes('Quadro de tarefas'))).toBe(
      true,
    );
    expect(labels.some((label) => label.includes('Lista de atenção'))).toBe(
      true,
    );
  });

  it('abre a lista de atenção e fecha o palette', () => {
    const host = render(<CommandPalette />);
    act(() => actionButton(host, 'Lista de atenção').click());
    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(useAttentionInboxStore.getState().open).toBe(true);
  });

  it('keeps a focused mission pane inside its named mission terminals', () => {
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-1',
        pane: {
          id: 'pane-1',
          kind: 'shell',
          title: 'Terminal',
        },
      },
    } as never);
    // A ponte de orquestração pode conhecer a missão antes da persistência do
    // layout. O atalho precisa respeitar esse vínculo transitório também.
    useOrchStore.setState({
      paneMissions: { 'pane-1': 'mission-release' },
    } as never);
    useProductNavigationStore.getState().openTaskBoard();
    const host = render(<CommandPalette />);

    act(() => actionButton(host, 'Focar: Terminal').click());

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-release',
      surface: 'terminals',
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('oferece Terminais da missão quando o quadro está aberto (F-005)', () => {
    useProductNavigationStore.getState().openMission('mission-release');
    const host = render(<CommandPalette />);
    act(() => actionButton(host, 'Terminais da missão').click());
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-release',
      surface: 'terminals',
    });
  });
});
