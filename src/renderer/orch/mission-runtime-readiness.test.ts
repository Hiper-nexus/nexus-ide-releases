import { describe, expect, it } from "vitest";
import type { AccountInfo } from "../../shared/account-types";
import type { ProviderSettingsInfo } from "../../shared/provider-settings-types";
import type { AdapterInfo } from "../../shared/types";
import {
  isAdapterModelAuthenticated,
  missionRuntimeReadiness,
} from "./mission-runtime-readiness";

/**
 * Installed CLIs remain available for manual selection and worker tasks.
 * Coordinator suggestions additionally require Main's physical MCP contract.
 * Authentication snapshots remain advisory because CLI sessions can outlive
 * cached provider metadata.
 */

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
    needsRelogin: false,
    ...overrides,
  };
}

describe("mission runtime readiness (doutrina fluxo-por-padrão)", () => {
  it("keeps installed workers available and only suggests MCP-capable coordinators", () => {
    const adapters = [
      adapter("claude"),
      adapter("codex"),
      adapter("kimi", {
        orchestratorCapable: true,
        orchestrationEvidence: "experimental",
        missionControlCapable: false,
        taskHandoffCapable: false,
      }),
    ];
    const ready = missionRuntimeReadiness(adapters, [
      provider("claude"),
      provider("codex"),
      provider("kimi"),
    ]);

    expect(ready.detectedAdapters.map((item) => item.id)).toEqual([
      "claude",
      "codex",
      "kimi",
    ]);
    expect(ready.verifiedMaestros.map((item) => item.id)).toEqual([
      "claude",
      "codex",
    ]);
    expect(ready.qualifiedWorkers.map((item) => item.id)).toEqual([
      "claude",
      "codex",
      "kimi",
    ]);
    expect(ready.hasOperationalRoute).toBe(true);
    expect(ready.multiProviderReady).toBe(true);
  });

  it("login pendente NÃO esconde a ferramenta — o terminal dela cobra o login", () => {
    // Antes: login-needed sem conta era reprovado e a missão nem começava,
    // mesmo com o binário instalado. Isso era o gate histórico do passo
    // Equipe. Agora a ferramenta participa e o prompt de login aparece no
    // pane, como em qualquer terminal.
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
    ).toBe(true);
    expect(
      isAdapterModelAuthenticated(codex, [
        provider("codex", { authStrategy: "login-needed", authReadyModels: [] }),
      ]),
    ).toBe(true);
  });

  it("provider desligado pelo operador continua sendo recusa (escolha explícita)", () => {
    const codex = adapter("codex");
    expect(
      isAdapterModelAuthenticated(codex, [provider("codex", { enabled: false })]),
    ).toBe(false);
    expect(
      missionRuntimeReadiness(
        [codex],
        [provider("codex", { enabled: false })],
      ).hasOperationalRoute,
    ).toBe(false);
  });

  it("binário não instalado nunca aparece", () => {
    const ghost = adapter("ghost", { installed: false });
    const ready = missionRuntimeReadiness([ghost], [provider("ghost")]);
    expect(ready.detectedAdapters).toEqual([]);
    expect(ready.hasOperationalRoute).toBe(false);
    expect(isAdapterModelAuthenticated(ghost, [provider("ghost")])).toBe(false);
  });

  it("CLI de assinatura própria sem authReadyModels segue aceita", () => {
    const claude = adapter("claude", {
      models: { list: ["claude-sonnet-5"], default: "claude-sonnet-5" },
    });
    const snapshot = provider("claude", {
      defaultModel: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      authReadyModels: [],
      authStrategy: "subscription",
    });

    expect(isAdapterModelAuthenticated(claude, [snapshot])).toBe(true);
  });

  it("modelo fora da lista projetada não reprova — a CLI é a autoridade do próprio catálogo", () => {
    // Lista de modelos projetada envelhece (CLIs lançam modelo novo toda
    // semana). Reprovar seleção por snapshot velho travava missão real.
    const claude = adapter("claude", {
      models: {
        list: ["claude-sonnet-5", "claude-opus-5"],
        default: "claude-sonnet-5",
      },
    });
    const snapshot = provider("claude", {
      defaultModel: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      authReadyModels: ["claude-sonnet-5"],
    });

    expect(
      isAdapterModelAuthenticated(claude, [snapshot], "claude-opus-5"),
    ).toBe(true);
  });

  it("conta em cooldown não esconde a ferramenta", () => {
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
        [account("codex-cooling", "codex", { onCooldown: true })],
      ),
    ).toBe(true);
  });

  it("provider ausente do snapshot não reprova um binário instalado", () => {
    // Perfil recém-criado pode listar o adapter antes de materializar a linha
    // de provider — ausência de informação não é negativa.
    const claude = adapter("claude");
    expect(isAdapterModelAuthenticated(claude, [])).toBe(true);
    expect(
      missionRuntimeReadiness([claude], []).hasOperationalRoute,
    ).toBe(true);
  });

  it.each([false, undefined])("does not offer a coordinator without Main eligibility (%s)", (capable) => {
    const workerOnly = adapter("worker-only", {
      orchestratorCapable: false,
      orchestrationEvidence: "unsupported",
      autonomousWorkspaceWriteCapable: false,
      taskHandoffCapable: true,
      missionControlCapable: capable,
    });

    const ready = missionRuntimeReadiness([workerOnly], [
      provider("worker-only"),
    ]);

    expect(ready.verifiedMaestros).toEqual([]);
    expect(ready.detectedAdapters).toEqual([workerOnly]);
    expect(ready.qualifiedWorkers.map((item) => item.id)).toEqual([
      "worker-only",
    ]);
    expect(ready.hasOperationalRoute).toBe(false);
  });

  it("a política governed não esconde ferramenta na UI — a fronteira física de spawn é quem a impõe", () => {
    const kimi = adapter("kimi", {
      orchestratorCapable: false,
      orchestrationEvidence: "unsupported",
      autonomousWorkspaceWriteCapable: false,
      taskHandoffCapable: true,
      missionControlCapable: true,
    });

    expect(
      missionRuntimeReadiness(
        [kimi],
        [provider("kimi")],
        [],
        "governed",
      ).hasOperationalRoute,
    ).toBe(true);
  });

  it("adapters que não são cli-pty não entram na rota de missão", () => {
    const acp = adapter("acp-thing", { kind: "acp" as AdapterInfo["kind"] });
    const ready = missionRuntimeReadiness([acp], [provider("acp-thing")]);
    expect(ready.verifiedMaestros).toEqual([]);
    expect(ready.qualifiedWorkers).toEqual([]);
    expect(ready.hasOperationalRoute).toBe(false);
  });
});
