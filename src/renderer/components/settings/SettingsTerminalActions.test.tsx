/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterInfo } from '../../../shared/types';
import type { NonSettingsProductDestination } from '../../state/product-navigation-store';
import { buildGridTree } from '../../lib/split-tree';
import { useAccountStore } from '../../state/account-store';
import { useLayoutStore } from '../../state/layout-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { EMPTY_USAGE_SNAPSHOT, useUsageStore } from '../../state/usage-store';
import { AccountsManager } from './AccountsManager';
import { LlmsSection } from './CatalogSections';

const terminal = vi.hoisted(() => ({
  waitForSession: vi.fn(),
  writeToPane: vi.fn(),
}));

vi.mock('../../terminal/terminal-host', () => terminal);

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const ORIGINS: ReadonlyArray<{
  label: string;
  destination: NonSettingsProductDestination;
}> = [
  { label: 'Launcher', destination: { kind: 'launcher' } },
  { label: 'Terminal', destination: { kind: 'terminal' } },
  { label: 'Mission Setup', destination: { kind: 'mission-setup' } },
  {
    label: 'Mission Board',
    destination: { kind: 'mission', missionId: 'mission-origin', surface: 'board' },
  },
  {
    label: 'Mission Terminals',
    destination: {
      kind: 'mission',
      missionId: 'mission-origin',
      surface: 'terminals',
    },
  },
  { label: 'Task Board', destination: { kind: 'task-board' } },
  { label: 'Memory', destination: { kind: 'memory' } },
];

const installableAdapter: AdapterInfo = {
  id: 'codex',
  kind: 'cli-pty',
  label: 'Codex',
  icon: 'C',
  models: { list: [], default: '' },
  installed: false,
  orchestratorCapable: true,
  orchestrationEvidence: 'verified',
  installCommand: 'npm install -g @openai/codex',
  idleTimeoutMs: 800,
};

let roots: Root[] = [];
let resolveSession: ((sessionId: string | null) => void) | null = null;

function mount(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

function enterSettings(origin: NonSettingsProductDestination): void {
  useProductNavigationStore.setState({
    destination: origin,
    settingsReturnDestination: null,
  });
  useProductNavigationStore.getState().openSettings('providers');
}

function createdPaneId(): string {
  const call = terminal.waitForSession.mock.calls.at(-1);
  if (!call?.[0]) throw new Error('terminal session was not requested');
  return call[0] as string;
}

async function settleReady(sessionId: string | null): Promise<void> {
  await act(async () => {
    resolveSession?.(sessionId);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  terminal.waitForSession.mockReset();
  terminal.writeToPane.mockReset();
  terminal.waitForSession.mockImplementation(
    () =>
      new Promise<string | null>((resolve) => {
        resolveSession = resolve;
      }),
  );
  useLayoutStore.setState({
    root: buildGridTree([{ id: 'shell-origin', kind: 'shell', title: 'Terminal' }]),
    focusedPaneId: 'shell-origin',
    maximizedPaneId: null,
    hydrated: true,
    viewKind: 'grid',
  });
  useAccountStore.setState({
    accounts: [],
    quota: [],
    restartAdapterId: null,
    restartLabel: null,
  });
  useUsageStore.setState({ snapshot: EMPTY_USAGE_SNAPSHOT });
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      providers: {
        authStatus: vi.fn(async () => [
          { adapterId: 'claude', state: 'missing', detail: 'Login necessário.' },
        ]),
      },
      accounts: {
        supportsSnapshot: vi.fn(async () => ({ ok: true, supported: false })),
      },
      pty: { write: vi.fn(), onData: vi.fn(() => vi.fn()) },
    },
  });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'nexus');
  resolveSession = null;
  vi.clearAllMocks();
});

describe('Settings terminal-producing actions', () => {
  it.each(ORIGINS)(
    'Catalog install waits for readiness, then reveals and focuses its terminal from $label',
    async ({ destination }) => {
      enterSettings(destination);
      const host = mount(<LlmsSection adapters={[installableAdapter]} />);

      act(() => button(host, 'Instalar').click());

      expect(useProductNavigationStore.getState().destination).toEqual({
        kind: 'settings',
        section: 'providers',
      });
      const paneId = createdPaneId();

      await settleReady('session-install');

      expect(terminal.writeToPane).toHaveBeenCalledWith(
        paneId,
        `${installableAdapter.installCommand}\n`,
      );
      expect(useLayoutStore.getState().focusedPaneId).toBe(paneId);
      expect(useProductNavigationStore.getState()).toMatchObject({
        destination: { kind: 'terminal' },
        settingsReturnDestination: null,
      });
    },
  );

  it.each(ORIGINS)(
    'Catalog install retains Settings and announces readiness failure from $label',
    async ({ destination }) => {
      enterSettings(destination);
      const host = mount(<LlmsSection adapters={[installableAdapter]} />);
      act(() => button(host, 'Instalar').click());

      await settleReady(null);

      expect(useProductNavigationStore.getState()).toMatchObject({
        destination: { kind: 'settings', section: 'providers' },
        settingsReturnDestination: destination,
      });
      const announcement = [...host.querySelectorAll('[role="alert"], [role="status"]')]
        .map((node) => node.textContent ?? '')
        .join(' ');
      expect(announcement).toMatch(/terminal.*(não|falh|indispon)/i);
    },
  );

  it.each(ORIGINS)(
    'Accounts login waits for readiness, then reveals and focuses its terminal from $label',
    async ({ destination }) => {
      enterSettings(destination);
      const host = mount(
        <AccountsManager adapterId="claude" adapterLabel="Claude" />,
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      act(() => button(host, 'Abrir login da CLI').click());

      expect(useProductNavigationStore.getState().destination).toEqual({
        kind: 'settings',
        section: 'providers',
      });
      const paneId = createdPaneId();

      await settleReady('session-login');

      // Login operacional (14/08): o comando entra pelo mesmo caminho do
      // painel de CLIs — terminal.writeToPane no pane de login.
      expect(terminal.writeToPane).toHaveBeenCalledWith(
        paneId,
        expect.stringMatching(/claude/i),
      );
      expect(useLayoutStore.getState().focusedPaneId).toBe(paneId);
      expect(useProductNavigationStore.getState()).toMatchObject({
        destination: { kind: 'terminal' },
        settingsReturnDestination: null,
      });
    },
  );

  it.each(ORIGINS)(
    'Accounts login retains Settings and announces readiness failure from $label',
    async ({ destination }) => {
      enterSettings(destination);
      const host = mount(
        <AccountsManager adapterId="claude" adapterLabel="Claude" />,
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => button(host, 'Abrir login da CLI').click());

      await settleReady(null);

      expect(useProductNavigationStore.getState()).toMatchObject({
        destination: { kind: 'settings', section: 'providers' },
        settingsReturnDestination: destination,
      });
      const announcement = [...host.querySelectorAll('[role="alert"], [role="status"]')]
        .map((node) => node.textContent ?? '')
        .join(' ');
      expect(announcement).toMatch(
        /terminal não ficou disponível|login não foi iniciado/i,
      );
    },
  );
});
