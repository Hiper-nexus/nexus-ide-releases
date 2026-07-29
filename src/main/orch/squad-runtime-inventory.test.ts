import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterInfo } from "../../shared/adapter-types";
import type { Squad } from "../../shared/orch-types";

const listAdapterInfosMock = vi.fn();
const listProviderSettingsMock = vi.fn();
const hasAvailableAccountMock = vi.fn();
const getOrchSettingsMock = vi.fn();

vi.mock("../adapters/adapter-registry", () => ({
  listAdapterInfos: (...args: unknown[]) => listAdapterInfosMock(...args),
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

  it("keeps a one-way handoff CLI in the worker pool but out of Maestro choices", () => {
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
    expect(inventory.orchestratorAdapters.map((item) => item.id)).not.toContain(
      "worker-only",
    );
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
    expect(inventory.policy.routableWorkerCliIds.has("codex")).toBe(false);
    expect(() => assertLiveGuidedSquadReadiness(squad("codex"))).toThrow(
      /executor-unavailable/i,
    );
  });

});
