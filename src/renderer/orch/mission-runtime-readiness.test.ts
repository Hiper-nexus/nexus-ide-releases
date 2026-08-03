import { describe, expect, it } from "vitest";
import type { AccountInfo } from "../../shared/account-types";
import type { ProviderSettingsInfo } from "../../shared/provider-settings-types";
import type { AdapterInfo } from "../../shared/types";
import {
  isAdapterModelAuthenticated,
  missionRuntimeReadiness,
} from "./mission-runtime-readiness";

function adapter(
  id: string,
  overrides: Partial<AdapterInfo> = {},
): AdapterInfo {
  return {
    id,
    kind: "cli-pty",
    label: id,
    icon: id.slice(0, 1),
    models: { list: [`${id}-model`], default: `${id}-model` },
    installed: true,
    installCommand: "",
    idleTimeoutMs: 800,
    orchestratorCapable: id === "claude" || id === "codex",
    orchestrationEvidence:
      id === "claude" || id === "codex" ? "verified" : "unsupported",
    autonomousWorkspaceWriteCapable: id === "codex",
    taskHandoffCapable: id === "claude" || id === "codex",
    missionControlCapable: id === "claude" || id === "codex",
    ...overrides,
  };
}

function provider(
  id: string,
  overrides: Partial<ProviderSettingsInfo> = {},
): ProviderSettingsInfo {
  return {
    adapterId: id,
    label: id,
    icon: id.slice(0, 1),
    kind: "cli-pty",
    enabled: true,
    installed: true,
    canAutoInstall: false,
    binPath: "",
    detectedBin: id,
    defaultModel: `${id}-model`,
    models: [`${id}-model`],
    authReadyModels: [`${id}-model`],
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: "oauth",
    secureStorageAvailable: true,
    authStrategy: "subscription",
    upstream: id,
    routable: false,
    upstreams: [],
    permissionMode: "",
    permissionModes: [],
    effort: "",
    efforts: [],
    verbose: false,
    supportsVerbose: false,
    customModels: [],
    ...overrides,
  };
}

function account(
  id: string,
  adapterId: string,
  overrides: Partial<AccountInfo> = {},
): AccountInfo {
  return {
    id,
    adapterId,
    label: id,
    mode: "subscription",
    upstream: adapterId,
    createdAt: 1,
    active: false,
    hasCredential: true,
    onCooldown: false,
    ...overrides,
  };
}

describe("mission runtime readiness", () => {
  it("requires auth, a verified Maestro and an enforceable workspace writer", () => {
    const adapters = [
      adapter("claude"),
      adapter("codex"),
      adapter("kimi", {
        orchestratorCapable: true,
        orchestrationEvidence: "experimental",
      }),
    ];
    const ready = missionRuntimeReadiness(
      adapters,
      [provider("claude"), provider("codex"), provider("kimi")],
      [],
      "governed",
    );

    expect(ready.detectedAdapters.map((item) => item.id)).toEqual([
      "claude",
      "codex",
      "kimi",
    ]);
    expect(ready.verifiedMaestros.map((item) => item.id)).toEqual([
      "claude",
      "codex",
    ]);
    expect(ready.qualifiedWorkers.map((item) => item.id)).toEqual(["codex"]);
    expect(ready.hasOperationalRoute).toBe(true);
  });

  it("does not call an installed binary ready when its provider is disabled or unauthenticated", () => {
    const codex = adapter("codex");
    expect(
      missionRuntimeReadiness(
        [codex],
        [
          provider("codex", {
            authStrategy: "login-needed",
            authReadyModels: [],
          }),
        ],
      ).hasOperationalRoute,
    ).toBe(false);
    expect(
      isAdapterModelAuthenticated(codex, [
        provider("codex", { enabled: false }),
      ]),
    ).toBe(false);
  });

  it("binds readiness to the selected model instead of provider-wide auth", () => {
    const claude = adapter("claude", {
      models: {
        list: ["claude-sonnet-5", "claude-opus-5"],
        default: "claude-sonnet-5",
      },
    });
    const snapshot = provider("claude", {
      defaultModel: "claude-sonnet-5",
      models: ["claude-sonnet-5", "claude-opus-5"],
      authReadyModels: ["claude-sonnet-5"],
    });

    expect(isAdapterModelAuthenticated(claude, [snapshot])).toBe(true);
    expect(
      isAdapterModelAuthenticated(claude, [snapshot], "claude-opus-5"),
    ).toBe(false);
  });

  it("accepts a usable managed account when the native provider session is absent", () => {
    const codex = adapter("codex");
    const snapshot = provider("codex", {
      authStrategy: "login-needed",
      authReadyModels: [],
    });

    expect(
      isAdapterModelAuthenticated(
        codex,
        [snapshot],
        "codex-model",
        [account("codex-work", "codex")],
        "codex-work",
      ),
    ).toBe(true);
    expect(
      missionRuntimeReadiness(
        [codex],
        [snapshot],
        [account("codex-work", "codex")],
        "governed",
      ).hasOperationalRoute,
    ).toBe(true);
    expect(
      isAdapterModelAuthenticated(
        codex,
        [snapshot],
        "codex-model",
        [account("codex-cooling", "codex", { onCooldown: true })],
      ),
    ).toBe(false);
  });

  it("never lets an account make a removed model look ready", () => {
    const claude = adapter("claude", {
      models: {
        list: ["claude-sonnet-5", "claude-opus-5"],
        default: "claude-sonnet-5",
      },
    });
    const snapshot = provider("claude", {
      models: ["claude-sonnet-5"],
      authReadyModels: [],
    });

    expect(
      isAdapterModelAuthenticated(
        claude,
        [snapshot],
        "claude-opus-5",
        [account("claude-work", "claude")],
      ),
    ).toBe(false);
  });

  it("accepts authenticated Kimi/custom handoff routes in operator-choice", () => {
    const kimi = adapter("kimi", {
      orchestratorCapable: false,
      orchestrationEvidence: "unsupported",
      autonomousWorkspaceWriteCapable: false,
      taskHandoffCapable: true,
      missionControlCapable: true,
    });
    const custom = adapter("custom-cli", {
      orchestratorCapable: false,
      orchestrationEvidence: "unsupported",
      autonomousWorkspaceWriteCapable: false,
      taskHandoffCapable: true,
      missionControlCapable: true,
    });

    const ready = missionRuntimeReadiness(
      [kimi, custom],
      [provider("kimi"), provider("custom-cli")],
      [],
      "operator-choice",
    );

    expect(ready.verifiedMaestros.map((item) => item.id)).toEqual([
      "kimi",
      "custom-cli",
    ]);
    expect(ready.qualifiedWorkers.map((item) => item.id)).toEqual([
      "kimi",
      "custom-cli",
    ]);
    expect(ready.readyProviders.map((item) => item.id)).toEqual([
      "kimi",
      "custom-cli",
    ]);
    expect(ready.multiProviderReady).toBe(true);
    expect(ready.hasOperationalRoute).toBe(true);
  });

  it("keeps a worker-only CLI eligible as worker but never as Maestro", () => {
    const workerOnly = adapter("worker-only", {
      orchestratorCapable: false,
      orchestrationEvidence: "unsupported",
      autonomousWorkspaceWriteCapable: false,
      taskHandoffCapable: true,
      missionControlCapable: false,
    });

    const ready = missionRuntimeReadiness(
      [workerOnly],
      [provider("worker-only")],
      [],
      "operator-choice",
    );

    expect(ready.verifiedMaestros).toEqual([]);
    expect(ready.qualifiedWorkers.map((item) => item.id)).toEqual([
      "worker-only",
    ]);
    expect(ready.readyProviders.map((item) => item.id)).toEqual([
      "worker-only",
    ]);
    expect(ready.multiProviderReady).toBe(false);
    expect(ready.hasOperationalRoute).toBe(false);
  });

  it("retains verified Maestro and governed-writer requirements in Hardened", () => {
    const kimi = adapter("kimi", {
      orchestratorCapable: false,
      orchestrationEvidence: "unsupported",
      autonomousWorkspaceWriteCapable: false,
      taskHandoffCapable: true,
    });

    expect(
      missionRuntimeReadiness(
        [kimi],
        [provider("kimi")],
        [],
        "governed",
      ).hasOperationalRoute,
    ).toBe(false);
  });
});
