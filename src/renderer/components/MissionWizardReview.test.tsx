/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountInfo } from "../../shared/account-types";
import type { Squad, SquadAgent } from "../../shared/orch-types";
import type { AdapterInfo } from "../../shared/types";
import type { ProviderSettingsInfo } from "../../shared/provider-settings-types";
import { MissionWizardReview } from "./MissionWizardReview";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const orchestrator: SquadAgent = {
  id: "orch",
  agentName: "Maestro",
  category: "orchestrator",
  cli: "codex",
  model: "gpt-5.4",
  effort: "high",
  allowedTools: null,
};

const squad: Squad = {
  id: "squad-1",
  name: "Operação",
  createdAt: "1",
  builtin: false,
  orchestratorInstructions: "",
  agents: [orchestrator],
};

const codex: AdapterInfo = {
  id: "codex",
  kind: "cli-pty",
  label: "Codex",
  icon: "◇",
  models: { list: ["gpt-5.4"], default: "gpt-5.4" },
  installed: true,
  orchestratorCapable: true,
  orchestrationEvidence: "verified",
  autonomousWorkspaceWriteCapable: true,
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
  idleTimeoutMs: 800,
};

const kimi: AdapterInfo = {
  ...codex,
  id: "kimi",
  label: "Kimi",
  models: {
    list: ["kimi-code/kimi-for-coding"],
    default: "kimi-code/kimi-for-coding",
  },
  orchestrationEvidence: "unsupported",
  autonomousWorkspaceWriteCapable: false,
  capabilities: {
    launchable: true,
    promptInjectable: true,
    statusObservable: true,
    resumable: true,
    autonomousReadOnly: false,
    governedWriter: false,
    verifiedMaestro: false,
  },
};

const supervisedReadOnly: AdapterInfo = {
  ...codex,
  id: "review-cli",
  label: "Review CLI",
  models: {
    list: ["review-model"],
    default: "review-model",
  },
  orchestrationEvidence: "unsupported",
  autonomousWorkspaceWriteCapable: false,
  capabilities: {
    launchable: true,
    promptInjectable: true,
    statusObservable: true,
    resumable: false,
    autonomousReadOnly: true,
    governedWriter: false,
    verifiedMaestro: false,
  },
};

function provider(
  adapter: AdapterInfo,
  overrides: Partial<ProviderSettingsInfo> = {},
): ProviderSettingsInfo {
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
    ...overrides,
  };
}

function account(id: string, adapterId: string): AccountInfo {
  return {
    id,
    adapterId,
    label: id,
    mode: "subscription",
    upstream: adapterId,
    createdAt: 1,
    active: true,
    hasCredential: true,
    onCooldown: false,
  };
}

describe("MissionWizardReview orchestrator provider", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the provider selected in Settings without a Claude-only claim", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <MissionWizardReview
          squad={squad}
          roster={[orchestrator]}
          adapters={[codex]}
          providers={[provider(codex)]}
          highlightedAgentId={null}
          error={null}
          spawning={false}
          rosterSaved={false}
          rosterInvalidAgent={null}
          onSaveRoster={vi.fn()}
          onUpdateAgent={vi.fn()}
          onError={vi.fn()}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onLaunch={vi.fn()}
        />,
      );
    });

    expect(
      host.querySelector<HTMLSelectElement>(
        'select[aria-label="Provider do Maestro"]',
      )?.value,
    ).toBe("codex");
    expect(host.textContent).toContain(
      "O Maestro automático usa somente provider com gate verificado.",
    );
    expect(host.textContent).not.toContain("fixo em Claude");
    act(() => root.unmount());
  });

  it("salva a configuração sem confundir persistência com início da missão", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onSaveRoster = vi.fn();
    const onLaunch = vi.fn();
    act(() => {
      root.render(
        <MissionWizardReview
          squad={squad}
          roster={[orchestrator]}
          adapters={[codex]}
          providers={[provider(codex)]}
          highlightedAgentId={null}
          error={null}
          spawning={false}
          rosterSaved={false}
          rosterInvalidAgent={null}
          onSaveRoster={onSaveRoster}
          onUpdateAgent={vi.fn()}
          onError={vi.fn()}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onLaunch={onLaunch}
        />,
      );
    });

    const save = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Salvar configuração",
    );
    const useSquad = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Usar este squad",
    );
    expect(save?.title).toContain("sem iniciar agentes");
    expect(host.textContent).toContain(
      "Salvar a configuração não inicia agentes.",
    );
    expect(host.textContent).not.toContain("Iniciar Squad");

    act(() => {
      save?.click();
      useSquad?.click();
    });
    expect(onSaveRoster).toHaveBeenCalledOnce();
    expect(onLaunch).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("resume a equipe no caminho guiado e deixa CLIs sob demanda", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onLaunch = vi.fn();
    act(() => {
      root.render(
        <MissionWizardReview
          squad={squad}
          roster={[orchestrator]}
          adapters={[codex]}
          providers={[provider(codex)]}
          guided
          highlightedAgentId={null}
          error={null}
          spawning={false}
          rosterSaved={false}
          rosterInvalidAgent={null}
          onSaveRoster={vi.fn()}
          onUpdateAgent={vi.fn()}
          onError={vi.fn()}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onLaunch={onLaunch}
        />,
      );
    });

    const technicalDetails = host.querySelector("details");
    const continueButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Continuar para aprovação",
    );
    expect(host.textContent).toContain("Equipe preparada");
    expect(host.textContent).toContain("Coordenação verificada");
    expect(technicalDetails?.hasAttribute("open")).toBe(false);

    act(() => continueButton?.click());
    expect(onLaunch).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("não promove o primeiro worker a Maestro quando o roster é inválido", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const workerOnly: SquadAgent = {
      ...orchestrator,
      id: "worker",
      agentName: "Executor",
      category: "executor",
      allowedTools: [],
    };
    act(() => {
      root.render(
        <MissionWizardReview
          squad={{ ...squad, agents: [workerOnly] }}
          roster={[workerOnly]}
          adapters={[codex]}
          providers={[provider(codex)]}
          guided
          highlightedAgentId={null}
          error={null}
          spawning={false}
          rosterSaved={false}
          rosterInvalidAgent={null}
          onSaveRoster={vi.fn()}
          onUpdateAgent={vi.fn()}
          onError={vi.fn()}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onLaunch={vi.fn()}
        />,
      );
    });

    expect(host.textContent).toContain("O squad não tem Maestro.");
    expect(
      [...host.querySelectorAll("button")].find(
        (button) => button.textContent === "Continuar para aprovação",
      )?.disabled,
    ).toBe(true);
    expect(
      host.querySelector('select[aria-label="Provider do Maestro"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it("mantém Kimi honestamente como rota manual, nunca como Maestro automático", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onLaunch = vi.fn();
    const manualOrchestrator = {
      ...orchestrator,
      cli: "kimi",
      model: kimi.models.default,
    };

    act(() => {
      root.render(
        <MissionWizardReview
          squad={{ ...squad, agents: [manualOrchestrator] }}
          roster={[manualOrchestrator]}
          adapters={[kimi]}
          providers={[provider(kimi)]}
          guided
          highlightedAgentId={null}
          error={null}
          spawning={false}
          rosterSaved={false}
          rosterInvalidAgent={null}
          onSaveRoster={vi.fn()}
          onUpdateAgent={vi.fn()}
          onError={vi.fn()}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onLaunch={onLaunch}
        />,
      );
    });

    expect(host.textContent).toContain("Disponível somente no Terminal");
    expect(host.textContent).toContain("não concluiu o gate de Maestro");
    expect(host.textContent).toContain("Coordenação não pronta");
    expect(host.textContent).not.toContain("Coordenação verificada");
    expect(
      host.querySelector<HTMLSelectElement>(
        'select[aria-label="Provider do Maestro"]',
      )?.selectedOptions[0]?.text,
    ).toBe("Kimi · somente manual");
    const launch = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Continuar para aprovação",
    );
    expect(launch?.disabled).toBe(true);
    act(() => launch?.click());
    expect(onLaunch).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("distingue worker governado de CLI disponível somente no Terminal", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const worker: SquadAgent = {
      id: "worker",
      agentName: "Executor",
      category: "executor",
      cli: "codex",
      model: "gpt-5.4",
      effort: "high",
      allowedTools: ["Bash", "Read", "Edit"],
    };
    act(() => {
      root.render(
        <MissionWizardReview
          squad={{ ...squad, agents: [orchestrator, worker] }}
          roster={[orchestrator, worker]}
          adapters={[codex, kimi]}
          providers={[provider(codex), provider(kimi)]}
          highlightedAgentId={null}
          error={null}
          spawning={false}
          rosterSaved={false}
          rosterInvalidAgent={null}
          onSaveRoster={vi.fn()}
          onUpdateAgent={vi.fn()}
          onError={vi.fn()}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onLaunch={vi.fn()}
        />,
      );
    });

    const workerProvider = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Provider de Executor"]',
    );
    expect([...workerProvider!.options].map((option) => option.text)).toEqual([
      "Codex · escrita confinada",
      "Kimi · somente manual",
    ]);
    expect(
      [...workerProvider!.options].find((option) =>
        option.text.includes("Kimi"),
      )?.disabled,
    ).toBe(true);
    expect(host.textContent).toContain(
      "Executores e arquitetos exigem escrita confinada",
    );
    expect(host.textContent).toContain("uso manual no Terminal");
    act(() => root.unmount());
  });

  it("bloqueia um worker salvo que não possui escrita autônoma confinada", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onLaunch = vi.fn();
    const worker: SquadAgent = {
      id: "worker-kimi",
      agentName: "Executor Kimi",
      category: "executor",
      cli: "kimi",
      model: "kimi-code/kimi-for-coding",
      effort: "high",
      allowedTools: ["Read"],
    };

    act(() => {
      root.render(
        <MissionWizardReview
          squad={{ ...squad, agents: [orchestrator, worker] }}
          roster={[orchestrator, worker]}
          adapters={[codex, kimi]}
          providers={[provider(codex), provider(kimi)]}
          highlightedAgentId={null}
          error={null}
          spawning={false}
          rosterSaved={false}
          rosterInvalidAgent={null}
          onSaveRoster={vi.fn()}
          onUpdateAgent={vi.fn()}
          onError={vi.fn()}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onLaunch={onLaunch}
        />,
      );
    });

    const workerProvider = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Provider de Executor Kimi"]',
    );
    expect(workerProvider?.selectedOptions[0]?.text).toBe(
      "Kimi · somente manual",
    );
    expect(host.textContent).toContain(
      "disponível para uso manual no Terminal",
    );
    const launch = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Usar este squad",
    );
    expect(launch?.disabled).toBe(true);
    act(() => launch?.click());
    expect(onLaunch).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("aceita CLI read-only somente para reviewer/scout", () => {
    const renderRole = (category: SquadAgent["category"]) => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      const worker: SquadAgent = {
        id: `worker-${category}`,
        agentName: category === "reviewer" ? "Revisor" : "Executor",
        category,
        cli: supervisedReadOnly.id,
        model: supervisedReadOnly.models.default,
        effort: "high",
        allowedTools: ["Read"],
      };
      act(() => {
        root.render(
          <MissionWizardReview
            squad={{ ...squad, agents: [orchestrator, worker] }}
            roster={[orchestrator, worker]}
            adapters={[codex, supervisedReadOnly]}
            providers={[provider(codex), provider(supervisedReadOnly)]}
            highlightedAgentId={null}
            error={null}
            spawning={false}
            rosterSaved={false}
            rosterInvalidAgent={null}
            onSaveRoster={vi.fn()}
            onUpdateAgent={vi.fn()}
            onError={vi.fn()}
            onBack={vi.fn()}
            onCancel={vi.fn()}
            onLaunch={vi.fn()}
          />,
        );
      });
      return { host, root, worker };
    };

    const reviewer = renderRole("reviewer");
    expect(
      reviewer.host.querySelector<HTMLSelectElement>(
        'select[aria-label="Provider de Revisor"]',
      )?.selectedOptions[0]?.text,
    ).toBe("Review CLI · leitura supervisionada");
    expect(
      [...reviewer.host.querySelectorAll("button")].find(
        (button) => button.textContent === "Usar este squad",
      )?.disabled,
    ).toBe(false);
    act(() => reviewer.root.unmount());
    reviewer.host.remove();

    const executor = renderRole("executor");
    expect(
      executor.host.querySelector<HTMLSelectElement>(
        'select[aria-label="Provider de Executor"]',
      )?.selectedOptions[0]?.text,
    ).toBe("Review CLI · leitura supervisionada");
    expect(executor.host.textContent).toContain(
      "Esta função exige escrita autônoma confinada",
    );
    expect(
      [...executor.host.querySelectorAll("button")].find(
        (button) => button.textContent === "Usar este squad",
      )?.disabled,
    ).toBe(true);
    act(() => executor.root.unmount());
  });

  it("accepts a managed account and keeps the verified proof operational", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <MissionWizardReview
          squad={squad}
          roster={[orchestrator]}
          adapters={[codex]}
          providers={[
            provider(codex, {
              authStrategy: "login-needed",
              authReadyModels: [],
            }),
          ]}
          accounts={[account("codex-work", "codex")]}
          guided
          highlightedAgentId={null}
          error={null}
          spawning={false}
          rosterSaved={false}
          rosterInvalidAgent={null}
          onSaveRoster={vi.fn()}
          onUpdateAgent={vi.fn()}
          onError={vi.fn()}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onLaunch={vi.fn()}
        />,
      );
    });

    expect(host.textContent).toContain("Coordenação verificada");
    expect(host.textContent).not.toContain("precisa de autenticação válida");
    expect(
      [...host.querySelectorAll("button")].find(
        (button) => button.textContent === "Continuar para aprovação",
      )?.disabled,
    ).toBe(false);
    act(() => root.unmount());
  });

  it("does not show verified coordination when auth or the exact model is unavailable", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <MissionWizardReview
          squad={squad}
          roster={[orchestrator]}
          adapters={[codex]}
          providers={[
            provider(codex, {
              models: ["gpt-5.3-codex"],
              authReadyModels: [],
              authStrategy: "login-needed",
            }),
          ]}
          accounts={[account("codex-work", "codex")]}
          guided
          highlightedAgentId={null}
          error={null}
          spawning={false}
          rosterSaved={false}
          rosterInvalidAgent={null}
          onSaveRoster={vi.fn()}
          onUpdateAgent={vi.fn()}
          onError={vi.fn()}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onLaunch={vi.fn()}
        />,
      );
    });

    expect(host.textContent).toContain("Coordenação não pronta");
    expect(host.textContent).toContain("precisa de autenticação válida");
    expect(host.textContent).not.toContain("Coordenação verificada");
    act(() => root.unmount());
  });
});

describe("MissionWizardReview advisory worker lane", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const claude: AdapterInfo = {
    ...codex,
    id: "claude",
    label: "Claude",
    models: { list: ["claude-opus-5"], default: "claude-opus-5" },
    orchestrationEvidence: "verified",
    autonomousWorkspaceWriteCapable: false,
    capabilities: {
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: true,
      governedWriter: false,
      verifiedMaestro: true,
    },
  };

  const aider: AdapterInfo = {
    ...kimi,
    id: "aider",
    label: "Aider",
  };

  function reviewHarness(
    rosterAgents: SquadAgent[],
    adapterList: AdapterInfo[],
    onLaunch = vi.fn(),
  ) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <MissionWizardReview
          squad={{ ...squad, agents: rosterAgents }}
          roster={rosterAgents}
          adapters={adapterList}
          providers={adapterList.map((adapter) => provider(adapter))}
          highlightedAgentId={null}
          error={null}
          spawning={false}
          rosterSaved={false}
          rosterInvalidAgent={null}
          onSaveRoster={vi.fn()}
          onUpdateAgent={vi.fn()}
          onError={vi.fn()}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onLaunch={onLaunch}
        />,
      );
    });
    const launch = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Usar este squad",
    );
    return { host, root, launch, onLaunch };
  }

  it("qualifies an authenticated advisory CLI for a read_only reviewer", () => {
    const reviewer: SquadAgent = {
      id: "e2e-advisor-kimi",
      agentName: "E2E Advisor Kimi",
      category: "reviewer",
      cli: "kimi",
      model: kimi.models.default,
      effort: "medium",
      allowedTools: [],
    };
    const { host, root, launch, onLaunch } = reviewHarness(
      [orchestrator, reviewer],
      [codex, kimi],
    );

    // Advisory lane (Fases 0/1): reviewer/scout read_only não exige
    // confinamento nativo — a fronteira é a autoridade MCP read-only.
    const kimiOption = [
      ...host.querySelectorAll<HTMLOptionElement>(
        'select[aria-label="Provider de E2E Advisor Kimi"] option',
      ),
    ].find((option) => option.text.includes("Kimi"));
    expect(kimiOption?.text).toBe("Kimi · leitura advisory MCP");
    expect(kimiOption?.disabled).toBe(false);
    expect(launch?.disabled).toBe(false);
    act(() => launch?.click());
    expect(onLaunch).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("admits a claude advisor when the orchestrator is not Claude", () => {
    const scout: SquadAgent = {
      id: "e2e-advisor-claude",
      agentName: "E2E Advisor Claude",
      category: "scout",
      cli: "claude",
      model: claude.models.default,
      effort: "medium",
      allowedTools: [],
    };
    const { root, launch } = reviewHarness(
      [orchestrator, scout],
      [codex, claude],
    );

    expect(launch?.disabled).toBe(false);
    act(() => root.unmount());
  });

  it("blocks a claude worker when the orchestrator already is Claude", () => {
    const claudeOrchestrator: SquadAgent = {
      ...orchestrator,
      cli: "claude",
      model: claude.models.default,
    };
    const reviewer: SquadAgent = {
      id: "e2e-advisor-claude",
      agentName: "E2E Advisor Claude",
      category: "reviewer",
      cli: "claude",
      model: claude.models.default,
      effort: "medium",
      allowedTools: [],
    };
    // reserveClaude: uma única sessão OAuth Claude por missão — o orquestrador.
    const { root, launch, onLaunch } = reviewHarness(
      [claudeOrchestrator, reviewer],
      [codex, claude],
    );

    expect(launch?.disabled).toBe(true);
    act(() => launch?.click());
    expect(onLaunch).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("keeps a non-advisory CLI without confinement out of reviewer work", () => {
    const reviewer: SquadAgent = {
      id: "worker-aider",
      agentName: "Reviewer Aider",
      category: "reviewer",
      cli: "aider",
      model: aider.models.default,
      effort: "medium",
      allowedTools: [],
    };
    const { root, launch, onLaunch } = reviewHarness(
      [orchestrator, reviewer],
      [codex, aider],
    );

    expect(launch?.disabled).toBe(true);
    act(() => launch?.click());
    expect(onLaunch).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
