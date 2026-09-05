/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountInfo } from "../../../shared/account-types";
import type { AdapterInfo } from "../../../shared/types";
import type { ProviderSettingsInfo } from "../../../shared/provider-settings-types";
import {
  DEFAULT_ORCH_SETTINGS,
  type OrchSettings,
} from "../../../shared/settings-types";
import { OrchestratorDefaults } from "./OrchestratorDefaults";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function adapter(
  id: string,
  label: string,
  models: string[],
  installed = true,
  orchestrationEvidence: AdapterInfo["orchestrationEvidence"] = id ===
    "claude" || id === "codex"
    ? "verified"
    : "experimental",
): AdapterInfo {
  return {
    id,
    kind: "cli-pty",
    label,
    icon: id.slice(0, 1),
    models: { list: models, default: models[0] ?? "" },
    installed,
    orchestratorCapable: id !== "aider",
    orchestrationEvidence:
      id === "aider" ? "unsupported" : orchestrationEvidence,
    installCommand: "",
    idleTimeoutMs: 800,
  };
}

function account(id: string, adapterId: string, label: string): AccountInfo {
  return {
    id,
    adapterId,
    label,
    mode: "subscription",
    upstream: adapterId,
    createdAt: 1,
    active: false,
    hasCredential: true,
    onCooldown: false,
    needsRelogin: false,
  };
}

function provider(
  value: AdapterInfo,
  overrides: Partial<ProviderSettingsInfo> = {},
): ProviderSettingsInfo {
  return {
    adapterId: value.id,
    label: value.label,
    icon: value.icon,
    kind: value.kind,
    enabled: true,
    installed: value.installed,
    canAutoInstall: false,
    binPath: "",
    detectedBin: value.id,
    defaultModel: value.models.default,
    models: value.models.list,
    authReadyModels: value.models.list,
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: "oauth",
    secureStorageAvailable: true,
    authStrategy: "subscription",
    upstream: value.id,
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

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<OrchestratorDefaults />));
  return { host, root };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("OrchestratorDefaults", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "nexus");
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("configures provider, model and account from the installed MCP-capable inventory", async () => {
    let saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      defaultAdapterId: "codex",
      defaultModel: "gpt-5.4",
      defaultAccountId: "codex-work",
    };
    const orchSet = vi.fn(async (patch: Partial<OrchSettings>) => {
      saved = { ...saved, ...patch };
      return saved;
    });
    const adapters = [
      adapter("claude", "Claude", ["claude-opus-5", "claude-sonnet"]),
      adapter("codex", "Codex", ["gpt-5.4", "gpt-5.3-codex"]),
      adapter("agy", "Gemini", ["gemini-3.1-pro"], false),
      adapter("grok", "Grok", ["grok-code"]),
      adapter("aider", "Aider", ["aider-default"]),
    ];
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        settings: {
          orchGet: vi.fn(async () => saved),
          orchSet,
        },
        adapters: {
          list: vi.fn(async () => adapters),
          onChanged: vi.fn(() => vi.fn()),
        },
        providers: {
          list: vi.fn(async () => adapters.map((value) => provider(value))),
          onChanged: vi.fn(() => vi.fn()),
        },
        accounts: {
          list: vi.fn(async () => [
            account("claude-work", "claude", "Claude trabalho"),
            account("codex-work", "codex", "Codex trabalho"),
          ]),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });

    const { host, root } = mount();
    await flushEffects();

    const modelChoice = host.querySelector<HTMLDetailsElement>('.settings-orchestrator__model-choice');
    expect(modelChoice?.open).toBe(false);
    expect(modelChoice?.querySelector('summary')?.textContent).toContain('gpt-5.4');
    act(() => { modelChoice!.open = true; });

    const radios = () =>
      [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const accountSelect = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Conta do orquestrador"]',
    );
    // Picker unificado: um grupo por provider verificado, com logo e uso.
    expect(
      host.querySelector('section[aria-label="Claude"]'),
    ).not.toBeNull();
    expect(host.querySelector('section[aria-label="Codex"]')).not.toBeNull();
    expect(host.querySelector('section[aria-label="Grok"]')).toBeNull();
    const checked = () =>
      host.querySelector<HTMLButtonElement>(
        '[role="radio"][aria-checked="true"]',
      );
    expect(checked()?.getAttribute("aria-label")).toContain("gpt-5.4");
    expect([...accountSelect!.options].map((option) => option.value)).toEqual([
      "",
      "codex-work",
    ]);
    expect(host.textContent).toContain("Codex · pronto");
    expect(host.textContent).not.toContain("MCP conectado");

    const sonnet = radios().find(
      (radio) => radio.getAttribute("aria-label") === "claude-sonnet",
    );
    expect(sonnet).toBeTruthy();
    await act(async () => {
      sonnet!.click();
      await Promise.resolve();
    });

    expect(orchSet).toHaveBeenCalledWith({
      defaultAdapterId: "claude",
      defaultModel: "",
      defaultAccountId: "",
    });
    // Trocar de provider reseta para o padrão do provider — o picker mostra
    // o efetivo selecionado e a nota "seguindo o padrão".
    expect(checked()?.getAttribute("aria-label")).toContain("claude-opus-5");
    expect(host.textContent).toContain("Claude Opus 5 · claude-opus-5");
    expect(host.textContent).toContain(
      "Seguindo o padrão do provider (claude-opus-5)",
    );
    const accountAfter = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Conta do orquestrador"]',
    );
    expect([...accountAfter!.options].map((option) => option.value)).toEqual([
      "",
      "claude-work",
    ]);
    act(() => root.unmount());
  });

  it("modelo sem sessão aparece bloqueado no picker com o comando de login", async () => {
    const saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      defaultAdapterId: "codex",
      defaultModel: "",
      defaultAccountId: "",
    };
    const adapters = [
      adapter("claude", "Claude", ["claude-sonnet"]),
      adapter("codex", "Codex", ["gpt-5.4"]),
    ];
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        settings: {
          orchGet: vi.fn(async () => saved),
          orchSet: vi.fn(async () => saved),
        },
        adapters: {
          list: vi.fn(async () => adapters),
          onChanged: vi.fn(() => vi.fn()),
        },
        providers: {
          list: vi.fn(async () => [
            provider(adapters[0]!),
            provider(adapters[1]!, {
              authStrategy: "login-needed",
              authReadyModels: [],
              loginCommand: "codex login",
            }),
          ]),
          onChanged: vi.fn(() => vi.fn()),
        },
        accounts: {
          list: vi.fn(async () => []),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });

    const { host, root } = mount();
    await flushEffects();

    const codexGroup = host.querySelector('section[aria-label="Codex"]');
    expect(codexGroup).not.toBeNull();
    const locked = codexGroup!.querySelector<HTMLButtonElement>(
      '[role="radio"]',
    );
    expect(locked?.disabled).toBe(true);
    expect(locked?.getAttribute("aria-label")).toContain("codex login");
    // O Claude com sessão pronta continua selecionável.
    const ready = host
      .querySelector('section[aria-label="Claude"]')!
      .querySelector<HTMLButtonElement>('[role="radio"]');
    expect(ready?.disabled).toBe(false);
    act(() => root.unmount());
  });

  it("conta com sessão expirada aparece desabilitada e nomeada no default", async () => {
    const saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      defaultAdapterId: "codex",
      defaultModel: "",
      defaultAccountId: "",
    };
    const adapters = [adapter("codex", "Codex", ["gpt-5.4"])];
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        settings: {
          orchGet: vi.fn(async () => saved),
          orchSet: vi.fn(async () => saved),
        },
        adapters: {
          list: vi.fn(async () => adapters),
          onChanged: vi.fn(() => vi.fn()),
        },
        providers: {
          list: vi.fn(async () => adapters.map((value) => provider(value))),
          onChanged: vi.fn(() => vi.fn()),
        },
        accounts: {
          list: vi.fn(async () => [
            {
              ...account("codex-dead", "codex", "Codex morta"),
              needsRelogin: true,
            },
            account("codex-work", "codex", "Codex trabalho"),
          ]),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });

    const { host, root } = mount();
    await flushEffects();

    const accountSelect = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Conta do orquestrador"]',
    );
    const texts = [...accountSelect!.options].map((option) => option.text);
    expect(texts).toContain("Codex morta (sessão expirada)");
    const dead = [...accountSelect!.options].find((option) =>
      option.text.includes("Codex morta"),
    );
    expect(dead?.disabled).toBe(true);
    act(() => root.unmount());
  });

  it("keeps a declared but unverified coordinator visible and unavailable", async () => {
    const saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      defaultAdapterId: "kimi",
      defaultModel: "",
      defaultAccountId: "",
    };
    const adapters = [
      adapter("claude", "Claude", ["claude-sonnet"]),
      adapter(
        "kimi",
        "Kimi",
        ["kimi-code/kimi-for-coding"],
        true,
        "experimental",
      ),
    ];
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        settings: {
          orchGet: vi.fn(async () => saved),
          orchSet: vi.fn(async () => saved),
        },
        adapters: {
          list: vi.fn(async () => adapters),
          onChanged: vi.fn(() => vi.fn()),
        },
        providers: {
          list: vi.fn(async () => adapters.map((value) => provider(value))),
          onChanged: vi.fn(() => vi.fn()),
        },
        accounts: {
          list: vi.fn(async () => []),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });

    const { host, root } = mount();
    await flushEffects();

    expect(host.textContent).toContain("Kimi · Maestro não verificado");
    expect(host.textContent).toContain(
      "Kimi não concluiu o gate Nexus de Maestro",
    );
    expect(host.textContent).not.toContain("MCP conectado");
    // O salvo indisponível continua visível (nunca troca em silêncio) e o
    // picker oferece só Maestros verificados como substituição.
    expect(host.textContent).toContain("Salvo: Kimi (indisponível)");
    expect(host.querySelector('section[aria-label="Kimi"]')).toBeNull();
    expect(
      host.querySelector('section[aria-label="Claude"]'),
    ).not.toBeNull();
    act(() => root.unmount());
  });

  it("keeps an unavailable saved provider visible instead of silently changing it", async () => {
    const saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      defaultAdapterId: "claude",
      defaultModel: "",
      defaultAccountId: "",
    };
    const adapters = [
      adapter("claude", "Claude", ["claude-sonnet"], false),
      adapter("codex", "Codex", ["gpt-5.4"]),
    ];
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        settings: {
          orchGet: vi.fn(async () => saved),
          orchSet: vi.fn(async () => saved),
        },
        adapters: {
          list: vi.fn(async () => adapters),
          onChanged: vi.fn(() => vi.fn()),
        },
        providers: {
          list: vi.fn(async () => adapters.map((value) => provider(value))),
          onChanged: vi.fn(() => vi.fn()),
        },
        accounts: {
          list: vi.fn(async () => []),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });

    const { host, root } = mount();
    await flushEffects();

    expect(host.textContent).toContain("Salvo: Claude (indisponível)");
    expect(host.textContent).toContain(
      "Instale ou escolha um Maestro verificado",
    );
    // O picker oferece o Codex instalado como substituição; o Claude
    // desinstalado não aparece como opção.
    expect(host.querySelector('section[aria-label="Codex"]')).not.toBeNull();
    expect(host.querySelector('section[aria-label="Claude"]')).toBeNull();
    act(() => root.unmount());
  });

  it("treats a usable managed account as runtime auth for the exact model", async () => {
    const saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      defaultAdapterId: "claude",
      defaultModel: "claude-opus-5",
      defaultAccountId: "claude-work",
    };
    const claude = adapter("claude", "Claude", [
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        settings: {
          orchGet: vi.fn(async () => saved),
          orchSet: vi.fn(async () => saved),
        },
        adapters: {
          list: vi.fn(async () => [claude]),
          onChanged: vi.fn(() => vi.fn()),
        },
        providers: {
          list: vi.fn(async () => [
            provider(claude, {
              authStrategy: "login-needed",
              authReadyModels: [],
            }),
          ]),
          onChanged: vi.fn(() => vi.fn()),
        },
        accounts: {
          list: vi.fn(async () => [
            account("claude-work", "claude", "Claude trabalho"),
          ]),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });

    const { host, root } = mount();
    await flushEffects();

    expect(host.textContent).toContain("Claude · pronto");
    expect(host.textContent).not.toContain("login necessário");
    act(() => root.unmount());
  });

  it("does not let a managed account make a removed saved model ready", async () => {
    const saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      defaultAdapterId: "claude",
      defaultModel: "claude-opus-5",
      defaultAccountId: "claude-work",
    };
    const claude = adapter("claude", "Claude", ["claude-sonnet-5"]);
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        settings: {
          orchGet: vi.fn(async () => saved),
          orchSet: vi.fn(async () => saved),
        },
        adapters: {
          list: vi.fn(async () => [claude]),
          onChanged: vi.fn(() => vi.fn()),
        },
        providers: {
          list: vi.fn(async () => [
            provider(claude, {
              models: ["claude-sonnet-5"],
              authReadyModels: [],
            }),
          ]),
          onChanged: vi.fn(() => vi.fn()),
        },
        accounts: {
          list: vi.fn(async () => [
            account("claude-work", "claude", "Claude trabalho"),
          ]),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });

    const { host, root } = mount();
    await flushEffects();

    expect(host.textContent).toContain("Claude · modelo indisponível");
    expect(host.textContent).toContain(
      "O modelo salvo não está mais disponível",
    );
    // O fantasma continua nomeado (nunca some em silêncio do picker).
    expect(host.textContent).toContain("Salvo: claude-opus-5 (indisponível)");
    expect(host.textContent).not.toContain("Claude · pronto");
    act(() => root.unmount());
  });
});
