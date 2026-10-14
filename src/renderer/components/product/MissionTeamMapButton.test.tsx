/** @vitest-environment jsdom */
import { Profiler, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../../shared/types';
import type { PaneScopeEntry } from '../../lib/pane-spaces';
import {
  __resetSessionStateDisplayTimersForTests,
  useSessionStateStore,
} from '../../state/session-state-store';
import {
  MissionTeamMapButton,
  missionTeamOfScope,
  type MissionTeamMap,
} from './MissionTeamMapButton';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const space = (patch: Partial<PaneScopeEntry>): PaneScopeEntry => ({
  key: 'space:a',
  kind: 'space',
  id: 'a',
  title: 'Checkout',
  paneCount: 1,
  missions: [],
  orchestrator: null,
  ...patch,
});

const PANES: PaneModel[] = [
  { id: 'pane-shell', kind: 'shell', title: 'shell', missionId: 'm' },
  { id: 'pane-worker', kind: 'cli-agent', title: 'Codex', adapterId: 'codex', missionId: 'm' },
  { id: 'pane-host', kind: 'cli-agent', title: 'Claude', adapterId: 'claude', role: 'orchestrator', missionId: 'm' },
  { id: 'pane-adopted', kind: 'cli-agent', title: 'GLM', adapterId: 'glm' },
  { id: 'pane-other', kind: 'cli-agent', title: 'Kimi', adapterId: 'kimi', missionId: 'outra' },
];

const TEAM: MissionTeamMap = {
  missionId: 'm',
  title: 'Fechar o Epic 22',
  members: [
    { paneId: 'pane-host', coordinator: true },
    { paneId: 'pane-worker', coordinator: false },
    { paneId: 'pane-adopted', coordinator: false },
  ],
};

let mounted: { root: Root; host: HTMLElement } | null = null;

function render(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  mounted = { root, host };
  return host;
}

function setStates(states: Record<string, 'spawning' | 'busy' | 'idle' | 'exited' | 'hibernated'>): void {
  useSessionStateStore.setState({
    paneStates: new Map(Object.entries(states)),
    displayStates: new Map(Object.entries(states)),
  });
}

afterEach(() => {
  if (mounted) act(() => mounted!.root.unmount());
  mounted = null;
  document.body.innerHTML = '';
  __resetSessionStateDisplayTimersForTests();
  useSessionStateStore.setState({ paneStates: new Map(), displayStates: new Map() });
});

describe('missionTeamOfScope', () => {
  it('a aba que hospeda a missão traz os agentes dela, coordenador primeiro', () => {
    const scope = space({ missions: [{ id: 'm', title: 'Fechar o Epic 22', state: 'running' }] });

    const team = missionTeamOfScope(scope, PANES, { 'pane-adopted': 'm' });

    expect(team).toEqual(TEAM);
  });

  it('a aba de missão usa a própria missão', () => {
    const scope = space({ key: 'mission:m', kind: 'mission', id: 'm', title: 'Fechar o Epic 22' });

    expect(missionTeamOfScope(scope, PANES, {})?.members.map((member) => member.paneId)).toEqual([
      'pane-host',
      'pane-worker',
    ]);
  });

  it('com duas missões na aba, mostra a que está rodando', () => {
    const scope = space({
      missions: [
        { id: 'outra', title: 'Antiga', state: 'completed' },
        { id: 'm', title: 'Fechar o Epic 22', state: 'running' },
      ],
    });

    expect(missionTeamOfScope(scope, PANES, {})?.missionId).toBe('m');
  });

  it('aba sem missão, ou missão sem agente aberto, não tem mapa', () => {
    expect(missionTeamOfScope(space({}), PANES, {})).toBeNull();
    expect(
      missionTeamOfScope(space({ missions: [{ id: 'vazia', title: 'Vazia', state: 'running' }] }), PANES, {}),
    ).toBeNull();
  });
});

describe('MissionTeamMapButton', () => {
  it('rótulo claro, um rack por agente com terminal aberto e o resumo em palavras', () => {
    setStates({ 'pane-host': 'idle', 'pane-worker': 'busy', 'pane-adopted': 'exited' });

    const host = render(<MissionTeamMapButton team={TEAM} onOpen={vi.fn()} />);

    const button = host.querySelector('button')!;
    expect(button.textContent).toContain('Mapa da equipe');
    const racks = [...host.querySelectorAll('.workspace-tabs__team-rack')];
    expect(racks.map((rack) => rack.getAttribute('data-state'))).toEqual(['idle', 'working']);
    expect(racks[0]!.hasAttribute('data-coordinator')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe(
      'Abrir o mapa da equipe de “Fechar o Epic 22”: coordenador e 1 agente, 1 trabalhando',
    );
    expect(button.title).toContain('Os terminais continuam rodando');
    expect(button.hasAttribute('data-live')).toBe(true);
  });

  it('pane sem estado conhecido ainda está iniciando', () => {
    setStates({ 'pane-host': 'idle', 'pane-worker': 'idle' });

    const host = render(<MissionTeamMapButton team={TEAM} onOpen={vi.fn()} />);

    expect(
      [...host.querySelectorAll('.workspace-tabs__team-rack')].map((rack) => rack.getAttribute('data-state')),
    ).toEqual(['idle', 'idle', 'starting']);
    expect(host.querySelector('button')!.getAttribute('aria-label')).toMatch(
      /coordenador e 2 agentes, 1 iniciando$/,
    );
  });

  it('ninguém trabalhando nem iniciando: a equipe está em espera', () => {
    setStates({ 'pane-host': 'idle', 'pane-worker': 'idle', 'pane-adopted': 'hibernated' });

    const host = render(<MissionTeamMapButton team={TEAM} onOpen={vi.fn()} />);

    expect(host.querySelector('button')!.getAttribute('aria-label')).toMatch(
      /coordenador e 1 agente, em espera$/,
    );
    expect(host.querySelector('button')!.hasAttribute('data-live')).toBe(false);
  });

  it('equipe grande resume o excedente em vez de alargar a barra', () => {
    const members = Array.from({ length: 11 }, (_, index) => ({
      paneId: `p${index}`,
      coordinator: index === 0,
    }));
    setStates(Object.fromEntries(members.map((member) => [member.paneId, 'busy' as const])));

    const host = render(<MissionTeamMapButton team={{ ...TEAM, members }} onOpen={vi.fn()} />);

    expect(host.querySelectorAll('.workspace-tabs__team-rack')).toHaveLength(8);
    expect(host.querySelector('.workspace-tabs__team-more')?.textContent).toBe('+3');
  });

  it('clicar abre o mapa daquela missão', () => {
    const onOpen = vi.fn();
    const host = render(<MissionTeamMapButton team={TEAM} onOpen={onOpen} />);

    act(() => host.querySelector('button')!.click());

    expect(onOpen).toHaveBeenCalledWith('m');
  });

  it('só redesenha quando um agente da equipe muda de estado, nunca por pane alheio', () => {
    setStates({ 'pane-host': 'idle', 'pane-worker': 'idle' });
    const commits = vi.fn();
    render(
      <Profiler id="team-map" onRender={commits}>
        <MissionTeamMapButton team={TEAM} onOpen={vi.fn()} />
      </Profiler>,
    );
    commits.mockClear();

    act(() => useSessionStateStore.getState().setPaneState('pane-outra-aba', 'busy'));
    expect(commits).not.toHaveBeenCalled();

    act(() => useSessionStateStore.getState().setPaneState('pane-worker', 'busy'));
    expect(commits).toHaveBeenCalledTimes(1);
  });
});
