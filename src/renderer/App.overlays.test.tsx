/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccessStore } from './state/access-store';
import { useOnboardingStore } from './state/onboarding-store';
import { DEFAULT_LICENSE } from '../shared/billing-types';

const browserHost = vi.hoisted(() => ({
  reconcileBrowserPanes: vi.fn(),
  setBrowserPaneSuppression: vi.fn(),
}));

const layoutEffects = vi.hoisted(() => ({
  detachWorkspaceLayout: vi.fn(),
  switchWorkspaceLayoutWithFallback: vi.fn(
    () => Promise.withResolvers<boolean>().promise,
  ),
}));

vi.mock('./state/layout-store', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  detachWorkspaceLayout: layoutEffects.detachWorkspaceLayout,
  switchWorkspaceLayoutWithFallback:
    layoutEffects.switchWorkspaceLayoutWithFallback,
}));
vi.mock('./state/workspace-store', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  useWorkspaceController: () => undefined,
}));
vi.mock('./state/settings-store', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  useSettingsController: () => undefined,
}));
vi.mock('./state/gamification-store', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  useGamificationSync: () => undefined,
}));
vi.mock('./state/provider-store', () => ({
  useProviderController: () => undefined,
}));
vi.mock('./state/account-store', () => ({
  useAccountController: () => undefined,
}));
vi.mock('./state/cost-store', () => ({ useCostController: () => undefined }));
vi.mock('./state/usage-store', () => ({ useUsageSync: () => undefined }));
vi.mock('./state/quota-store', async (importActual) => ({
  ...(await importActual<typeof import('./state/quota-store')>()),
  useQuotaSync: () => undefined,
}));
vi.mock('./orch/failover-controller', () => ({
  useFailoverController: () => undefined,
}));
vi.mock('./orch/account-restart-controller', () => ({
  useAccountRestartController: () => undefined,
}));
vi.mock('./orch/worker-spawn-failed-controller', () => ({
  useWorkerSpawnFailedController: () => undefined,
}));
vi.mock('./orch/orch-bridge', () => ({ useOrchBridge: () => undefined }));
vi.mock('./voice/voice-controller', () => ({
  useVoiceController: () => undefined,
}));
vi.mock('./state/dev-server-store', () => ({
  initDevServerStore: () => undefined,
}));
vi.mock('./state/design-selection-store', () => ({
  initDesignSelectionStore: () => undefined,
}));
vi.mock('./orch/restore-agents-gate', () => ({
  gateRestoredAgents: vi.fn(async () => undefined),
  resetRestoredAgentsGate: vi.fn(),
}));
vi.mock('./terminal/terminal-host', () => ({ reconcileHosts: vi.fn() }));
vi.mock('./browser/browser-host', () => browserHost);
vi.mock('./terminal/pane-close-guard', () => ({ requestPaneClose: vi.fn() }));
vi.mock('./lib/progressive-launch', () => ({
  applyProgressiveLaunchIfPending: vi.fn(() => false),
}));
vi.mock('./lib/use-product-flags', () => ({ useProductFlags: () => ({}) }));

vi.mock('./components/product/AppShell', () => ({
  AppShell: ({
    rail,
    header,
    content,
    inspector,
    overlays,
  }: {
    rail: ReactNode;
    header?: ReactNode;
    content: ReactNode;
    inspector?: ReactNode;
    overlays?: ReactNode;
  }) => (
    <div data-testid="app-shell">
      {rail}
      {header}
      <main>{content}</main>
      {inspector}
      <div data-testid="root-overlays">{overlays}</div>
    </div>
  ),
}));
vi.mock('./components/product/WorkspaceRail', () => ({
  WorkspaceRail: () => <nav aria-label="Destinos do Nexus" />,
}));
vi.mock('./components/mission/MissionSetup', () => ({
  MissionSetup: () => <section aria-label="Preparar missão" />,
}));
vi.mock('./components/mission/MissionBoard', () => ({
  MissionBoard: () => <section aria-label="Quadro da missão" />,
}));
vi.mock('./components/product/TerminalWorkspace', () => ({
  TerminalWorkspace: () => <section aria-label="Terminais" />,
}));
vi.mock('./components/product/TaskBoardWorkspace', () => ({
  TaskBoardWorkspace: () => <section aria-label="Quadro" />,
}));
vi.mock('./components/product/MemoryWorkspace', () => ({
  MemoryWorkspace: () => <section aria-label="Memória" />,
}));
vi.mock('./components/settings/SettingsWorkspace', () => ({
  SettingsWorkspace: () => <section aria-label="Configurações" />,
}));
vi.mock('./components/ContextualPanel', () => ({
  ContextualPanel: () => null,
}));
vi.mock('./components/product/ProductPanelBodies', () => ({
  EditorPanelBody: () => null,
  MarketplacePanelBody: () => null,
  MemoryPanelBody: () => null,
  SearchPanelBody: () => null,
  SkillsPanelBody: () => null,
}));
vi.mock('./components/product/MissionJournalPanel', () => ({
  MissionJournalPanel: () => null,
}));
vi.mock('./components/FanoutComparePanel', () => ({
  FanoutComparePanel: () => null,
}));
vi.mock('./components/GitPanelBody', () => ({ GitPanelBody: () => null }));
vi.mock('./components/AgentNotifications', () => ({
  AgentNotifications: () => null,
}));
vi.mock('./components/VoiceHud', () => ({ VoiceHud: () => null }));
vi.mock('./components/VoiceSettings', () => ({ VoiceSettings: () => null }));
vi.mock('./components/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('./components/KeyboardCheatsheet', () => ({
  KeyboardCheatsheet: () => null,
}));
vi.mock('./components/AttentionInbox', () => ({ AttentionInbox: () => null }));
vi.mock('./components/CloseWorkspaceDialog', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  CloseWorkspaceDialog: () => null,
}));
vi.mock('./components/Toasts', () => ({ Toasts: () => null }));
vi.mock('./components/NexusMark', () => ({ NexusMark: () => null }));
vi.mock('./components/PixelIcon', () => ({ PixelIcon: () => null }));
vi.mock('./components/ChosenPetPortrait', () => ({
  ChosenPetPortrait: () => null,
}));
vi.mock('./overlay/overlay-layer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { App } from './App';
import { PANE_SKILL_DRAG_TYPE } from './lib/pane-interactions';
import { useCloseWorkspaceStore } from './components/CloseWorkspaceDialog';
import { EMPTY_GAMIFICATION_SNAPSHOT, useGamificationStore } from './state/gamification-store';
import { useLayoutStore } from './state/layout-store';
import { useMediaStudioStore } from './state/media-studio-store';
import { useOrchStore } from './state/orch-store';
import { useOrchestrationModeStore } from './state/orchestration-mode-store';
import { useProductNavigationStore } from './state/product-navigation-store';
import { useMissionSetupStore } from './state/mission-setup-store';
import { useToastStore } from './state/toast-store';
import { useWorkspaceStore } from './state/workspace-store';
import { useCommandPaletteStore } from './state/command-palette-store';
import { useConfirmStore } from './state/confirm-store';
import { useCheatsheetStore } from './state/cheatsheet-store';
import { useBugReportDialogStore } from './state/bug-report-dialog-store';
import { useVoiceStore } from './voice/voice-store';
import {
  assessTerminalVisibility,
  listBlockingOverlayLabels,
  readUiVisibilityState,
} from './voice/terminal-visibility';
import { currentScreenSnapshot } from './voice/jarvis-screen-context';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const originalNexusDescriptor = Object.getOwnPropertyDescriptor(window, 'nexus');
const MODE_REPORT = /modo(?: de)? orquestra|orchestration mode/iu;
const MEDIA_REPORT = /estúdio de mídia|media studio/iu;
const PROFILE_REPORT = /perfil(?: de)? operador|operator profile/iu;

function mountApp(): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<App />));
}

function dialogContaining(text: string): HTMLElement | null {
  return (
    Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
    ).find(
      (dialog) =>
        dialog.textContent?.includes(text) ||
        dialog.getAttribute('aria-label')?.includes(text),
    ) ?? null
  );
}

/**
 * Os painéis raiz viraram React.lazy (80c30b24f): o primeiro commit puxa o
 * chunk e o diálogo só entra no DOM depois. Espera a condição observável — o
 * diálogo montado — em vez de contar ticks, como o diff do Pierre (e540c2dc6).
 */
async function dialogWhenMounted(text: string): Promise<HTMLElement> {
  return vi.waitFor(
    async () => {
      await act(async () => {});
      const dialog = dialogContaining(text);
      if (!dialog) throw new Error(`diálogo "${text}" ainda não montou`);
      return dialog;
    },
    { timeout: 10_000, interval: 5 },
  );
}

function lastBrowserSuppression(): boolean | undefined {
  return browserHost.setBrowserPaneSuppression.mock.calls.at(-1)?.[1];
}

function blockingLabels(): string {
  return listBlockingOverlayLabels(readUiVisibilityState().overlays).join(' ');
}

function terminalVisibility() {
  return assessTerminalVisibility(
    'pane-shell',
    readUiVisibilityState(),
    true,
  );
}

beforeEach(() => {
  useAccessStore.setState({ canUseApp: true, loading: false, maxAgents: null, cloudSync: true, blockedReason: null });
  vi.clearAllMocks();
  // Wizard de first-run fechado: com role=dialog aria-modal aberto, os
  // atalhos globais e o menu Ajuda não disparam (guarda em App.tsx).
  vi.spyOn(useOnboardingStore.getState(), 'hydrate').mockImplementation(() => {
    useOnboardingStore.setState({ hydrated: true, wizardOpen: false });
  });
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    writable: true,
    value: {
      app: { onDeepOpenPath: vi.fn(() => vi.fn()), onDeepOpenQuota: vi.fn(() => vi.fn()), onDeepOpenNew: vi.fn(() => vi.fn()), onShotFilesReceived: vi.fn(() => vi.fn()) },
      billing: {
        onChanged: vi.fn(() => vi.fn()),
        get: vi.fn(async () => ({ ...DEFAULT_LICENSE, plan: 'pro', status: 'active', access: 'pro', verified: true, canUseApp: true, blockedReason: null, expiresAt: new Date(Date.now() + 3600000).toISOString(), limits: { maxAgents: null, cloudSync: true } })),
      },
      pet: {
        onOpenSettings: vi.fn(() => vi.fn()),
        onOpenOps: vi.fn(() => vi.fn()),
        onAttention: vi.fn(() => vi.fn()),
      },
      media: {
        listProviders: vi.fn(() => Promise.withResolvers().promise),
        listArtifacts: vi.fn(() => Promise.withResolvers().promise),
        readArtifactDataUrl: vi.fn(async () => ({ ok: false })),
        generate: vi.fn(),
        cancelGenerate: vi.fn(),
        revealArtifact: vi.fn(),
      },
      files: {
        importMissionAttachment: vi.fn(async (name: string) => ({
          ok: true,
          path: `.nexus/attachments/mission-context/token-${name}`,
        })),
        importDroppedUri: vi.fn(async (uri: string) => ({
          ok: true,
          path: `.nexus/attachments/mission-context/token-${uri.split('/').at(-1)}`,
        })),
        pathForFile: vi.fn(() => '/Users/me/Desktop/fora-do-projeto.m4a'),
      },
    },
  });

  useWorkspaceStore.setState({
    current: {
      path: '/tmp/nexus-overlays',
      name: 'Nexus Overlays',
      lastOpenedAt: 1,
    },
    recents: [],
    hydrated: true,
  });
  useLayoutStore.setState({
    hydrated: true,
    focusedPaneId: 'pane-shell',
    root: {
      kind: 'split',
      id: 'split-live',
      direction: 'row',
      children: [
        {
          kind: 'leaf',
          id: 'leaf-shell',
          pane: { id: 'pane-shell', kind: 'shell', title: 'Terminal' },
        },
        {
          kind: 'leaf',
          id: 'leaf-browser',
          pane: {
            id: 'pane-browser',
            kind: 'browser',
            title: 'Preview',
            browserUrl: 'https://example.test',
          },
        },
      ],
    },
  } as never);
  useProductNavigationStore.setState({
    destination: { kind: 'terminal' },
    settingsReturnDestination: null,
  });
  useOrchStore.setState({
    missions: [],
    missionSummaries: [],
    squads: [],
    boundWorkspacePath: null,
  } as never);
  useOrchestrationModeStore.setState({ pending: null, queue: [] });
  useMediaStudioStore.setState({ open: false });
  useGamificationStore.setState({
    snapshot: EMPTY_GAMIFICATION_SNAPSHOT,
    sober: false,
    profileOpen: false,
  });
  useCloseWorkspaceStore.setState({ open: false } as never);
  useCommandPaletteStore.setState({ open: false });
  useConfirmStore.setState({ pending: null });
  useCheatsheetStore.setState({ open: false });
  useBugReportDialogStore.setState({ isOpen: false });
  useVoiceStore.setState({ settingsOpen: false } as never);
});

afterEach(() => {
  act(() => {
    const mode = useOrchestrationModeStore.getState();
    if (mode.pending) mode.decide(null);
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  if (originalNexusDescriptor) {
    Object.defineProperty(window, 'nexus', originalNexusDescriptor);
  } else {
    Reflect.deleteProperty(window, 'nexus');
  }
});

describe('App bug report entry', () => {
  function installBugReportBridge(): { open: () => void; unsubscribe: ReturnType<typeof vi.fn> } {
    const bridge = { open: () => {}, unsubscribe: vi.fn() };
    Object.assign(window.nexus, {
      bugReport: {
        onOpenRequest: vi.fn((callback: () => void) => {
          bridge.open = callback;
          return bridge.unsubscribe;
        }),
        preview: vi.fn(),
        submit: vi.fn(),
      },
    });
    return bridge;
  }

  it('opens "Reportar um problema" when the Ajuda menu asks for it, and Escape closes it', async () => {
    const bridge = installBugReportBridge();
    mountApp();
    await act(async () => {});
    expect(dialogContaining('Reportar um problema')).toBeNull();

    act(() => bridge.open());
    const dialog = await dialogWhenMounted('Reportar um problema');

    act(() => {
      dialog.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(dialogContaining('Reportar um problema')).toBeNull();
  });
  it('places the report beneath the interactive hard confirmation', async () => {
    const bridge = installBugReportBridge(); mountApp(); await act(async () => {});
    act(() => bridge.open());
    const report = await dialogWhenMounted('Reportar um problema');
    let confirmed!: Promise<boolean>;
    act(() => { confirmed = useConfirmStore.getState().ask({ title: 'Descartar relato', body: 'Descartar alterações?', confirmLabel: 'Descartar' }); });
    const confirmation = document.querySelector('[role="alertdialog"]')!;
    expect(report.compareDocumentPosition(confirmation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const button = [...confirmation.querySelectorAll('button')].find(item => item.textContent === 'Descartar')!;
    act(() => button.click());
    await expect(confirmed).resolves.toBe(true);
  });
  it('does not steal focus from an existing confirmation when the report opens', async () => {
    const bridge = installBugReportBridge(); mountApp(); await act(async () => {});
    let decision!: Promise<boolean>;
    act(() => { decision = useConfirmStore.getState().ask({ title: 'Pergunta pendente', body: 'Continuar?', confirmLabel: 'Continuar' }); });
    const focused = document.activeElement;
    act(() => bridge.open());
    // O relato é lazy: espera o diálogo montado para que "não roubar o foco"
    // seja afirmado sobre um diálogo que existe.
    await dialogWhenMounted('Reportar um problema');
    expect(document.activeElement).toBe(focused);
    act(() => useConfirmStore.getState().decide(false));
    await expect(decision).resolves.toBe(false);
    expect(dialogContaining('Reportar um problema')?.contains(document.activeElement)).toBe(true);
  });

  it('counts as a blocking overlay: reported to voice and the live browser pane steps aside', async () => {
    const bridge = installBugReportBridge();
    mountApp();
    await act(async () => {});
    expect(lastBrowserSuppression()).toBe(false);

    act(() => bridge.open());
    expect(blockingLabels()).toMatch(/reportar um problema/);
    expect(terminalVisibility().visible).toBe(false);
    expect(lastBrowserSuppression()).toBe(true);

    act(() => useBugReportDialogStore.getState().close());
    expect(blockingLabels()).not.toMatch(/reportar um problema/);
    expect(lastBrowserSuppression()).toBe(false);
  });

  it('stays reachable while access is blocked (license and billing problems are reports too)', async () => {
    const bridge = installBugReportBridge();
    mountApp();
    await act(async () => {});
    act(() =>
      useAccessStore.setState({ canUseApp: false, loading: false, blockedReason: 'inactive' } as never),
    );
    act(() => bridge.open());
    await dialogWhenMounted('Reportar um problema');
    expect(dialogContaining('Reportar um problema')).not.toBeNull();
  });

  it('unsubscribes from the menu request on unmount', async () => {
    const bridge = installBugReportBridge();
    mountApp();
    await act(async () => {});
    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps working with a preload that has no bug report bridge', async () => {
    mountApp();
    await act(async () => {});
    expect(dialogContaining('Reportar um problema')).toBeNull();
  });
});

describe('App root blocking overlays', () => {
  it('mounts pending Mode as the reported blocking surface, suppresses the live browser pane, and restores both on resolve', async () => {
    mountApp();
    // O billing.get do refresh resolve num microtask após o mount — flushing
    // garante canUseApp antes dos overlays gated por licença.
    await act(async () => {});
    expect(lastBrowserSuppression()).toBe(false);
    expect(terminalVisibility()).toEqual({ visible: true, reasons: [] });

    let decision!: Promise<unknown>;
    act(() => {
      decision = useOrchestrationModeStore.getState().ask({
        title: 'Executar plano',
        body: 'Escolha Pack ou Guiado para continuar.',
        storyCount: 3,
        recommended: 'pack',
        templateRequiredForPack: false,
      });
    });

    expect(dialogContaining('Executar plano')).not.toBeNull();
    expect(blockingLabels()).toMatch(MODE_REPORT);
    expect(terminalVisibility().visible).toBe(false);
    expect(currentScreenSnapshot().context).toMatch(MODE_REPORT);
    expect(lastBrowserSuppression()).toBe(true);

    await act(async () => {
      useOrchestrationModeStore.getState().decide(null);
      await decision;
    });

    expect(dialogContaining('Executar plano')).toBeNull();
    expect(blockingLabels()).not.toMatch(MODE_REPORT);
    expect(terminalVisibility()).toEqual({ visible: true, reasons: [] });
    expect(currentScreenSnapshot().context).not.toMatch(MODE_REPORT);
    expect(lastBrowserSuppression()).toBe(false);
  });

  it('mounts open Media as the reported blocking surface, suppresses the live browser pane, and restores both on close', async () => {
    mountApp();
    await act(async () => {});
    expect(lastBrowserSuppression()).toBe(false);

    act(() => useMediaStudioStore.getState().show());

    await dialogWhenMounted('Estúdio de Mídia');
    expect(blockingLabels()).toMatch(MEDIA_REPORT);
    expect(terminalVisibility().visible).toBe(false);
    expect(currentScreenSnapshot().context).toMatch(MEDIA_REPORT);
    expect(lastBrowserSuppression()).toBe(true);

    act(() => useMediaStudioStore.getState().hide());

    expect(dialogContaining('Estúdio de Mídia')).toBeNull();
    expect(blockingLabels()).not.toMatch(MEDIA_REPORT);
    expect(terminalVisibility()).toEqual({ visible: true, reasons: [] });
    expect(currentScreenSnapshot().context).not.toMatch(MEDIA_REPORT);
    expect(lastBrowserSuppression()).toBe(false);
  });

  it('mounts profileOpen as visible DOM, reports it only while mounted, and suppresses the live browser pane', async () => {
    mountApp();
    await act(async () => {});
    expect(lastBrowserSuppression()).toBe(false);

    act(() => useGamificationStore.setState({ profileOpen: true }));

    const profile = await dialogWhenMounted('Perfil de Operador');
    expect(profile?.textContent).toContain('Operador em modo recruta');
    expect(blockingLabels()).toMatch(PROFILE_REPORT);
    expect(terminalVisibility().visible).toBe(false);
    expect(currentScreenSnapshot().context).toMatch(PROFILE_REPORT);
    expect(lastBrowserSuppression()).toBe(true);

    act(() => useGamificationStore.getState().closeProfile());

    expect(dialogContaining('Perfil de Operador')).toBeNull();
    expect(blockingLabels()).not.toMatch(PROFILE_REPORT);
    expect(terminalVisibility()).toEqual({ visible: true, reasons: [] });
    expect(currentScreenSnapshot().context).not.toMatch(PROFILE_REPORT);
    expect(lastBrowserSuppression()).toBe(false);
  });
});

/**
 * O intake de arrastar/soltar/colar do shell. O overlay `.global-drop-overlay`
 * ficava preso porque quem o acende (`App`) o limpava por um listener de
 * `window` que um filho com `stopPropagation` (picker, pane) nunca deixa
 * chegar. Ver o plano da correção.
 */
describe('intake de arrastar/soltar/colar no shell', () => {
  function setMissionSetupDestination(): void {
    act(() => {
      useProductNavigationStore.setState({
        destination: { kind: 'mission-setup' },
      });
    });
  }

  function clearToasts(): void {
    act(() => {
      const store = useToastStore.getState();
      for (const toast of [...store.toasts]) store.dismiss(toast.id);
    });
  }

  interface TransferInit {
    readonly types: readonly string[];
    readonly files?: readonly File[];
    readonly data?: Record<string, string>;
  }

  function transfer(init: TransferInit) {
    return {
      types: init.types,
      files: init.files ?? [],
      getData: (type: string) => init.data?.[type] ?? '',
    };
  }

  function fire(type: string, target: EventTarget, init: TransferInit): Event {
    const event = Object.assign(
      new Event(type, { bubbles: true, cancelable: true }),
      { dataTransfer: transfer(init) },
    );
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  function overlay(): Element | null {
    return document.querySelector('.global-drop-overlay');
  }

  function toastDetails(): string {
    return useToastStore
      .getState()
      .toasts.map((toast) => `${toast.title} ${toast.detail ?? ''}`)
      .join(' | ');
  }

  // O store do wizard é módulo-level: sem reset, o que um teste anexa vaza
  // para o seguinte.
  const missionSetupInitial = useMissionSetupStore.getState();

  beforeEach(() => {
    clearToasts();
    act(() => {
      useMissionSetupStore.setState(missionSetupInitial, true);
    });
  });

  it('some com o overlay quando um filho consome o drop (picker/pane param a propagação)', () => {
    mountApp();
    setMissionSetupDestination();
    fire('dragover', window, { types: ['Files'] });
    expect(overlay()).not.toBeNull();

    const child = document.querySelector('[data-testid="app-shell"]')!;
    child.addEventListener('drop', (event) => event.stopPropagation());
    fire('drop', child, {
      types: ['Files'],
      files: [new File(['bytes'], 'clipe.m4a', { type: 'audio/mp4' })],
    });

    expect(overlay()).toBeNull();
  });

  it('some com o overlay quando o arraste é cancelado sem drop', () => {
    vi.useFakeTimers();
    try {
      mountApp();
      setMissionSetupDestination();
      fire('dragover', window, { types: ['Files'] });
      expect(overlay()).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(overlay()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('some com o overlay ao sair da janela mesmo com relatedTarget não-nulo', () => {
    mountApp();
    setMissionSetupDestination();
    fire('dragover', window, { types: ['Files'] });
    expect(overlay()).not.toBeNull();

    act(() => {
      window.dispatchEvent(
        Object.assign(new Event('dragleave', { bubbles: true }), {
          relatedTarget: document.body,
          clientX: -5,
          clientY: 40,
        }),
      );
    });

    expect(overlay()).toBeNull();
  });

  it('anexa pelo endereço quando o arraste traz a promessa e não o arquivo', async () => {
    mountApp();
    setMissionSetupDestination();
    const uri = 'file:///Users/ana/foto%20de%20perfil.png';

    fire('dragover', window, { types: ['Files', 'text/uri-list'] });
    await act(async () => {
      window.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
          dataTransfer: transfer({
            types: ['Files', 'text/uri-list'],
            data: { 'text/uri-list': uri },
          }),
        }),
      );
    });

    expect(window.nexus.files.importDroppedUri).toHaveBeenCalledWith(uri);
    expect(useMissionSetupStore.getState().draft.contextPaths).toEqual([
      '.nexus/attachments/mission-context/token-foto%20de%20perfil.png',
    ]);
  });

  it('avisa em vez de silenciar quando nada do arraste é aproveitável', () => {
    mountApp();
    setMissionSetupDestination();
    fire('drop', window, { types: ['Files'] });

    // F-1579: o gerenciador de arquivos citado depende do sistema.
    expect(toastDetails()).toContain('no disco e arraste do');
  });

  it('não acende o overlay nem importa no arraste interno de skill', () => {
    mountApp();
    setMissionSetupDestination();
    fire('dragover', window, { types: [PANE_SKILL_DRAG_TYPE] });
    expect(overlay()).toBeNull();

    fire('drop', window, { types: [PANE_SKILL_DRAG_TYPE] });
    expect(window.nexus.files.importDroppedUri).not.toHaveBeenCalled();
    expect(toastDetails()).not.toContain('no disco e arraste do');
  });

  it('não reivindica arraste de texto puro (a textarea mantém a inserção nativa)', () => {
    mountApp();
    setMissionSetupDestination();
    const event = fire('drop', window, {
      types: ['text/plain'],
      data: { 'text/plain': 'um parágrafo arrastado' },
    });

    expect(event.defaultPrevented).toBe(false);
    expect(toastDetails()).not.toContain('no disco e arraste do');
  });

  it('anexa imagem colada mesmo sem o wizard montado', async () => {
    mountApp();
    setMissionSetupDestination();
    const image = new File(['bytes'], 'image.png', { type: 'image/png' });
    const clipboardData = {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      files: [image],
    };

    await act(async () => {
      window.dispatchEvent(
        Object.assign(new Event('paste', { bubbles: true, cancelable: true }), {
          clipboardData,
        }),
      );
    });

    expect(window.nexus.files.importMissionAttachment).toHaveBeenCalledTimes(1);
    expect(useMissionSetupStore.getState().draft.contextPaths).toHaveLength(1);
  });
});
