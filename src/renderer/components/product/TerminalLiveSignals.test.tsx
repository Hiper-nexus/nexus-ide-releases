/** @vitest-environment jsdom */
import { Profiler, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../../shared/types';
import {
  listPaneScopes,
  paneScopeResolver,
  spaceScopeKey,
} from '../../lib/pane-spaces';
import { usePaneParkedStore } from '../../state/pane-parked-store';
import { useSessionStateStore } from '../../state/session-state-store';
import {
  LiveWorkspaceTabs,
  MissionWorkingChip,
  type LiveWorkspaceTabsProps,
} from './TerminalLiveSignals';

vi.mock('../PanePicker', () => ({ PanePicker: () => null }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PANES: PaneModel[] = [
  { id: 'a', kind: 'cli-agent', title: 'Claude · A', adapterId: 'claude', spaceId: 'sp', spaceTitle: 'Checkout' },
  { id: 'b', kind: 'cli-agent', title: 'GPT · B', adapterId: 'codex', spaceId: 'sp', spaceTitle: 'Checkout' },
  { id: 'sh', kind: 'shell', title: 'zsh', spaceId: 'sp', spaceTitle: 'Checkout' },
];

const mounted: Root[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of mounted.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  act(() => {
    for (const pane of PANES) useSessionStateStore.getState().clearPaneState(pane.id);
    usePaneParkedStore.setState({ parked: new Map() });
  });
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => root.render(node));
  return host;
}

function tabsProps(): LiveWorkspaceTabsProps {
  return {
    panes: PANES,
    scopeOf: paneScopeResolver(PANES, {}),
    scopes: listPaneScopes({ panes: PANES, paneMissions: {}, missions: [] }),
    activeScopeKey: spaceScopeKey('sp'),
    sideScopeKey: null,
    overview: false,
    editing: null,
    onFocusScope: vi.fn(),
    onToggleOverview: vi.fn(),
    onToggleBeside: vi.fn(),
    onCloseBeside: vi.fn(),
    onStartRename: vi.fn(),
    onRenameDraft: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onCloseTab: vi.fn(),
    onTabPaneCreated: vi.fn(),
    onNewMission: vi.fn(),
  };
}

describe('LiveWorkspaceTabs', () => {
  it('a aba ganha o número de quem trabalha e perde quando todos param', () => {
    vi.useFakeTimers();
    const host = mount(<LiveWorkspaceTabs {...tabsProps()} />);
    expect(host.querySelector('.workspace-tab__working')).toBeNull();

    act(() => useSessionStateStore.getState().setPaneState('a', 'busy'));
    expect(host.querySelector('.workspace-tab__working')?.textContent).toBe('1');
    act(() => useSessionStateStore.getState().setPaneState('b', 'busy'));
    expect(host.querySelector('.workspace-tab__working')?.textContent).toBe('2');
    // O shell nunca entra na conta, mesmo "ocupado".
    act(() => useSessionStateStore.getState().setPaneState('sh', 'busy'));
    expect(host.querySelector('.workspace-tab__working')?.textContent).toBe('2');

    act(() => {
      useSessionStateStore.getState().setPaneState('a', 'idle');
      useSessionStateStore.getState().setPaneState('b', 'idle');
      // O busy segura um instante (displayStates): a aba não pisca no respiro.
      vi.advanceTimersByTime(1_500);
    });
    expect(host.querySelector('.workspace-tab__working')).toBeNull();
  });

  it('só re-renderiza quando o CONJUNTO de quem trabalha muda', () => {
    const renders = vi.fn();
    mount(
      <Profiler id="tabs" onRender={renders}>
        <LiveWorkspaceTabs {...tabsProps()} />
      </Profiler>,
    );
    renders.mockClear();

    // Aguardando → iniciando → encerrado: ninguém entrou nem saiu do trabalho.
    act(() => useSessionStateStore.getState().setPaneState('a', 'idle'));
    act(() => useSessionStateStore.getState().setPaneState('a', 'spawning'));
    act(() => useSessionStateStore.getState().setPaneState('b', 'exited'));
    expect(renders).not.toHaveBeenCalled();

    // Entrar no trabalho é o que importa para a barra.
    act(() => useSessionStateStore.getState().setPaneState('a', 'busy'));
    expect(renders).toHaveBeenCalled();
  });

  it('estacionado pelo guardian sai da contagem', () => {
    const host = mount(<LiveWorkspaceTabs {...tabsProps()} />);
    act(() => useSessionStateStore.getState().setPaneState('a', 'busy'));
    expect(host.querySelector('.workspace-tab__working')?.textContent).toBe('1');

    act(() =>
      usePaneParkedStore
        .getState()
        .markParked('a', { sessionId: 's', parkedAt: 1, reason: 'idle' }),
    );
    expect(host.querySelector('.workspace-tab__working')).toBeNull();
  });
});

describe('MissionWorkingChip', () => {
  it('conta só os panes que a missão desenha, com "em paralelo" a partir de dois', () => {
    const host = mount(<MissionWorkingChip panes={PANES} visibleIds={new Set(['a', 'sh'])} />);
    expect(host.querySelector('.terminal-workspace__live')).toBeNull();

    act(() => useSessionStateStore.getState().setPaneState('a', 'busy'));
    // O outro agente trabalha, mas não está entre os desenhados.
    act(() => useSessionStateStore.getState().setPaneState('b', 'busy'));
    expect(host.querySelector('.terminal-workspace__live')?.textContent).toBe('1 trabalhando agora');
  });

  it('em paralelo quando dois dos desenhados trabalham, e some sem visibleIds', () => {
    const both = mount(<MissionWorkingChip panes={PANES} visibleIds={new Set(['a', 'b'])} />);
    act(() => {
      useSessionStateStore.getState().setPaneState('a', 'busy');
      useSessionStateStore.getState().setPaneState('b', 'busy');
    });
    expect(both.querySelector('.terminal-workspace__live')?.textContent).toBe(
      '2 trabalhando agora · em paralelo',
    );

    const none = mount(<MissionWorkingChip panes={PANES} visibleIds={null} />);
    expect(none.querySelector('.terminal-workspace__live')).toBeNull();
  });
});
