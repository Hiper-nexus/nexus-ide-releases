/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountInfo } from "../../shared/account-types";
import type { AdapterInfo } from "../../shared/types";
import type { ProviderSettingsInfo } from "../../shared/provider-settings-types";
import { HomeDeck } from "./HomeDeck";
import { LaunchScreen } from "./LaunchScreen";
import { MissionRail } from "./MissionRail";
import { ensureReadableCanvasSize } from "./canvas-pane-layout";
import { useHomeStore } from "../state/home-store";
import { useLayoutStore } from "../state/layout-store";
import { useMissionWizardStore } from "../state/mission-wizard-store";
import { useOrchStore } from "../state/orch-store";
import { useSessionStateStore } from "../state/session-state-store";
import { useSettingsStore } from "../state/settings-store";
import { useWorkspaceStore } from "../state/workspace-store";
import { setActiveWorkspacePath } from "../state/active-workspace";
import { buildGridTree, listPanes } from "../lib/split-tree";
import { INTEGRATIONS_CHANGED_EVENT } from "../lib/integrations-events";

vi.mock("../terminal/terminal-host", () => ({
  applyTerminalSettings: vi.fn(),
}));

const { livePaneIdsForMissionMock } = vi.hoisted(() => ({
  livePaneIdsForMissionMock: vi.fn((_id: string) => [] as string[]),
}));

vi.mock("../orch/mission-reopen", () => ({
  reopenMission: vi.fn(async () => ({ ok: true })),
  livePaneIdsForMission: (id: string) => livePaneIdsForMissionMock(id),
  hardReopenWouldDisplaceLayout: vi.fn(() => false),
  hardReopenWouldKillAgents: vi.fn(() => false),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const initialHome = useHomeStore.getState();
const initialLayout = useLayoutStore.getState();
const initialWizard = useMissionWizardStore.getState();
const initialOrch = useOrchStore.getState();
const initialSessions = useSessionStateStore.getState();
const initialSettings = useSettingsStore.getState();
const initialWorkspace = useWorkspaceStore.getState();

const ADAPTERS: AdapterInfo[] = Array.from({ length: 7 }, (_, index) => ({
  id: index === 0 ? "claude" : index === 1 ? "codex" : `adapter-${index}`,
  kind: "cli-pty",
  label: `Adapter ${index}`,
  icon: "A",
  models: { list: ["default"], default: "default" },
  installed: true,
  installCommand: "",
  idleTimeoutMs: 30_000,
  orchestratorCapable: index < 2,
  orchestrationEvidence: index < 2 ? "verified" : "unsupported",
  autonomousWorkspaceWriteCapable: index === 1,
  taskHandoffCapable: true,
  missionControlCapable: true,
  capabilities: {
    launchable: true,
    promptInjectable: true,
    statusObservable: true,
    resumable: true,
    autonomousReadOnly: index === 1,
    governedWriter: index === 1,
    verifiedMaestro: index < 2,
  },
}));

const PROVIDERS: ProviderSettingsInfo[] = ADAPTERS.map((adapter) => ({
  adapterId: adapter.id,
  label: adapter.label,
  icon: adapter.icon,
  kind: adapter.kind,
  enabled: true,
  installed: adapter.installed,
  canAutoInstall: false,
  binPath: "",
  detectedBin: adapter.id,
  defaultModel: adapter.models.default,
  models: adapter.models.list,
  authReadyModels: adapter.models.list,
  extraArgs: [],
  keyEnvVar: null,
  hasKey: false,
  keyMasked: null,
  authMethod: "oauth",
  secureStorageAvailable: true,
  authStrategy: "subscription",
  upstream: adapter.id,
  routable: false,
  upstreams: [],
  permissionMode: "",
  permissionModes: [],
  effort: "",
  efforts: [],
  verbose: false,
  supportsVerbose: false,
  customModels: [],
}));

const ACCOUNTS: AccountInfo[] = ADAPTERS.map((adapter, index) => ({
  id: `${adapter.id}-managed`,
  adapterId: adapter.id,
  label: `${adapter.label} gerenciada`,
  mode: "subscription",
  upstream: adapter.id,
  createdAt: index + 1,
  active: true,
  hasCredential: true,
  onCooldown: false,
}));

function setNexusApi(
  adapters: AdapterInfo[] | Error | Promise<AdapterInfo[]> = ADAPTERS,
  providers:
    | ProviderSettingsInfo[]
    | Error
    | Promise<ProviderSettingsInfo[]> = PROVIDERS,
  accounts: AccountInfo[] | Error | Promise<AccountInfo[]> = [],
): void {
  Object.defineProperty(window, "nexus", {
    configurable: true,
    value: {
      adapters: {
        list: vi.fn(async () => {
          if (adapters instanceof Error) throw adapters;
          return await adapters;
        }),
        onChanged: vi.fn(() => () => {}),
      },
      providers: {
        list: vi.fn(async () => {
          if (providers instanceof Error) throw providers;
          return await providers;
        }),
        onChanged: vi.fn(() => () => {}),
      },
      accounts: {
        list: vi.fn(async () => {
          if (accounts instanceof Error) throw accounts;
          return await accounts;
        }),
        onChanged: vi.fn(() => () => {}),
      },
      settings: {
        orchGet: vi.fn(async () => ({
          squadCliPolicy: "operator-choice",
        })),
      },
      orch: {
        removeMission: vi.fn(async () => ({ removed: true })),
      },
      update: {
        getState: vi.fn(async () => ({
          phase: "uptodate",
          source: "gh",
          currentVersion: "0.21.0",
          available: null,
          checkedAt: Date.now(),
          canInstall: false,
          error: null,
        })),
        onState: vi.fn(() => () => {}),
        check: vi.fn(async () => undefined),
        install: vi.fn(async () => undefined),
        restart: vi.fn(async () => undefined),
      },
    },
  });
}

function setReactiveNexusApi(
  initialAdapters: AdapterInfo[],
  initialProviders: ProviderSettingsInfo[],
  initialAccounts: AccountInfo[] = [],
) {
  let currentAdapters = initialAdapters;
  let currentProviders = initialProviders;
  let currentAccounts = initialAccounts;
  const adapterListeners = new Set<(next: AdapterInfo[]) => void>();
  const providerListeners = new Set<(next: ProviderSettingsInfo[]) => void>();
  const accountListeners = new Set<(next: AccountInfo[]) => void>();
  const adapterList = vi.fn(async () => currentAdapters);
  const providerList = vi.fn(async () => currentProviders);
  const accountList = vi.fn(async () => currentAccounts);

  Object.defineProperty(window, "nexus", {
    configurable: true,
    value: {
      adapters: {
        list: adapterList,
        onChanged: vi.fn((listener: (next: AdapterInfo[]) => void) => {
          adapterListeners.add(listener);
          return () => {
            adapterListeners.delete(listener);
          };
        }),
      },
      providers: {
        list: providerList,
        onChanged: vi.fn((listener: (next: ProviderSettingsInfo[]) => void) => {
          providerListeners.add(listener);
          return () => {
            providerListeners.delete(listener);
          };
        }),
      },
      accounts: {
        list: accountList,
        onChanged: vi.fn((listener: (next: AccountInfo[]) => void) => {
          accountListeners.add(listener);
          return () => {
            accountListeners.delete(listener);
          };
        }),
      },
      settings: {
        orchGet: vi.fn(async () => ({
          squadCliPolicy: "operator-choice",
        })),
      },
      orch: {
        removeMission: vi.fn(async () => ({ removed: true })),
      },
      update: {
        getState: vi.fn(async () => ({
          phase: "uptodate",
          source: "gh",
          currentVersion: "0.21.0",
          available: null,
          checkedAt: Date.now(),
          canInstall: false,
          error: null,
        })),
        onState: vi.fn(() => () => {}),
        check: vi.fn(async () => undefined),
        install: vi.fn(async () => undefined),
        restart: vi.fn(async () => undefined),
      },
    },
  });

  return {
    adapterList,
    providerList,
    accountList,
    emitAdapters(
      next: AdapterInfo[],
      providersForRefresh: ProviderSettingsInfo[] = currentProviders,
    ) {
      currentAdapters = next;
      currentProviders = providersForRefresh;
      for (const listener of [...adapterListeners]) listener(next);
    },
    emitProviders(next: ProviderSettingsInfo[]) {
      currentProviders = next;
      for (const listener of [...providerListeners]) listener(next);
    },
    emitAccounts(next: AccountInfo[]) {
      currentAccounts = next;
      for (const listener of [...accountListeners]) listener(next);
    },
    adapterSubscriberCount: () => adapterListeners.size,
    providerSubscriberCount: () => providerListeners.size,
    accountSubscriberCount: () => accountListeners.size,
  };
}

function mount(element: React.ReactElement): {
  host: HTMLDivElement;
  root: Root;
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, root };
}

describe("operational Home and Launch surfaces", () => {
  beforeEach(() => {
    sessionStorage.setItem("nexus.progressiveOnboarding.skipped", "1");
    setNexusApi();
    useOrchStore.setState({
      missions: [],
      squads: [],
      paneMissions: {},
      mcpInfo: { running: true, url: "http://127.0.0.1", toolCount: 71 },
    });
  });

  afterEach(() => {
    sessionStorage.clear();
    useHomeStore.setState(initialHome);
    useLayoutStore.setState(initialLayout);
    useMissionWizardStore.setState(initialWizard);
    useOrchStore.setState(initialOrch);
    useSessionStateStore.setState(initialSessions);
    useSettingsStore.setState(initialSettings);
    useWorkspaceStore.setState(initialWorkspace);
    Reflect.deleteProperty(window, "nexus");
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("makes resuming the last workspace the explicit next action", async () => {
    const open = vi.fn(async () => undefined);
    const openForNewWorkspace = vi.fn();
    useWorkspaceStore.setState({
      current: null,
      recents: [
        {
          name: "nexus-ide",
          path: "/Users/test/nexus-ide",
          lastOpenedAt: Date.now() - 60_000,
        },
      ],
      open,
    });
    useMissionWizardStore.setState({ openForNewWorkspace });

    const { host, root } = mount(<LaunchScreen />);
    await act(async () => {});

    expect(host.textContent).toContain("Próxima ação");
    expect(host.textContent).toContain("Continuar nexus-ide");
    expect(host.textContent).toContain("7 CLIs detectadas");
    expect(host.textContent).toContain(
      "Rota de missão autenticada e pronta",
    );
    expect(host.textContent).toContain("MCP online · 71 ferramentas");
    const topbarActions = host.querySelector(".launch__topbar-actions");
    expect(topbarActions?.textContent).toContain("Configurações");
    expect(
      topbarActions?.querySelector(
        'button[aria-label*="NexusIDE v0.21.0 está atualizado"]',
      ),
    ).not.toBeNull();

    const resume = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Continuar nexus-ide"),
    );
    await act(async () => resume?.click());
    expect(open).toHaveBeenCalledWith("/Users/test/nexus-ide");

    act(() => root.unmount());
  });

  it("opens the new-workspace flow with the standard command shortcut", async () => {
    const openForNewWorkspace = vi.fn();
    useWorkspaceStore.setState({ current: null, recents: [] });
    useMissionWizardStore.setState({ openForNewWorkspace });

    const { root } = mount(<LaunchScreen />);
    await act(async () => {});
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "o", metaKey: true }),
      );
    });

    expect(openForNewWorkspace).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("opens arbitrary folders only through the native authorized picker", async () => {
    const pick = vi.fn(async () => undefined);
    useWorkspaceStore.setState({ current: null, recents: [], pick });

    const { host, root } = mount(<LaunchScreen />);
    await act(async () => {});

    expect(host.querySelector("#launch-workspace-path")).toBeNull();
    expect(host.textContent).not.toContain("Abrir por caminho");
    expect(host.textContent).toContain(
      "Escolha outra pasta pelo seletor seguro do sistema",
    );

    const chooseFolder = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Escolher pasta"),
    );
    await act(async () => chooseFolder?.click());

    expect(pick).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("refreshes Launch readiness after provider setup without remounting", async () => {
    const blockedProviders = PROVIDERS.map((provider) => ({
      ...provider,
      authStrategy: "login-needed" as const,
      authReadyModels: [],
    }));
    const inventory = setReactiveNexusApi(ADAPTERS, blockedProviders);
    useWorkspaceStore.setState({ current: null, recents: [] });

    const { host, root } = mount(<LaunchScreen />);
    await act(async () => {});

    expect(host.textContent).toContain("Rota de missão requer configuração");
    expect(inventory.adapterList).toHaveBeenCalledOnce();
    expect(inventory.providerList).toHaveBeenCalledOnce();

    await act(async () => {
      inventory.emitProviders(PROVIDERS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      "Rota de missão autenticada e pronta",
    );
    expect(inventory.adapterList).toHaveBeenCalledTimes(2);
    expect(inventory.providerList).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
    expect(inventory.adapterSubscriberCount()).toBe(0);
    expect(inventory.providerSubscriberCount()).toBe(0);
    expect(inventory.accountSubscriberCount()).toBe(0);
  });

  it("refreshes Launch readiness after a managed account becomes usable", async () => {
    const blockedProviders = PROVIDERS.map((provider) => ({
      ...provider,
      authStrategy: "login-needed" as const,
      authReadyModels: [],
    }));
    const inventory = setReactiveNexusApi(ADAPTERS, blockedProviders);
    useWorkspaceStore.setState({ current: null, recents: [] });

    const { host, root } = mount(<LaunchScreen />);
    await act(async () => {});

    expect(host.textContent).toContain("Rota de missão requer configuração");

    await act(async () => {
      inventory.emitAccounts(ACCOUNTS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      "Rota de missão autenticada e pronta",
    );
    expect(inventory.accountList).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
    expect(inventory.accountSubscriberCount()).toBe(0);
  });

  it("leads with the goal and keeps technical readiness progressively disclosed", async () => {
    const openForAgentic = vi.fn();
    const openForMission = vi.fn();
    const pane = { id: "shell-1", kind: "shell" as const, title: "shell" };
    useHomeStore.setState({ visible: true });
    useMissionWizardStore.setState({ openForAgentic, openForMission });
    useWorkspaceStore.setState({
      current: {
        name: "nexus-ide",
        path: "/Users/test/nexus-ide",
        lastOpenedAt: Date.now(),
      },
    });
    useLayoutStore.setState({ root: buildGridTree([pane]) });

    const { host, root } = mount(<HomeDeck />);
    await act(async () => {});

    expect(host.textContent).toContain("Pronto para planejar");
    expect(host.textContent).toContain("7 CLIs detectadas");
    expect(host.textContent).toContain("7 CLIs autenticadas com handoff");
    expect(host.textContent).toContain("7 workers com handoff");
    expect(host.textContent).toContain("MCP online · 71 ferramentas");
    expect(host.textContent).toContain("Próxima ação");
    expect(host.textContent).toContain("O que você quer criar?");
    expect(host.textContent).toContain("Detalhes do ambiente e equipes salvas");
    const advanced = host.querySelector<HTMLDetailsElement>(
      ".home-deck__advanced",
    );
    expect(advanced?.open).toBe(false);

    const startMission = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Descrever objetivo"),
    );
    await act(async () => startMission?.click());
    expect(openForAgentic).toHaveBeenCalledOnce();
    expect(openForAgentic).toHaveBeenCalledWith();
    expect(openForMission).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("refreshes Home readiness after provider setup without remounting", async () => {
    const blockedProviders = PROVIDERS.map((provider) => ({
      ...provider,
      authStrategy: "login-needed" as const,
      authReadyModels: [],
    }));
    const inventory = setReactiveNexusApi(ADAPTERS, blockedProviders);
    const openForAgentic = vi.fn();
    const pane = { id: "shell-1", kind: "shell" as const, title: "shell" };
    useHomeStore.setState({ visible: true });
    useMissionWizardStore.setState({ openForAgentic });
    useWorkspaceStore.setState({
      current: {
        name: "nexus-ide",
        path: "/Users/test/nexus-ide",
        lastOpenedAt: Date.now(),
      },
    });
    useLayoutStore.setState({ root: buildGridTree([pane]) });

    const { host, root } = mount(<HomeDeck />);
    await act(async () => {});

    expect(host.textContent).toContain("Conclua a rota de execução");
    expect(host.textContent).toContain("Configurar execução");
    expect(inventory.adapterList).toHaveBeenCalledOnce();
    expect(inventory.providerList).toHaveBeenCalledOnce();

    await act(async () => {
      inventory.emitAdapters(ADAPTERS);
      inventory.emitProviders(PROVIDERS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain("Rota verificada");
    const startMission = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Descrever objetivo"),
    );
    act(() => startMission?.click());
    expect(openForAgentic).toHaveBeenCalledOnce();
    expect(inventory.adapterList).toHaveBeenCalledOnce();
    expect(inventory.providerList).toHaveBeenCalledOnce();

    act(() => root.unmount());
    expect(inventory.adapterSubscriberCount()).toBe(0);
    expect(inventory.providerSubscriberCount()).toBe(0);
    expect(inventory.accountSubscriberCount()).toBe(0);
  });

  it("reuses the hidden placeholder shell when opening the terminal from Home", async () => {
    const pane = {
      id: "shell-1",
      kind: "shell" as const,
      title: "shell",
      isStructuralPlaceholder: true as const,
    };
    useHomeStore.setState({ visible: true });
    useWorkspaceStore.setState({
      current: {
        name: "nexus-ide",
        path: "/Users/test/nexus-ide",
        lastOpenedAt: Date.now(),
      },
    });
    useLayoutStore.setState({
      root: buildGridTree([pane]),
      focusedPaneId: pane.id,
    });

    const { host, root } = mount(<HomeDeck />);
    await act(async () => {});

    const terminal = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Abrir terminal"),
    );
    await act(async () => terminal?.click());

    expect(useHomeStore.getState().visible).toBe(false);
    expect(
      listPanes(useLayoutStore.getState().root).map((item) => item.id),
    ).toEqual(["shell-1"]);
    expect(
      listPanes(useLayoutStore.getState().root)[0]?.isStructuralPlaceholder,
    ).toBeUndefined();

    act(() => root.unmount());
  });

  it("recommends provider setup instead of an impossible mission when no CLI exists", async () => {
    setNexusApi([]);
    const toggleDrawer = vi.fn();
    const pane = { id: "shell-1", kind: "shell" as const, title: "shell" };
    useSettingsStore.setState({ toggleDrawer });
    useHomeStore.setState({ visible: true });
    useWorkspaceStore.setState({
      current: {
        name: "nexus-ide",
        path: "/Users/test/nexus-ide",
        lastOpenedAt: Date.now(),
      },
    });
    useLayoutStore.setState({ root: buildGridTree([pane]) });

    const { host, root } = mount(<HomeDeck />);
    await act(async () => {});

    expect(host.textContent).toContain("Conecte uma IA para começar");
    const configure = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Conectar uma IA"),
    );
    await act(async () => configure?.click());
    expect(toggleDrawer).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });

  it("does not release the mission CTA for detected but unauthenticated binaries", async () => {
    setNexusApi(
      ADAPTERS,
      PROVIDERS.map((provider) => ({
        ...provider,
        authStrategy: "login-needed",
        authReadyModels: [],
      })),
    );
    const toggleDrawer = vi.fn();
    const openForAgentic = vi.fn();
    const pane = { id: "shell-1", kind: "shell" as const, title: "shell" };
    useSettingsStore.setState({ toggleDrawer });
    useMissionWizardStore.setState({ openForAgentic });
    useHomeStore.setState({ visible: true });
    useWorkspaceStore.setState({
      current: {
        name: "nexus-ide",
        path: "/Users/test/nexus-ide",
        lastOpenedAt: Date.now(),
      },
    });
    useLayoutStore.setState({ root: buildGridTree([pane]) });

    const { host, root } = mount(<HomeDeck />);
    await act(async () => {});

    expect(host.textContent).toContain("Conclua a rota de execução");
    expect(host.textContent).toContain("7 CLIs detectadas");
    expect(host.textContent).toContain(
      "Nenhuma CLI autenticada com handoff",
    );
    const configure = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Configurar execução"),
    );
    await act(async () => configure?.click());
    expect(toggleDrawer).toHaveBeenCalledOnce();
    expect(openForAgentic).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("shows an explicit retryable error when the provider catalog fails", async () => {
    setNexusApi(new Error("catálogo indisponível"));
    const pane = { id: "shell-1", kind: "shell" as const, title: "shell" };
    useHomeStore.setState({ visible: true });
    useWorkspaceStore.setState({
      current: {
        name: "nexus-ide",
        path: "/Users/test/nexus-ide",
        lastOpenedAt: Date.now(),
      },
    });
    useLayoutStore.setState({ root: buildGridTree([pane]) });

    const { host, root } = mount(<HomeDeck />);
    await act(async () => {});

    expect(host.textContent).toContain("Não consegui verificar suas IAs");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "catálogo indisponível",
    );
    expect(
      [...host.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Tentar novamente"),
      ),
    ).toBe(true);

    act(() => root.unmount());
  });

  it("keeps mission launch disabled while the provider catalog is loading", async () => {
    let resolveCatalog: ((adapters: AdapterInfo[]) => void) | undefined;
    setNexusApi(
      new Promise<AdapterInfo[]>((resolve) => {
        resolveCatalog = resolve;
      }),
    );
    const pane = { id: "shell-1", kind: "shell" as const, title: "shell" };
    useHomeStore.setState({ visible: true });
    useWorkspaceStore.setState({
      current: {
        name: "nexus-ide",
        path: "/Users/test/nexus-ide",
        lastOpenedAt: Date.now(),
      },
    });
    useLayoutStore.setState({ root: buildGridTree([pane]) });

    const { host, root } = mount(<HomeDeck />);
    await act(async () => {});

    expect(host.textContent).toContain("Verificando suas IAs");
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "Lendo os providers locais",
    );
    const loadingAction = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Verificando…"),
    );
    expect(loadingAction?.disabled).toBe(true);

    await act(async () => {
      resolveCatalog?.(ADAPTERS);
      await Promise.resolve();
    });
    act(() => root.unmount());
  });
});

describe("MissionRail operational hierarchy", () => {
  beforeEach(() => {
    setNexusApi();
  });

  afterEach(() => {
    useOrchStore.setState(initialOrch);
    useMissionWizardStore.setState(initialWizard);
    useSessionStateStore.setState(initialSessions);
    useWorkspaceStore.setState(initialWorkspace);
    setActiveWorkspacePath(null);
    Reflect.deleteProperty(window, "nexus");
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("groups open missions under Em progresso and queue under Na fila", () => {
    const openForAgentic = vi.fn();
    const openForMission = vi.fn();
    livePaneIdsForMissionMock.mockImplementation((id: string) =>
      id === "active" ? ["pane-1"] : [],
    );

    setActiveWorkspacePath("/ws/demo");
    useWorkspaceStore.setState({
      current: { path: "/ws/demo", name: "demo", lastOpenedAt: 1 },
      hydrated: true,
    });
    useOrchStore.setState({
      missions: [
        {
          id: "active",
          title: "Corrigir Jarvis",
          description: "",
          status: "running",
          milestones: [],
          learnings: "",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "newer",
          title: "Polir interface",
          description: "",
          status: "pending",
          milestones: [],
          learnings: "",
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      paneMissions: { "pane-1": "active" },
      boundWorkspacePath: "/ws/demo",
    });
    useSessionStateStore.setState({
      paneStates: new Map([["pane-1", "busy"]]),
    });
    useMissionWizardStore.setState({ openForAgentic, openForMission });

    const { host, root } = mount(<MissionRail />);
    const text = host.textContent ?? "";

    expect(text).toMatch(/Missões/);
    expect(text).toMatch(/demo/);
    expect(text).toMatch(/Em progresso/);
    expect(text).toMatch(/Na fila/);
    expect(text).toContain("Corrigir Jarvis");
    expect(text).toContain("Polir interface");
    expect(text).toContain("Retomar");
    // Live open mission shows as working, not only "na fila"
    expect(text).toMatch(/trabalhando|em progresso|rodando/i);
    // O rail monitora; a única CTA global de criação fica na WorkspaceBar.
    expect(text).toMatch(/Em progresso|Na fila|Sala limpa/);
    expect(text).not.toMatch(/Nova missão/);
    expect(
      host.querySelector<HTMLButtonElement>(".mission-rail__new--primary"),
    ).toBeNull();
    expect(openForAgentic).not.toHaveBeenCalled();
    expect(openForMission).not.toHaveBeenCalled();

    act(() => root.unmount());
    setActiveWorkspacePath(null);
  });

  it("does not touch credential-backed issue providers during passive mount", async () => {
    const hasGithubToken = vi.fn(async () => true);
    const hasLinearKey = vi.fn(async () => true);
    const listGithubIssues = vi.fn(async () => ({ ok: true, issues: [] }));
    const listLinearIssues = vi.fn(async () => ({ ok: true, issues: [] }));
    Object.assign(window.nexus, {
      integrations: {
        hasGithubToken,
        hasLinearKey,
        listGithubIssues,
        listLinearIssues,
      },
    });
    setActiveWorkspacePath("/ws/demo");
    useWorkspaceStore.setState({
      current: { path: "/ws/demo", name: "demo", lastOpenedAt: 1 },
      hydrated: true,
    });
    useOrchStore.setState({
      missions: [],
      paneMissions: {},
      boundWorkspacePath: "/ws/demo",
    });

    const { root } = mount(<MissionRail />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(hasGithubToken).not.toHaveBeenCalled();
    expect(hasLinearKey).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event(INTEGRATIONS_CHANGED_EVENT));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hasGithubToken).toHaveBeenCalledOnce();
    expect(hasLinearKey).toHaveBeenCalledOnce();
    expect(listGithubIssues).toHaveBeenCalledOnce();
    expect(listLinearIssues).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });

  it("gives plan promotion and blocking separate action slots", () => {
    setActiveWorkspacePath("/ws/demo");
    useWorkspaceStore.setState({
      current: { path: "/ws/demo", name: "demo", lastOpenedAt: 1 },
      hydrated: true,
    });
    useOrchStore.setState({
      missions: [
        {
          id: "plan-pending",
          title: "Planejar autenticação",
          description: "Preparar PRD e plano",
          status: "pending",
          intentState: "ready_to_start",
          milestones: [],
          learnings: "",
          createdAt: 1,
          updatedAt: 1,
          intentContract: {
            version: 1,
            source: "typed",
            goal: "Preparar autenticação",
            acceptanceCriteria: ["Plano validado"],
            risk: "normal",
            executionMode: "autopilot",
            lane: "plan",
            intentVersion: 1,
            contextPolicy: "on-demand",
            budgets: {
              planningTokens: 8_000,
              executionTokens: 6_000,
              maxWorkers: 0,
              maxSteps: 64,
            },
          },
        },
      ],
      paneMissions: {},
      boundWorkspacePath: "/ws/demo",
    });

    const { host, root } = mount(<MissionRail />);
    const row = host.querySelector<HTMLElement>(
      '.mission-rail__row[data-action-count="4"]',
    );
    const actionGroup = row?.querySelector<HTMLElement>(
      ".mission-rail__row-actions",
    );
    const promote = actionGroup?.querySelector<HTMLButtonElement>(
      '[aria-label="Executar plano da missão Planejar autenticação"]',
    );
    const block = actionGroup?.querySelector<HTMLButtonElement>(
      '[aria-label="Encerrar missão Planejar autenticação como bloqueada"]',
    );

    expect(row).not.toBeNull();
    expect(actionGroup?.getAttribute("role")).toBe("group");
    expect(actionGroup?.querySelectorAll("button")).toHaveLength(4);
    expect(promote).not.toBeNull();
    expect(block).not.toBeNull();
    expect(promote).not.toBe(block);
    expect(promote?.classList).toContain("mission-rail__row-action--promote");
    expect(block?.classList).toContain("mission-rail__row-action--block");

    act(() => root.unmount());
  });
});

describe("Canvas pane readability", () => {
  it("never renders a terminal pane below the readable operating size", () => {
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
