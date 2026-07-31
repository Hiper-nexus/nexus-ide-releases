/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  effectiveMissionReviewGoal,
  MissionWizard,
} from "./MissionWizard";
import { useMissionWizardStore } from "../state/mission-wizard-store";
import { useOrchStore } from "../state/orch-store";
import { useWorkspaceStore } from "../state/workspace-store";
import { useProviderStore } from "../state/provider-store";
import { useToastStore } from "../state/toast-store";
import type { Mission, Squad } from "../../shared/orch-types";
import type { AdapterInfo } from "../../shared/types";
import type { ProviderSettingsInfo } from "../../shared/provider-settings-types";
import type { SquadLaunchOptions } from "../orch/mission-launcher";
import { NEXUS_PLAN_SQUAD_ID } from "../../shared/builtin-squad-ids";
import { setActiveWorkspacePath } from "../state/active-workspace";

const launcherMocks = vi.hoisted(() => ({
  launchSquadMission: vi.fn(),
}));

const productWizardE2EMocks = vi.hoisted(() => ({
  recordStep: vi.fn(async () => undefined),
}));

const layoutMocks = vi.hoisted(() => ({
  hasAttachedWorkspaceLayout: vi.fn(() => true),
  prepareWorkspaceLayoutSwitch: vi.fn(() => null as string | null),
  switchWorkspaceLayout: vi.fn(async (_path: string) => true),
}));

vi.mock("../orch/mission-launcher", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../orch/mission-launcher")>();
  return {
    ...actual,
    launchSquadMission: launcherMocks.launchSquadMission,
  };
});

vi.mock("../lib/real-mission-product-wizard-e2e", () => ({
  recordRealMissionProductWizardStep: productWizardE2EMocks.recordStep,
}));

vi.mock("../state/layout-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/layout-store")>();
  return {
    ...actual,
    hasAttachedWorkspaceLayout: layoutMocks.hasAttachedWorkspaceLayout,
    prepareWorkspaceLayoutSwitch: layoutMocks.prepareWorkspaceLayoutSwitch,
    switchWorkspaceLayout: layoutMocks.switchWorkspaceLayout,
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const initialWizard = useMissionWizardStore.getState();
const initialOrch = useOrchStore.getState();
const initialWorkspace = useWorkspaceStore.getState();
const initialProviders = useProviderStore.getState();
const mountedRoots = new Set<Root>();

describe("effectiveMissionReviewGoal", () => {
  it("uses the agentic intent before missionGoal is compiled", () => {
    expect(
      effectiveMissionReviewGoal({
        mode: "agentic",
        intent: "Todos os panes devem responder em paralelo",
        missionGoal: "",
      }),
    ).toBe("Todos os panes devem responder em paralelo");
  });

  it("keeps the explicit mission goal in saved-squad review", () => {
    expect(
      effectiveMissionReviewGoal({
        mode: "squad",
        intent: "rascunho",
        missionGoal: "Objetivo aprovado",
      }),
    ).toBe("Objetivo aprovado");
  });
});

const squad: Squad = {
  id: "squad-1",
  name: "Test Squad",
  orchestratorInstructions: "Orch.",
  agents: [
    {
      id: "orch",
      agentName: "Orch",
      category: "orchestrator",
      cli: "claude",
    },
  ],
  createdAt: "1",
  builtin: false,
};

const guidedBuiltinSquad: Squad = {
  ...squad,
  id: "agentic-guided-template",
  name: "Guided template",
  builtin: true,
  agents: squad.agents.map((agent) => ({ ...agent })),
};

const planningBuiltinSquad: Squad = {
  ...squad,
  id: NEXUS_PLAN_SQUAD_ID,
  name: "Planejamento & PRD",
  builtin: true,
  orchestratorInstructions:
    "# Planejamento & PRD\nEntregue PRD, arquitetura e stories; não escreva código.",
  agents: squad.agents.map((agent) => ({ ...agent })),
};

const claudeAdapter: AdapterInfo = {
  id: "claude",
  kind: "cli-pty",
  label: "Claude",
  icon: "C",
  models: { list: ["sonnet"], default: "sonnet" },
  installed: true,
  orchestratorCapable: true,
  taskHandoffCapable: true,
  missionControlCapable: true,
  autonomousWorkspaceWriteCapable: true,
  orchestrationEvidence: "verified",
  capabilities: {
    launchable: true,
    promptInjectable: true,
    statusObservable: true,
    resumable: true,
    autonomousReadOnly: true,
    governedWriter: true,
    verifiedMaestro: true,
  },
  installCommand: "",
  idleTimeoutMs: 1_000,
};

const codexAdapter: AdapterInfo = {
  ...claudeAdapter,
  id: "codex",
  label: "Codex",
  models: { list: ["gpt-5.6-sol"], default: "gpt-5.6-sol" },
  autonomousWorkspaceWriteCapable: true,
};

function provider(adapter: AdapterInfo): ProviderSettingsInfo {
  return {
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
  };
}

beforeEach(() => {
  productWizardE2EMocks.recordStep.mockClear();
  layoutMocks.prepareWorkspaceLayoutSwitch.mockReset();
  layoutMocks.prepareWorkspaceLayoutSwitch.mockReturnValue(null);
  layoutMocks.hasAttachedWorkspaceLayout.mockReset();
  layoutMocks.hasAttachedWorkspaceLayout.mockReturnValue(true);
  layoutMocks.switchWorkspaceLayout.mockReset();
  layoutMocks.switchWorkspaceLayout.mockResolvedValue(true);
  useProviderStore.setState({
    providers: [provider(claudeAdapter), provider(codexAdapter)],
  });
});

afterEach(() => {
  setActiveWorkspacePath(null);
  useProviderStore.setState(initialProviders);
});

/** Objetivo que a heurística sugere como lane ops (backup/VPS/subir). */
const OPS_GOAL = "fazer backup na VPS e subir a landing page";

const submitMissionIntent = vi.fn(async (input: { goal: string }) => ({
  id: "mission-armed-1",
  title: "Test",
  description: input.goal,
  status: "pending" as const,
  milestones: [],
  learnings: "",
  intentState: "awaiting_approval" as const,
  intentVersion: 1,
  intentContract: {
    version: 1 as const,
    source: "typed" as const,
    goal: input.goal,
    acceptanceCriteria: [],
    risk: "normal" as const,
    executionMode: "assisted" as const,
    contextPolicy: "on-demand" as const,
    intentVersion: 1,
    budgets: { planningTokens: 100, executionTokens: 100, maxWorkers: 1 },
  },
  createdAt: 1,
  updatedAt: 1,
}));

function mount(element: React.ReactElement): {
  host: HTMLDivElement;
  root: Root;
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.add(root);
  act(() => root.render(element));
  return { host, root };
}

function cleanupMountedRoots(): void {
  act(() => {
    for (const root of mountedRoots) root.unmount();
  });
  mountedRoots.clear();
  document.body.innerHTML = "";
}

function typeGoal(host: HTMLElement, value: string): void {
  const textarea = host.querySelector("textarea");
  if (!textarea) throw new Error("goal textarea not rendered");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("textarea value setter unavailable");
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`button "${label}" not found`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function clickButtonAndFlush(
  host: HTMLElement,
  label: string,
): Promise<void> {
  const button = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`button "${label}" not found`);
  if (button.disabled) {
    throw new Error(
      `button "${label}" is disabled: ${button.getAttribute("title") ?? "no reason"}`,
    );
  }
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function submitAndFlush(host: HTMLElement): Promise<void> {
  clickButton(host, "Continuar para aprovação");
  await act(async () => {});
}

describe("MissionWizard lane default (sem restrições)", () => {
  beforeEach(() => {
    submitMissionIntent.mockClear();
    launcherMocks.launchSquadMission.mockReset();
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        adapters: { list: vi.fn(async () => []) },
        settings: { orchGet: vi.fn(async () => ({})) },
        orch: {
          submitMissionIntent,
          getMissionPromptQueue: vi.fn(async () => null),
        },
      },
    });
    useOrchStore.setState({ squads: [squad], missions: [], paneMissions: {} });
    useMissionWizardStore
      .getState()
      .openForArmedMission("squad-1", "mission-armed-1");
  });

  afterEach(() => {
    cleanupMountedRoots();
    setActiveWorkspacePath(null);
    useMissionWizardStore.setState(initialWizard);
    useOrchStore.setState(initialOrch);
    Reflect.deleteProperty(window, "nexus");
    vi.restoreAllMocks();
  });

  it("applies the suggested lane on autopilot with advanced collapsed", async () => {
    const { host } = mount(<MissionWizard />);
    await act(async () => {});

    // Seção avançada colapsada por padrão: sem jargão de lanes na vista.
    expect(host.textContent).toContain("Opções avançadas");
    expect(host.textContent).not.toContain("Sem restrições (recomendado)");
    expect(host.textContent).not.toContain("Sugerido pelo objetivo");

    typeGoal(host, OPS_GOAL);
    await act(async () => {});
    // A sugestão vale mesmo com a seção fechada — com um chip visível e
    // reversível em vez de silenciosamente cair no grafo de entrega.
    expect(host.textContent).toContain("Modo: Só infra");
    await submitAndFlush(host);

    expect(submitMissionIntent).toHaveBeenCalledOnce();
    expect(submitMissionIntent.mock.calls[0]?.[0]).toMatchObject({
      goal: OPS_GOAL,
      lane: "ops",
    });
  });

  it("marks the plan-review submission as wizard-verified and lands on the review", async () => {
    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    typeGoal(host, OPS_GOAL);
    await act(async () => {});

    await clickButtonAndFlush(host, "Revisar plano");

    expect(submitMissionIntent).toHaveBeenCalledOnce();
    expect(submitMissionIntent).toHaveBeenCalledWith(
      expect.objectContaining({ planReviewSurface: "product-wizard" }),
    );
    expect(host.textContent).toContain("REVISÃO DA MISSÃO");
  });

  it("keeps the direct native-approval route unmarked", async () => {
    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    typeGoal(host, OPS_GOAL);
    await act(async () => {});

    await submitAndFlush(host);

    expect(submitMissionIntent).toHaveBeenCalledOnce();
    expect(submitMissionIntent.mock.calls[0]?.[0]).not.toHaveProperty(
      "planReviewSurface",
    );
  });

  it("shows the goal suggestion only inside the advanced section", async () => {
    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    typeGoal(host, OPS_GOAL);
    await act(async () => {});

    expect(host.textContent).not.toContain("Sugerido pelo objetivo");

    clickButton(host, "Opções avançadas");
    await act(async () => {});

    expect(host.textContent).toContain("Sem restrições (recomendado)");
    expect(host.textContent).toContain("Só pesquisar (não muda nada)");
    expect(host.textContent).toContain("Só planejar (escreve apenas o plano)");
    expect(host.textContent).toContain(
      "Só infra (não edita código do projeto)",
    );
    expect(host.textContent).toContain("Sugerido pelo objetivo");
  });

  it("applies the goal suggestion inside advanced, and honors an explicit pick", async () => {
    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    typeGoal(host, OPS_GOAL);
    clickButton(host, "Opções avançadas");
    await act(async () => {});

    // Sugestão preenche a escolha dentro do avançado (ops para goal de infra).
    await submitAndFlush(host);
    expect(submitMissionIntent.mock.calls[0]?.[0]).toMatchObject({
      lane: "ops",
    });
  });

  it("submits the explicit restriction the user picked in advanced", async () => {
    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    typeGoal(host, OPS_GOAL);
    clickButton(host, "Opções avançadas");
    await act(async () => {});

    const consultRadio = [...host.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Só pesquisar"))
      ?.querySelector('input[type="radio"]');
    if (!consultRadio) throw new Error("consult radio not found");
    act(() => {
      consultRadio.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});

    await submitAndFlush(host);
    expect(submitMissionIntent.mock.calls[0]?.[0]).toMatchObject({
      lane: "consult",
    });
  });

  it("wires the compiled intent into the single-screen mission review", async () => {
    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    expect(host.querySelector('[aria-current="step"]')?.textContent).toBe(
      "OBJETIVO",
    );
    typeGoal(host, "corrigir a regressão no carrinho");

    await submitAndFlush(host);

    expect(host.textContent).toContain("REVISÃO DA MISSÃO");
    expect(host.textContent).toMatch(/Ondas previstas/i);
    expect(host.textContent).toMatch(/Custo estimado do time/i);
    expect(host.textContent).toMatch(/Revisão técnica automática ao final/i);
    expect(host.textContent).toContain("Ainda não confirmado");
    expect(host.querySelector('[aria-current="step"]')?.textContent).toBe(
      "PLANO",
    );
    expect(document.activeElement).toBe(
      host.querySelector("[data-wizard-plan-review-heading]"),
    );
  });
});

describe("MissionWizard guided approval handoff", () => {
  const goal = "corrigir a regressão no login e validar com testes";

  beforeEach(() => {
    launcherMocks.launchSquadMission.mockReset();
    useWorkspaceStore.setState({
      current: {
        path: "/tmp/nexus-guided",
        name: "nexus-guided",
        lastOpenedAt: 1,
      },
      recents: [],
      hydrated: true,
    });
    useOrchStore.setState({
      squads: [guidedBuiltinSquad],
      missions: [],
      paneMissions: {},
    });
    useMissionWizardStore.setState({
      open: true,
      variant: "mission",
      presetSquadId: null,
      armedMissionId: null,
      agenticIntent: null,
      agenticSource: "typed",
      agenticLaunchNonce: 0,
      voiceLaunchNonce: 0,
      visibleStep: "squad-review",
      draft: {
        variant: "mission",
        step: "squad-review",
        mode: "agentic",
        intent: goal,
        missionGoal: "",
        missionLane: "standard",
        squadId: guidedBuiltinSquad.id,
        armedMissionId: null,
        count: 2,
        slots: [],
        wsPath: "",
        missionAttachments: [],
      },
    });
  });

  afterEach(() => {
    cleanupMountedRoots();
    useMissionWizardStore.setState(initialWizard);
    useOrchStore.setState(initialOrch);
    useWorkspaceStore.setState(initialWorkspace);
    Reflect.deleteProperty(window, "nexus");
    vi.restoreAllMocks();
  });

  it("deduplicates approval and skips the transient plan review", async () => {
    const runtimeSquadId =
      "agentic-runtime-00000000-0000-4000-8000-000000000001";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    let resolveCompilation: ((mission: Mission) => void) | undefined;
    const compileMission = new Promise<Mission>((resolve) => {
      resolveCompilation = resolve;
    });
    const planned: Mission = {
      id: "mission-guided-1",
      title: "Corrigir regressão",
      description: goal,
      status: "pending",
      squadId: runtimeSquadId,
      milestones: [],
      learnings: "",
      intentState: "awaiting_approval",
      intentVersion: 1,
      intentContract: {
        version: 1,
        source: "typed",
        goal,
        acceptanceCriteria: ["Testes verdes"],
        risk: "sensitive",
        executionMode: "assisted",
        contextPolicy: "on-demand",
        intentVersion: 1,
        budgets: {
          planningTokens: 100,
          executionTokens: 100,
          maxWorkers: 1,
        },
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const approveMissionIntent = vi.fn(async () => planned);
    const pushToast = vi
      .spyOn(useToastStore.getState(), "push")
      .mockImplementation(() => undefined);
    const submitGuidedIntent = vi.fn(() => compileMission);
    const saveSquad = vi.fn(async (squad: Squad) => ({
      ok: true,
      squad: {
        ...squad,
        id: runtimeSquadId,
        builtin: false,
      },
    }));

    launcherMocks.launchSquadMission.mockImplementation(
      async (
        _reviewedSquad: Squad,
        _adapters: AdapterInfo[],
        options: SquadLaunchOptions,
      ) => {
        if (!options.existingMissionId) {
          return {
            ok: true,
            armed: true,
            missionId: planned.id,
          };
        }
        await options.authorizeDispatch?.();
        return {
          ok: true,
          missionId: planned.id,
          starting: true,
        };
      },
    );

    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        adapters: { list: vi.fn(async () => [claudeAdapter]) },
        settings: {
          orchGet: vi.fn(async () => ({
            defaultAdapterId: claudeAdapter.id,
            intentFirstMissionRuntimeV1: true,
          })),
        },
        orch: {
          submitMissionIntent: submitGuidedIntent,
          approveMissionIntent,
          saveSquad,
          listMissions: vi.fn(async () => [planned]),
          getMissionPromptQueue: vi.fn(async () => null),
        },
      },
    });

    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    const continueButton = [...host.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent?.includes("Continuar para aprovação"),
    );
    if (!continueButton) throw new Error("guided approval button not found");
    await act(async () => {
      // Two events in the same turn model a double click or a concurrent voice
      // confirmation before React has painted the disabled state.
      continueButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      continueButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(launcherMocks.launchSquadMission).toHaveBeenCalledTimes(1);
    expect(submitGuidedIntent).toHaveBeenCalledWith({
      missionId: planned.id,
      goal,
      evidenceAttached: false,
      source: "typed",
      lane: "standard",
    });
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).not.toContain("Aguardando seu objetivo");

    await act(async () => {
      // Main broadcasts the compiled mission before the submit IPC necessarily
      // settles. Guided approval must not flash the optional second review.
      useOrchStore.setState({ missions: [planned] });
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("REVISÃO DA MISSÃO");
    expect(host.textContent).not.toContain("Iniciando…");

    await act(async () => {
      resolveCompilation?.(planned);
      await compileMission;
      await vi.waitFor(() => {
        expect(launcherMocks.launchSquadMission).toHaveBeenCalledTimes(2);
      });
    });

    expect(launcherMocks.launchSquadMission).toHaveBeenCalledTimes(2);
    expect(saveSquad).toHaveBeenCalledOnce();
    expect(saveSquad).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "runtime-request-00000000-0000-4000-8000-000000000001",
        builtin: false,
      }),
      {
        purpose: "mission-runtime",
        guided: true,
        sourceSquadId: guidedBuiltinSquad.id,
      },
    );
    expect(launcherMocks.launchSquadMission.mock.calls[0]?.[0]).toMatchObject({
      id: runtimeSquadId,
    });
    expect(launcherMocks.launchSquadMission.mock.calls[1]?.[0]).toMatchObject({
      id: runtimeSquadId,
    });
    expect(approveMissionIntent).toHaveBeenCalledOnce();
    expect(approveMissionIntent).toHaveBeenCalledWith({
      missionId: planned.id,
      evidenceAttached: false,
      attachmentPaths: undefined,
    });
    expect(pushToast).toHaveBeenCalledWith(
      "info",
      "Missão iniciando",
      expect.stringMatching(/processo principal.*assumiu/i),
    );
    expect(useMissionWizardStore.getState().open).toBe(false);
  });
});

describe("MissionWizard new-workspace authority", () => {
  const goal = "criar uma página de status e validar os arquivos";
  const pickedPath = "/private/tmp/nexus-new-workspace";
  const designedSquad: Squad = {
    ...squad,
    id: "agentic-draft-new-workspace",
    name: "Execução e revisão",
    agents: [
      {
        ...squad.agents[0]!,
        cli: "claude",
        model: "sonnet",
      },
      {
        id: "executor",
        agentName: "Executor",
        category: "executor",
        cli: "codex",
        model: "gpt-5.6-sol",
        allowedTools: ["Read", "Edit", "Bash"],
      },
    ],
  };

  function installNewWorkspaceApi(options?: {
    pickedPath?: string;
    openedPath?: string;
    openError?: Error;
    events?: string[];
  }) {
    const events = options?.events ?? [];
    const selectedPath = options?.pickedPath ?? pickedPath;
    const openedPath = options?.openedPath ?? selectedPath;
    const designSquad = vi.fn(async (workspacePath: string) => {
      events.push(`design:${workspacePath}`);
      return {
        ok: true as const,
        squad: designedSquad,
        designDraftToken: "d".repeat(43),
      };
    });
    const pickPath = vi.fn(async () => {
      events.push("pick");
      return selectedPath;
    });
    const open = vi.fn(async (path: string) => {
      events.push(`open:${path}`);
      if (options?.openError) throw options.openError;
      return {
        current: {
          path: openedPath,
          name: "nexus-new-workspace",
          lastOpenedAt: 2,
        },
        recents: [
          {
            path: openedPath,
            name: "nexus-new-workspace",
            lastOpenedAt: 2,
          },
        ],
      };
    });
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        adapters: {
          list: vi.fn(async () => [claudeAdapter, codexAdapter]),
        },
        settings: {
          orchGet: vi.fn(async () => ({
            defaultAdapterId: "claude",
            intentFirstMissionRuntimeV1: true,
          })),
        },
        workspace: { pickPath, open },
        orch: {
          designSquad,
          getMissionPromptQueue: vi.fn(async () => null),
        },
      },
    });
    return { designSquad, events, open, pickPath };
  }

  beforeEach(() => {
    launcherMocks.launchSquadMission.mockReset();
    useWorkspaceStore.setState({
      current: {
        path: "/private/tmp/nexus-old-workspace",
        name: "nexus-old-workspace",
        lastOpenedAt: 1,
      },
      recents: [],
      hydrated: true,
    });
    useOrchStore.setState({ squads: [], missions: [], paneMissions: {} });
    useMissionWizardStore.setState(initialWizard);
    useMissionWizardStore.getState().openForNewWorkspace();
  });

  afterEach(() => {
    cleanupMountedRoots();
    useMissionWizardStore.setState(initialWizard);
    useOrchStore.setState(initialOrch);
    useWorkspaceStore.setState(initialWorkspace);
    Reflect.deleteProperty(window, "nexus");
    vi.restoreAllMocks();
  });

  it("abre e hidrata o workspace autorizado antes de desenhar a equipe", async () => {
    const events: string[] = [];
    installNewWorkspaceApi({ events });
    layoutMocks.prepareWorkspaceLayoutSwitch.mockImplementation(() => {
      events.push("prepare-layout");
      return "/private/tmp/nexus-old-workspace";
    });
    layoutMocks.switchWorkspaceLayout.mockImplementation(async (path) => {
      events.push(`layout:${path}`);
      return true;
    });

    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    await clickButtonAndFlush(host, "PROCURAR");
    await clickButtonAndFlush(host, "Piloto automático");
    typeGoal(host, goal);
    await clickButtonAndFlush(host, "Preparar missão");

    expect(events).toEqual([
      "pick",
      "prepare-layout",
      `open:${pickedPath}`,
      `layout:${pickedPath}`,
      `design:${pickedPath}`,
    ]);
    expect(host.textContent).toContain("Equipe preparada");
  });

  it("usa o path canônico devolvido por main no layout e no design", async () => {
    const events: string[] = [];
    const pickerAlias = "/tmp/nexus-new-workspace";
    installNewWorkspaceApi({
      events,
      pickedPath: pickerAlias,
      openedPath: pickedPath,
    });
    layoutMocks.switchWorkspaceLayout.mockImplementation(async (path) => {
      events.push(`layout:${path}`);
      return true;
    });

    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    await clickButtonAndFlush(host, "PROCURAR");
    await clickButtonAndFlush(host, "Piloto automático");
    typeGoal(host, goal);
    await clickButtonAndFlush(host, "Preparar missão");

    expect(events).toContain(`open:${pickerAlias}`);
    expect(events).toContain(`layout:${pickedPath}`);
    expect(events).toContain(`design:${pickedPath}`);
    expect(host.textContent).toContain("Equipe preparada");
  });

  it("traduz a falta de autorização e nunca chama o arquiteto", async () => {
    useWorkspaceStore.setState({ current: null, recents: [], hydrated: true });
    const { designSquad } = installNewWorkspaceApi({
      openError: new Error(
        "Error invoking remote method 'workspace:open': " +
          "workspace path was not authorized by the folder picker",
      ),
    });

    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    await clickButtonAndFlush(host, "PROCURAR");
    await clickButtonAndFlush(host, "Piloto automático");
    typeGoal(host, goal);
    await clickButtonAndFlush(host, "Preparar missão");

    expect(designSquad).not.toHaveBeenCalled();
    expect(layoutMocks.switchWorkspaceLayout).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(
      /segurança.*procurar/i,
    );
    expect(host.textContent).toContain("Preparar missão");
  });
});

describe("MissionWizard ephemeral architect handoff", () => {
  const goal = "implementar login seguro e validar o fluxo completo";
  const draftSquad: Squad = {
    ...squad,
    id: "agentic-draft-secure",
    name: "Execução e revisão",
    agents: [
      { ...squad.agents[0]!, cli: "claude", model: "sonnet" },
      {
        id: "exec",
        agentName: "Executor",
        category: "executor",
        cli: "codex",
        model: "gpt-5.6-sol",
        allowedTools: ["Read", "Edit", "Bash"],
      },
      {
        id: "qa",
        agentName: "QA",
        category: "reviewer",
        cli: "codex",
        model: "gpt-5.6-sol",
        allowedTools: ["Read", "Bash"],
      },
    ],
  };

  beforeEach(() => {
    launcherMocks.launchSquadMission.mockReset();
    launcherMocks.launchSquadMission.mockResolvedValue({
      ok: false,
      error: "interrompido depois do seal para o teste",
    });
    useOrchStore.setState({ squads: [], missions: [], paneMissions: {} });
    useWorkspaceStore.setState({
      current: {
        path: "/tmp/nexus-ephemeral",
        name: "nexus-ephemeral",
        lastOpenedAt: 1,
      },
      recents: [],
      hydrated: true,
    });
    useMissionWizardStore.setState(initialWizard);
    useMissionWizardStore.getState().openForAgentic(goal);
  });

  afterEach(() => {
    cleanupMountedRoots();
    useMissionWizardStore.setState(initialWizard);
    useOrchStore.setState(initialOrch);
    useWorkspaceStore.setState(initialWorkspace);
    Reflect.deleteProperty(window, "nexus");
    vi.restoreAllMocks();
  });

  it("não publica o time antes da revisão e envia o token apenas ao seal runtime", async () => {
    const designDraftToken = "d".repeat(43);
    const runtimeSquad: Squad = {
      ...draftSquad,
      id: "agentic-runtime-123e4567-e89b-42d3-a456-426614174000",
      runtimeSourceSquadId: draftSquad.id,
      runtimeSourceSquadRevisionHash: "a".repeat(64),
    };
    const designSquad = vi.fn(async () => ({
      ok: true as const,
      squad: draftSquad,
      designDraftToken,
    }));
    const saveSquad = vi.fn(async () => ({
      ok: true as const,
      squad: runtimeSquad,
    }));
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        adapters: { list: vi.fn(async () => [claudeAdapter, codexAdapter]) },
        settings: {
          orchGet: vi.fn(async () => ({
            defaultAdapterId: "claude",
            intentFirstMissionRuntimeV1: true,
          })),
        },
        orch: {
          designSquad,
          saveSquad,
          getMissionPromptQueue: vi.fn(async () => null),
        },
      },
    });

    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    await clickButtonAndFlush(host, "Preparar missão");

    expect(designSquad).toHaveBeenCalledWith("/tmp/nexus-ephemeral", goal);
    expect(useOrchStore.getState().squads).toHaveLength(0);
    expect(saveSquad).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Equipe preparada");

    await clickButtonAndFlush(host, "Continuar para aprovação");

    expect(saveSquad).toHaveBeenCalledOnce();
    expect(saveSquad).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^runtime-request-/),
      }),
      {
        purpose: "mission-runtime",
        guided: true,
        sourceSquadId: draftSquad.id,
        designDraftToken,
      },
    );
  });

  it("salva um design efêmero com identidade de usuário e o mostra no picker", async () => {
    const designDraftToken = "d".repeat(43);
    const userOwnedSquad: Squad = {
      ...draftSquad,
      id: "squad-00000000-0000-4000-8000-000000000002",
      builtin: false,
    };
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000002",
    );
    setActiveWorkspacePath("/tmp/nexus-ephemeral");
    useOrchStore.setState({
      boundWorkspacePath: "/tmp/nexus-ephemeral",
    });
    const saveSquad = vi.fn(async (candidate: Squad) => ({
      ok: true as const,
      squad: { ...candidate, id: userOwnedSquad.id },
    }));
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        adapters: { list: vi.fn(async () => [claudeAdapter, codexAdapter]) },
        settings: {
          orchGet: vi.fn(async () => ({
            defaultAdapterId: "claude",
            intentFirstMissionRuntimeV1: true,
          })),
        },
        orch: {
          designSquad: vi.fn(async () => ({
            ok: true as const,
            squad: draftSquad,
            designDraftToken,
          })),
          saveSquad,
          listMissions: vi.fn(async () => []),
          listHandoffs: vi.fn(async () => []),
          getTodos: vi.fn(async () => []),
          listSquads: vi.fn(async () => [userOwnedSquad]),
          getMcpInfo: vi.fn(async () => null),
          getMissionPromptQueue: vi.fn(async () => null),
        },
      },
    });

    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    await clickButtonAndFlush(host, "Preparar missão");
    await clickButtonAndFlush(host, "Salvar configuração");

    expect(saveSquad).toHaveBeenCalledWith(
      expect.objectContaining({
        id: userOwnedSquad.id,
        builtin: false,
      }),
      undefined,
    );
    expect(saveSquad.mock.calls[0]?.[0].id).not.toMatch(/^(?:agentic|custom)-/);
    await act(async () => {
      useMissionWizardStore.getState().close({ discard: true });
      useMissionWizardStore.getState().openSquadPicker();
      await Promise.resolve();
    });

    expect(host.textContent).toContain(userOwnedSquad.name);
    expect(host.textContent).toContain("TIMES SALVOS");
    expect(host.textContent).not.toContain("YOUR SQUADS");
  });
});

describe("MissionWizard Planejar · PRD shortcut contract", () => {
  beforeEach(() => {
    submitMissionIntent.mockClear();
    launcherMocks.launchSquadMission.mockReset();
    launcherMocks.launchSquadMission.mockResolvedValue({
      ok: true,
      armed: true,
      missionId: "mission-armed-1",
    });
    const runtimeSquad: Squad = {
      ...planningBuiltinSquad,
      id: "mission-runtime-123e4567-e89b-42d3-a456-426614174000",
      builtin: false,
      runtimeSourceSquadId: NEXUS_PLAN_SQUAD_ID,
      runtimeSourceSquadRevisionHash: "a".repeat(64),
      agents: planningBuiltinSquad.agents.map((agent) => ({ ...agent })),
    };
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        adapters: { list: vi.fn(async () => [claudeAdapter]) },
        settings: {
          orchGet: vi.fn(async () => ({
            defaultAdapterId: claudeAdapter.id,
            intentFirstMissionRuntimeV1: true,
          })),
        },
        orch: {
          saveSquad: vi.fn(async () => ({
            ok: true,
            squad: runtimeSquad,
          })),
          submitMissionIntent,
          getMissionPromptQueue: vi.fn(async () => null),
        },
      },
    });
    useOrchStore.setState({
      squads: [planningBuiltinSquad],
      missions: [],
      paneMissions: {},
    });
    useWorkspaceStore.setState({
      current: {
        path: "/tmp/nexus-plan",
        name: "nexus-plan",
        lastOpenedAt: 1,
      },
      recents: [],
      hydrated: true,
    });
    useMissionWizardStore.setState({
      open: true,
      variant: "mission",
      presetSquadId: null,
      armedMissionId: null,
      agenticIntent: null,
      agenticSource: "typed",
      agenticLaunchNonce: 0,
      squadPickerNonce: 0,
      voiceLaunchNonce: 0,
      visibleStep: "mode",
      draft: null,
    });
  });

  afterEach(() => {
    cleanupMountedRoots();
    useMissionWizardStore.setState(initialWizard);
    useOrchStore.setState(initialOrch);
    useWorkspaceStore.setState(initialWorkspace);
    Reflect.deleteProperty(window, "nexus");
    vi.restoreAllMocks();
  });

  it("fixa lane plan, sela a origem e compila o objetivo sem a heurística voltar para standard", async () => {
    const { host } = mount(<MissionWizard />);
    await act(async () => {});

    await clickButtonAndFlush(host, "Planejar · PRD");

    expect(useMissionWizardStore.getState().draft).toMatchObject({
      step: "squad-review",
      squadId: NEXUS_PLAN_SQUAD_ID,
      missionLane: "plan",
    });

    await clickButtonAndFlush(host, "Definir objetivo do PRD");
    expect(window.nexus.orch.saveSquad).toHaveBeenCalledWith(
      expect.any(Object),
      {
        purpose: "mission-runtime",
        guided: false,
        sourceSquadId: NEXUS_PLAN_SQUAD_ID,
      },
    );

    typeGoal(host, "Criar autenticação segura e pronta para produção");
    await submitAndFlush(host);

    expect(submitMissionIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-armed-1",
        lane: "plan",
      }),
    );
  });
});
