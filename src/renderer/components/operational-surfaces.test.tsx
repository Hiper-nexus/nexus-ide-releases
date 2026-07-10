/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterInfo } from '../../shared/types';
import { HomeDeck } from './HomeDeck';
import { LaunchScreen } from './LaunchScreen';
import { MissionRail } from './MissionRail';
import { ensureReadableCanvasSize } from './canvas-pane-layout';
import { useHomeStore } from '../state/home-store';
import { useLayoutStore } from '../state/layout-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useOrchStore } from '../state/orch-store';
import { useSessionStateStore } from '../state/session-state-store';
import { useSettingsStore } from '../state/settings-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { buildGridTree } from '../lib/split-tree';

vi.mock('../terminal/terminal-host', () => ({
  applyTerminalSettings: vi.fn(),
}));

vi.mock('../orch/mission-reopen', () => ({
  reopenMission: vi.fn(async () => ({ ok: true })),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const initialHome = useHomeStore.getState();
const initialLayout = useLayoutStore.getState();
const initialWizard = useMissionWizardStore.getState();
const initialOrch = useOrchStore.getState();
const initialSessions = useSessionStateStore.getState();
const initialSettings = useSettingsStore.getState();
const initialWorkspace = useWorkspaceStore.getState();

const ADAPTERS: AdapterInfo[] = Array.from({ length: 7 }, (_, index) => ({
  id: `adapter-${index}`,
  kind: 'cli-pty',
  label: `Adapter ${index}`,
  icon: 'A',
  models: { list: ['default'], default: 'default' },
  installed: true,
  installCommand: '',
  idleTimeoutMs: 30_000,
  orchestratorCapable: false,
}));

function setNexusApi(adapters: AdapterInfo[] = ADAPTERS): void {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      adapters: { list: vi.fn(async () => adapters) },
      orch: {
        removeMission: vi.fn(async () => ({ removed: true })),
      },
    },
  });
}

function mount(element: React.ReactElement): {
  host: HTMLDivElement;
  root: Root;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, root };
}

describe('operational Home and Launch surfaces', () => {
  beforeEach(() => {
    setNexusApi();
    useOrchStore.setState({
      missions: [],
      squads: [],
      paneMissions: {},
      mcpInfo: { running: true, url: 'http://127.0.0.1', toolCount: 71 },
    });
  });

  afterEach(() => {
    useHomeStore.setState(initialHome);
    useLayoutStore.setState(initialLayout);
    useMissionWizardStore.setState(initialWizard);
    useOrchStore.setState(initialOrch);
    useSessionStateStore.setState(initialSessions);
    useSettingsStore.setState(initialSettings);
    useWorkspaceStore.setState(initialWorkspace);
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('makes resuming the last workspace the explicit next action', async () => {
    const open = vi.fn(async () => undefined);
    const openForNewWorkspace = vi.fn();
    useWorkspaceStore.setState({
      current: null,
      recents: [
        {
          name: 'nexus-ide',
          path: '/Users/test/nexus-ide',
          lastOpenedAt: Date.now() - 60_000,
        },
      ],
      open,
    });
    useMissionWizardStore.setState({ openForNewWorkspace });

    const { host, root } = mount(<LaunchScreen />);
    await act(async () => {});

    expect(host.textContent).toContain('Próxima ação');
    expect(host.textContent).toContain('Continuar nexus-ide');
    expect(host.textContent).toContain('7 CLIs prontas');
    expect(host.textContent).toContain('MCP online · 71 ferramentas');

    const resume = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Continuar nexus-ide'),
    );
    await act(async () => resume?.click());
    expect(open).toHaveBeenCalledWith('/Users/test/nexus-ide');

    act(() => root.unmount());
  });

  it('opens the new-workspace flow with the standard command shortcut', async () => {
    const openForNewWorkspace = vi.fn();
    useWorkspaceStore.setState({ current: null, recents: [] });
    useMissionWizardStore.setState({ openForNewWorkspace });

    const { root } = mount(<LaunchScreen />);
    await act(async () => {});
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'o', metaKey: true }),
      );
    });

    expect(openForNewWorkspace).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it('states what is live and recommends starting a mission in Home', async () => {
    const pane = { id: 'shell-1', kind: 'shell' as const, title: 'shell' };
    useHomeStore.setState({ visible: true });
    useWorkspaceStore.setState({
      current: {
        name: 'nexus-ide',
        path: '/Users/test/nexus-ide',
        lastOpenedAt: Date.now(),
      },
    });
    useLayoutStore.setState({ root: buildGridTree([pane]) });

    const { host, root } = mount(<HomeDeck />);
    await act(async () => {});

    expect(host.textContent).toContain('Base operacional pronta');
    expect(host.textContent).toContain('7 CLIs prontas');
    expect(host.textContent).toContain('MCP online · 71 ferramentas');
    expect(host.textContent).toContain('Próxima ação');
    expect(host.textContent).toContain('Iniciar missão');

    act(() => root.unmount());
  });

  it('recommends provider setup instead of an impossible mission when no CLI exists', async () => {
    setNexusApi([]);
    const toggleDrawer = vi.fn();
    const pane = { id: 'shell-1', kind: 'shell' as const, title: 'shell' };
    useSettingsStore.setState({ toggleDrawer });
    useHomeStore.setState({ visible: true });
    useWorkspaceStore.setState({
      current: {
        name: 'nexus-ide',
        path: '/Users/test/nexus-ide',
        lastOpenedAt: Date.now(),
      },
    });
    useLayoutStore.setState({ root: buildGridTree([pane]) });

    const { host, root } = mount(<HomeDeck />);
    await act(async () => {});

    expect(host.textContent).toContain('Conecte uma CLI para operar');
    const configure = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Configurar provider'),
    );
    await act(async () => configure?.click());
    expect(toggleDrawer).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });
});

describe('MissionRail operational hierarchy', () => {
  beforeEach(() => {
    setNexusApi();
  });

  afterEach(() => {
    useOrchStore.setState(initialOrch);
    useMissionWizardStore.setState(initialWizard);
    useSessionStateStore.setState(initialSessions);
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('pins the open mission first and reports live pane activity', () => {
    useOrchStore.setState({
      missions: [
        {
          id: 'active',
          title: 'Corrigir Jarvis',
          description: '',
          status: 'running',
          milestones: [],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'newer',
          title: 'Polir interface',
          description: '',
          status: 'pending',
          milestones: [],
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      paneMissions: { 'pane-1': 'active' },
    });
    useSessionStateStore.setState({ paneStates: new Map([['pane-1', 'busy']]) });

    const { host, root } = mount(<MissionRail />);
    const missionButtons = [...host.querySelectorAll<HTMLButtonElement>('.mission-rail__item')];

    expect(host.textContent).toContain('1 ativa de 2');
    expect(missionButtons[0].textContent).toContain('Corrigir Jarvis');
    expect(missionButtons[0].textContent).toContain('1 pane trabalhando');
    expect(missionButtons[0].getAttribute('aria-current')).toBe('true');
    expect(missionButtons[1].textContent).toContain('Retomar');

    act(() => root.unmount());
  });
});

describe('Canvas pane readability', () => {
  it('never renders a terminal pane below the readable operating size', () => {
    expect(ensureReadableCanvasSize({ width: 280, height: 200 })).toEqual({
      width: 440,
      height: 300,
    });
    expect(ensureReadableCanvasSize({ width: 720, height: 480 })).toEqual({
      width: 720,
      height: 480,
    });
  });
});
