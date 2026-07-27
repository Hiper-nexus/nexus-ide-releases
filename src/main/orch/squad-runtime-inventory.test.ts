import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterInfo } from "../../shared/adapter-types";
import type { Squad } from "../../shared/orch-types";

const listAdapterInfosMock = vi.fn();
const listProviderSettingsMock = vi.fn();
const hasAvailableAccountMock = vi.fn();

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

import {
  assertLiveGuidedSquadReadiness,
  liveSquadRuntimeInventory,
} from "./squad-runtime-inventory";

function adapter(
  id: string,
  options: {
    nexusMcp?: boolean;
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
    autonomousWorkspaceWriteCapable:
      options.workspaceWrite ?? id === "codex",
    orchestrationEvidence:
      options.evidence ?? (nexusMcp ? "experimental" : "unsupported"),
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
  });

  it("separates direct CLI routes from guided receipt-capable workers", () => {
    const inventory = liveSquadRuntimeInventory();

    expect([...inventory.policy.routableCliIds]).toEqual([
      "claude",
      "codex",
      "aider",
    ]);
    expect([...inventory.policy.routableWorkerCliIds]).toEqual(["codex"]);
    expect(inventory.workerAdapters.map((item) => item.id)).toEqual(["codex"]);
  });

  it("rejects Aider at the standard boundary and retains MCP workers", () => {
    expect(() => assertLiveGuidedSquadReadiness(squad("aider"))).toThrow(
      /squad_runtime_unavailable:executor-unavailable/i,
    );
    expect(() =>
      assertLiveGuidedSquadReadiness(squad("codex")),
    ).not.toThrow();
  });

  it("does not trust a user adapter merely because it overrides id=codex", () => {
    listAdapterInfosMock.mockReturnValue([
      adapter("claude", { evidence: "verified" }),
      adapter("codex", {
        evidence: "experimental",
        workspaceWrite: false,
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

  it("projects exact auth-ready OMP models for direct use but excludes it from guided workers", () => {
    listAdapterInfosMock.mockReturnValue([
      adapter("claude", { evidence: "verified" }),
      {
        ...adapter("omp", { evidence: "verified" }),
        models: {
          list: [
            "anthropic/claude-sonnet-4-6",
            "openai-codex/gpt-5.5",
          ],
          default: "anthropic/claude-sonnet-4-6",
        },
      },
    ]);
    listProviderSettingsMock.mockReturnValue([
      provider("claude"),
      provider("omp", {
        defaultModel: "anthropic/claude-sonnet-4-6",
        models: [
          "anthropic/claude-sonnet-4-6",
          "openai-codex/gpt-5.5",
        ],
        authReadyModels: ["openai-codex/gpt-5.5"],
      }),
    ]);

    const inventory = liveSquadRuntimeInventory();
    const omp = inventory.adapters.find((item) => item.id === "omp");
    expect(omp?.models.list).toEqual(["openai-codex/gpt-5.5"]);
    expect(omp?.models.default).toBe("openai-codex/gpt-5.5");
    expect(inventory.workerAdapters.some((item) => item.id === "omp")).toBe(
      false,
    );
  });
});
