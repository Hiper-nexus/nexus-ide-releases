import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterInfo } from "../../shared/adapter-types";
import type { Squad } from "../../shared/orch-types";

const listAdapterInfosMock = vi.fn();
const listProviderSettingsMock = vi.fn();
const hasAvailableAccountMock = vi.fn();
const getOrchSettingsMock = vi.fn();
const warmKeychainOnlyMock = vi.fn();

vi.mock("../adapters/adapter-registry", () => ({
  listAdapterInfos: (...args: unknown[]) => listAdapterInfosMock(...args),
}));
vi.mock("../adapters/subscription-auth", () => ({
  warmKeychainOnlySubscriptionAuth: (...args: unknown[]) =>
    warmKeychainOnlyMock(...args),
}));
vi.mock("../persistence/provider-config-store", () => ({
  listProviderSettings: (...args: unknown[]) =>
    listProviderSettingsMock(...args),
}));
vi.mock("../persistence/account-store", () => ({
  hasAvailableAccount: (...args: unknown[]) =>
    hasAvailableAccountMock(...args),
}));
vi.mock("../persistence/settings-store", () => ({
  getOrchSettings: (...args: unknown[]) => getOrchSettingsMock(...args),
}));

import {
  assertLiveGuidedSquadReadiness,
  liveSquadRuntimeInventory,
  warmSquadRuntimeSubscriptionAuth,
} from "./squad-runtime-inventory";

function adapter(
  id: string,
  options: {
    nexusMcp?: boolean;
    taskHandoff?: boolean;
    missionControl?: boolean;
    evidence?: "verified" | "experimental" | "unsupported";
    workspaceWrite?: boolean;
  } = {},
): AdapterInfo {
  const nexusMcp = options.nexusMcp ?? true;
  return {
    id,
    kind: "cli-pty",
    label: id,
    icon: "",
    models: { list: [`${id}/default`], default: `${id}/default` },
    installed: true,
    resolvedBinPath: `/usr/local/bin/${id}`,
    installCommand: "",
    idleTimeoutMs: 800,
    orchestratorCapable: nexusMcp,
    taskHandoffCapable: options.taskHandoff ?? true,
    missionControlCapable: options.missionControl ?? true,
    autonomousWorkspaceWriteCapable:
      options.workspaceWrite ?? id === "codex",
    orchestrationEvidence:
      options.evidence ?? (nexusMcp ? "experimental" : "unsupported"),
    capabilities: {
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: false,
      governedWriter: options.workspaceWrite ?? id === "codex",
      verifiedMaestro:
        (options.evidence ?? (nexusMcp ? "experimental" : "unsupported")) ===
        "verified",
    },
  };
}

function provider(
  adapterId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    adapterId,
    label: adapterId,
    icon: "",
    kind: "cli-pty" as const,
    enabled: true,
    installed: true,
    canAutoInstall: false,
    binPath: "",
    detectedBin: `/usr/local/bin/${adapterId}`,
    defaultModel: `${adapterId}/default`,
    models: [`${adapterId}/default`],
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: "subscription",
    secureStorageAvailable: true,
    authStrategy: "subscription" as const,
    upstream: "",
    routable: false,
    upstreams: [],
    permissionMode: "",
    permissionModes: [],
    effort: "",
    efforts: [],
    verbose: false,
    supportsVerbose: false,
    plaintextKeyFallback: false,
    ...overrides,
  };
}

function squad(workerCli: string): Squad {
  return {
    id: "standard",
    name: "Standard",
    createdAt: "1",
    builtin: false,
    orchestratorInstructions: "Coordene pelo Nexus.",
    agents: [
      {
        id: "orch",
        agentName: "Maestro",
        category: "orchestrator",
        cli: "claude",
      },
      {
        id: "exec",
        agentName: "Executor",
        category: "executor",
        cli: workerCli,
      },
      {
        id: "qa",
        agentName: "QA",
        category: "reviewer",
        cli: workerCli,
      },
    ],
  };
}

describe("live squad runtime inventory", () => {
  beforeEach(() => {
    listAdapterInfosMock.mockReset();
    listProviderSettingsMock.mockReset();
    hasAvailableAccountMock.mockReset();
    getOrchSettingsMock.mockReset();
    warmKeychainOnlyMock.mockReset();
    listAdapterInfosMock.mockReturnValue([
      adapter("claude", { evidence: "verified" }),
      adapter("codex", { evidence: "verified" }),
      adapter("aider", { nexusMcp: false }),
    ]);
    listProviderSettingsMock.mockReturnValue([
      provider("claude"),
      provider("codex"),
      provider("aider"),
      // Persisted configuration without a loaded adapter must fail closed.
      provider("removed-plugin"),
    ]);
    hasAvailableAccountMock.mockReturnValue(true);
    getOrchSettingsMock.mockReturnValue({
      squadCliPolicy: "operator-choice",
    });
  });

  it("separates direct CLI routes from guided receipt-capable workers", () => {
    const inventory = liveSquadRuntimeInventory();

    expect([...inventory.policy.routableCliIds]).toEqual([
      "claude",
      "codex",
      "aider",
    ]);
    expect([...inventory.policy.routableWorkerCliIds]).toEqual([
      "claude",
      "codex",
      "aider",
    ]);
    expect(inventory.workerAdapters.map((item) => item.id)).toEqual([
      "claude",
      "codex",
      "aider",
    ]);
    expect(inventory.orchestratorAdapters.map((item) => item.id)).toEqual([
      "claude",
      "codex",
      "aider",
    ]);
  });

  it("admits a PTY-stream worker without pretending it has MCP", () => {
    expect(() =>
      assertLiveGuidedSquadReadiness(squad("aider")),
    ).not.toThrow();
    expect(() =>
      assertLiveGuidedSquadReadiness(squad("codex")),
    ).not.toThrow();
  });

  it("CLI sem metadado de controle também coordena — a capacidade ordena, não filtra", () => {
    listAdapterInfosMock.mockReturnValue([
      adapter("claude", { evidence: "verified" }),
      adapter("worker-only", {
        nexusMcp: false,
        taskHandoff: true,
        missionControl: false,
      }),
    ]);
    listProviderSettingsMock.mockReturnValue([
      provider("claude"),
      provider("worker-only"),
    ]);

    const inventory = liveSquadRuntimeInventory();
    expect(inventory.workerAdapters.map((item) => item.id)).toContain(
      "worker-only",
    );
    // Capaz de controle vem primeiro; o resto continua elegível.
    expect(inventory.orchestratorAdapters.map((item) => item.id)).toEqual([
      "claude",
      "worker-only",
    ]);
  });

  it("does not trust a user adapter merely because it overrides id=codex", () => {
    listAdapterInfosMock.mockReturnValue([
      adapter("claude", { evidence: "verified" }),
      adapter("codex", {
        evidence: "experimental",
        workspaceWrite: false,
        taskHandoff: false,
      }),
    ]);
    listProviderSettingsMock.mockReturnValue([
      provider("claude"),
      provider("codex"),
    ]);

    const inventory = liveSquadRuntimeInventory();
    expect(inventory.policy.routableCliIds.has("codex")).toBe(true);
    // A política continua rebaixando o worker forjado no catálogo…
    expect(inventory.policy.routableWorkerCliIds.has("codex")).toBe(false);
    // …mas a prontidão do squad não reprova mais por isso: quem impõe
    // confinamento de escrita é a fronteira física de spawn (governed).
    expect(() => assertLiveGuidedSquadReadiness(squad("codex"))).not.toThrow();
  });

  it("blocks a cold-cache AGY worker with the concrete auth cause, then routes it after the warm", async () => {
    // AGY 1.1 keeps its session token only in the macOS login keychain: the
    // sync inventory reads login-needed until the async warm runs. The flag
    // plays the role of the subscription-auth cache flipped by the probe.
    let agySessionVisible = false;
    warmKeychainOnlyMock.mockImplementation(async (cliId: string) => {
      if (cliId === "agy") agySessionVisible = true;
    });
    listAdapterInfosMock.mockReturnValue([
      adapter("claude", { evidence: "verified" }),
      adapter("codex", { evidence: "verified" }),
      adapter("agy"),
    ]);
    listProviderSettingsMock.mockImplementation(() => [
      provider("claude"),
      provider("codex"),
      provider("agy", {
        authStrategy: agySessionVisible ? "subscription" : "login-needed",
        models: ["gemini-3.6-flash-high"],
        defaultModel: "gemini-3.6-flash-high",
      }),
    ]);
    const agyWorkerSquad: Squad = {
      id: "agy-squad",
      name: "AGY squad",
      createdAt: "1",
      builtin: false,
      orchestratorInstructions: "Coordene pelo Nexus.",
      agents: [
        { id: "orch", agentName: "Maestro", category: "orchestrator", cli: "claude" },
        { id: "exec", agentName: "Executor", category: "executor", cli: "codex" },
        { id: "qa", agentName: "QA", category: "reviewer", cli: "codex" },
        { id: "agy", agentName: "AGY", category: "executor", cli: "agy" },
      ],
    };

    // Cold cache: a POLÍTICA ainda lê login-needed (catálogo/spawn)…
    expect(liveSquadRuntimeInventory().policy.routableCliIds.has("agy")).toBe(
      false,
    );
    // …mas a prontidão do squad não trava mais a missão por cache frio de
    // keychain — o gate de auth no approve foi removido de propósito.
    expect(() => assertLiveGuidedSquadReadiness(agyWorkerSquad)).not.toThrow();

    // The async boundary warms the keychain-only providers before the sync
    // readiness check; afterwards the same roster is routable.
    await warmSquadRuntimeSubscriptionAuth();
    expect(warmKeychainOnlyMock).toHaveBeenCalledWith("agy");

    const warmed = liveSquadRuntimeInventory();
    expect(warmed.policy.routableCliIds.has("agy")).toBe(true);
    expect(warmed.policy.routableWorkerCliIds.has("agy")).toBe(true);
    expect(() => assertLiveGuidedSquadReadiness(agyWorkerSquad)).not.toThrow();
  });

});
