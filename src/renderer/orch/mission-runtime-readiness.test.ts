import { describe, expect, it } from "vitest";
import type { AccountInfo } from "../../shared/account-types";
import type { ProviderSettingsInfo } from "../../shared/provider-settings-types";
import type { AdapterInfo } from "../../shared/types";
import {
  isAdapterModelAuthenticated,
  missionRuntimeReadiness,
} from "./mission-runtime-readiness";

/**
 * Doutrina fluxo-por-padrão (2026-08-10): prontidão NÃO é mais um gate.
 * CLI instalada e não desligada pelo operador participa da missão — como
 * coordenação e como execução. Login ausente, modelo fora da lista, conta em
 * cooldown: nada disso esconde a ferramenta nem trava o passo Equipe; o
 * terminal do agente é quem mostra a conversa real de auth. As únicas recusas
 * que restam são físicas (não instalada) ou escolha explícita do operador
 * (provider desligado nas configurações).
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
    ...overrides,
  };
}

describe("mission runtime readiness (doutrina fluxo-por-padrão)", () => {
  it("toda CLI instalada vira rota operacional — coordenação e execução", () => {
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
    // Capacidade de controle ORDENA (capaz primeiro), não filtra.
    expect(ready.verifiedMaestros.map((item) => item.id)).toEqual([
      "claude",
      "codex",
      "kimi",
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

  it("CLI sem metadado de controle também coordena (metadado ordena, não filtra)", () => {
    const workerOnly = adapter("worker-only", {
      orchestratorCapable: false,
      orchestrationEvidence: "unsupported",
      autonomousWorkspaceWriteCapable: false,
      taskHandoffCapable: true,
      missionControlCapable: false,
    });

    const ready = missionRuntimeReadiness([workerOnly], [
      provider("worker-only"),
    ]);

    expect(ready.verifiedMaestros.map((item) => item.id)).toEqual([
      "worker-only",
    ]);
    expect(ready.qualifiedWorkers.map((item) => item.id)).toEqual([
      "worker-only",
    ]);
    expect(ready.hasOperationalRoute).toBe(true);
  });

  it("a política governed não esconde ferramenta na UI — a fronteira física de spawn é quem a impõe", () => {
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
