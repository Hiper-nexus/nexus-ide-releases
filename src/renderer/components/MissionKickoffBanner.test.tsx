/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { MissionKickoffBanner } from './MissionKickoffBanner';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function mission(patch: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    title: 'Landing page',
    status: 'running',
    createdAt: 1_000,
    updatedAt: 2_000,
    ...patch,
  } as Mission;
}

describe('MissionKickoffBanner', () => {
  let host: HTMLDivElement;
  let root: Root;

  let previousRoot: ReturnType<typeof useLayoutStore.getState>['root'];

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // O jornal fica indisponível no teste: o banner cai na copy estática.
    (window as unknown as { nexus?: unknown }).nexus = { orch: {} };
    // O root padrão é uma vaga estrutural (que já narra o boot); o banner
    // existe para telas com panes reais — simule um shell do operador.
    previousRoot = useLayoutStore.getState().root;
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-shell',
        pane: { id: 'pane-shell', kind: 'shell', title: 'shell' },
      },
    } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useLayoutStore.setState({ root: previousRoot } as never);
    useOrchStore.setState({ missions: [], paneMissions: {} });
    vi.useRealTimers();
  });

  it('aparece durante o bootstrap e mostra a etapa/fallback', () => {
    useOrchStore.setState({ missions: [mission()], paneMissions: {} });
    act(() => root.render(<MissionKickoffBanner />));
    expect(host.textContent).toContain('Landing page');
    expect(host.textContent).toContain('preparando os agentes');
    expect(host.querySelector('.kickoff-banner__spinner')).not.toBeNull();
  });

  it('some quando o primeiro pane da missão abre', () => {
    useOrchStore.setState({ missions: [mission()], paneMissions: {} });
    act(() => root.render(<MissionKickoffBanner />));
    expect(host.querySelector('.kickoff-banner')).not.toBeNull();
    act(() => {
      useOrchStore.setState({ paneMissions: { 'pane-a': 'mission-1' } });
    });
    expect(host.querySelector('.kickoff-banner')).toBeNull();
  });

  it('missão bloqueada mostra o aviso, não o spinner', () => {
    useOrchStore.setState({
      missions: [mission({ status: 'blocked' })],
      paneMissions: {},
    });
    act(() => root.render(<MissionKickoffBanner />));
    expect(host.querySelector('.kickoff-banner--blocked')).not.toBeNull();
    expect(host.querySelector('.kickoff-banner__spinner')).toBeNull();
  });

  it('"Ver missão" abre o diagnóstico', () => {
    const openMissionDetail = vi.fn();
    useOrchStore.setState({
      missions: [mission()],
      paneMissions: {},
      openMissionDetail,
    } as never);
    act(() => root.render(<MissionKickoffBanner />));
    const button = host.querySelector('.kickoff-banner__action');
    expect(button).not.toBeNull();
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(openMissionDetail).toHaveBeenCalledWith('mission-1');
  });

  it('sem missão em voo, não renderiza nada', () => {
    useOrchStore.setState({
      missions: [mission({ status: 'done' })],
      paneMissions: {},
    });
    act(() => root.render(<MissionKickoffBanner />));
    expect(host.querySelector('.kickoff-banner')).toBeNull();
  });
});

describe('MissionKickoffBanner + layout', () => {
  it('cede a vez quando o grid é uma vaga estrutural', () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    (window as unknown as { nexus?: unknown }).nexus = { orch: {} };

    const previousRoot = useLayoutStore.getState().root;
    useOrchStore.setState({ missions: [mission()], paneMissions: {} });
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-vacancy',
        pane: {
          id: 'pane-vacancy',
          kind: 'shell',
          title: 'shell',
          isStructuralPlaceholder: true,
        },
      },
    } as never);

    act(() => root.render(<MissionKickoffBanner />));
    expect(host.querySelector('.kickoff-banner')).toBeNull();

    act(() => root.unmount());
    host.remove();
    useLayoutStore.setState({ root: previousRoot } as never);
    useOrchStore.setState({ missions: [], paneMissions: {} });
    vi.useRealTimers();
  });
});
