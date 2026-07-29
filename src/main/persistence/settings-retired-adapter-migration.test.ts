import { describe, expect, it } from "vitest";
import type { AdapterInfo } from "../../shared/adapter-types";
import {
  DEFAULT_ORCH_SETTINGS,
  type OrchSettings,
} from "../../shared/settings-types";
import { planRetiredOrchestratorSettingsMigration } from "./settings-retired-adapter-migration";

function adapter(input: {
  readonly id: string;
  readonly installed: boolean;
  readonly evidence?: "verified" | "experimental" | "unsupported";
  readonly missionControlCapable?: boolean;
}): AdapterInfo {
  const evidence = input.evidence ?? "experimental";
  return {
    id: input.id,
    kind: "cli-pty",
    label: input.id,
    icon: ">_",
    models: { list: [], default: "" },
    installed: input.installed,
    installCommand: "",
    idleTimeoutMs: 1_000,
    orchestratorCapable: evidence !== "unsupported",
    missionControlCapable: input.missionControlCapable ?? true,
    orchestrationEvidence: evidence,
    capabilities: {
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: evidence === "verified",
      governedWriter: evidence === "verified",
      verifiedMaestro: evidence === "verified",
    },
  };
}

function settings(
  defaultAdapterId: string,
  squadCliPolicy: OrchSettings["squadCliPolicy"] = "operator-choice",
): OrchSettings {
  return {
    ...DEFAULT_ORCH_SETTINGS,
    defaultAdapterId,
    defaultModel: "legacy/model",
    defaultAccountId: "legacy-account",
    squadCliPolicy,
  };
}

describe("retired orchestrator settings migration", () => {
  it.each(["omp", "omp-rpc"])(
    "moves retired %s settings to an installed verified provider and clears provider-bound fields",
    (retiredId) => {
      const result = planRetiredOrchestratorSettingsMigration({
        settings: settings(retiredId),
        adapters: [
          adapter({
            id: "kimi",
            installed: true,
            evidence: "experimental",
          }),
          adapter({ id: "codex", installed: true, evidence: "verified" }),
          adapter({ id: "claude", installed: true, evidence: "verified" }),
        ],
        enabledAdapterIds: new Set(["kimi", "codex", "claude"]),
      });

      expect(result).toMatchObject({
        changed: true,
        previousAdapterId: retiredId,
        fallbackAdapterId: "claude",
        fallbackInstalled: true,
        settings: {
          defaultAdapterId: "claude",
          defaultModel: "",
          defaultAccountId: "",
        },
      });
    },
  );

  it("uses an installed Main-owned CLI in operator-choice mode when verified CLIs are unavailable", () => {
    const result = planRetiredOrchestratorSettingsMigration({
      settings: settings("omp-rpc"),
      adapters: [
        adapter({ id: "claude", installed: false, evidence: "verified" }),
        adapter({ id: "kimi", installed: true, evidence: "experimental" }),
      ],
      enabledAdapterIds: new Set(["claude", "kimi"]),
    });

    expect(result).toMatchObject({
      changed: true,
      fallbackAdapterId: "kimi",
      fallbackInstalled: true,
      settings: { defaultAdapterId: "kimi" },
    });
  });

  it("does not weaken governed policy to select an experimental provider", () => {
    const verifiedApi = {
      ...adapter({ id: "api-only", installed: true, evidence: "verified" }),
      kind: "api-provider" as const,
      missionControlCapable: false,
      capabilities: {
        launchable: false,
        promptInjectable: false,
        statusObservable: false,
        resumable: false,
        autonomousReadOnly: false,
        governedWriter: false,
        verifiedMaestro: true,
      },
    };
    const result = planRetiredOrchestratorSettingsMigration({
      settings: settings("omp", "governed"),
      adapters: [
        verifiedApi,
        adapter({ id: "kimi", installed: true, evidence: "experimental" }),
        adapter({ id: "codex", installed: false, evidence: "verified" }),
      ],
      enabledAdapterIds: new Set(["api-only", "kimi", "codex"]),
    });

    expect(result).toMatchObject({
      changed: true,
      fallbackAdapterId: "codex",
      fallbackInstalled: false,
      settings: {
        defaultAdapterId: "codex",
        squadCliPolicy: "governed",
      },
    });
  });

  it("never selects a disabled provider even when its binary is installed", () => {
    const result = planRetiredOrchestratorSettingsMigration({
      settings: settings("omp"),
      adapters: [
        adapter({ id: "codex", installed: true, evidence: "verified" }),
        adapter({ id: "claude", installed: true, evidence: "verified" }),
      ],
      enabledAdapterIds: new Set(["claude"]),
    });

    expect(result).toMatchObject({
      changed: true,
      fallbackAdapterId: "claude",
      fallbackInstalled: true,
    });
  });

  it("leaves a current provider untouched", () => {
    const current = settings("codex");
    const result = planRetiredOrchestratorSettingsMigration({
      settings: current,
      adapters: [adapter({ id: "codex", installed: true, evidence: "verified" })],
      enabledAdapterIds: new Set(["codex"]),
    });

    expect(result).toEqual({ changed: false, settings: current });
  });
});
