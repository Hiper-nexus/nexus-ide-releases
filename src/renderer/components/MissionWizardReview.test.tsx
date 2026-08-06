/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountInfo } from "../../shared/account-types";
import type { Squad, SquadAgent } from "../../shared/orch-types";
import type { AdapterInfo } from "../../shared/types";
import type { ProviderSettingsInfo } from "../../shared/provider-settings-types";
import { MissionWizardReview } from "./MissionWizardReview";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  (
    window as unknown as {
      nexus: {
        settings: {
          orchGet: () => Promise<{ squadCliPolicy: string }>;
        };
      };
    }
  ).nexus = {
    settings: {
      orchGet: async () => ({ squadCliPolicy: "governed" }),
    },
  };
});

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

describe("MissionWizardReview roster personalization", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("offers add/remove controls so the squad is not locked to the design default", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onAddAgent = vi.fn();
    const onRemoveAgent = vi.fn();
    const executor: SquadAgent = {
      id: "exec-1",
      agentName: "Executor principal",
      category: "executor",
      cli: "codex",
      model: "gpt-5.4",
      effort: "medium",
      allowedTools: ["Bash", "Read", "Edit"],
    };
    const reviewer: SquadAgent = {
      id: "rev-1",
      agentName: "QA de execução",
      category: "reviewer",
      cli: "kimi",
      model: "kimi-code/kimi-for-coding",
      effort: "medium",
      allowedTools: ["Bash", "Read"],
    };
    act(() => {
      root.render(
        <MissionWizardReview
          squadCliPolicy="operator-choice"
          squad={{ ...squad, agents: [orchestrator, executor, reviewer] }}
          roster={[orchestrator, executor, reviewer]}
          adapters={[codex, kimi]}
          providers={[provider(codex), provider(kimi)]}
          accounts={[account("a-codex", "codex"), account("a-kimi", "kimi")]}
          guided
          highlightedAgentId={null}
          error={null}
          spawning={false}
          rosterSaved={false}
          rosterInvalidAgent={null}
          onSaveRoster={vi.fn()}
          onUpdateAgent={vi.fn()}
          onAddAgent={onAddAgent}
          onRemoveAgent={onRemoveAgent}
          onError={vi.fn()}
          onBack={vi.fn()}
          onCancel={vi.fn()}
          onLaunch={vi.fn()}
        />,
      );
    });

    expect(host.textContent).toMatch(/Personalizar equipe/);
    const addExecutor = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("+ Executor"),
    );
    const addReviewer = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("+ Revisor"),
    );
    expect(addExecutor).toBeTruthy();
    expect(addReviewer).toBeTruthy();
    act(() => addExecutor?.click());
    expect(onAddAgent).toHaveBeenCalledWith("executor");

    const remove = [...host.querySelectorAll("button")].find((b) =>
      b.getAttribute("aria-label")?.includes("Remover QA"),
    );
    expect(remove).toBeTruthy();
    act(() => remove?.click());
    expect(onRemoveAgent).toHaveBeenCalledWith("rev-1");

    act(() => root.unmount());
  });
});

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
          squadCliPolicy="governed"
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
          squadCliPolicy="governed"
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
          squadCliPolicy="governed"
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
      (button) => button.textContent === "Iniciar missão",
    );
    expect(host.textContent).toContain("Equipe preparada");
    expect(host.textContent).toContain("Coordenação verificada");
    // Personalização fica aberta: o operador precisa ver e editar CLIs de cara.
    expect(technicalDetails?.hasAttribute("open")).toBe(true);
    expect(host.textContent).toMatch(/Personalizar equipe/);

    act(() => continueButton?.click());
    expect(onLaunch).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("explica a rodada paralela sem prometer implementação", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const worker: SquadAgent = {
      ...orchestrator,
      id: "worker",
      agentName: "Especialista",
      category: "reviewer",
      allowedTools: [],
    };

    act(() => {
      root.render(
        <MissionWizardReview
          squadCliPolicy="governed"
          squad={{ ...squad, agents: [orchestrator, worker] }}
          roster={[orchestrator, worker]}
          adapters={[codex]}
          providers={[provider(codex)]}
          guided
          missionGoal="Teste de todos panes, cada um me fala o que faz na missão"
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

    expect(host.textContent).toMatch(
      /1 especialista responde em paralelo.*Maestro consolida com sua perspectiva/i,
    );
    expect(host.textContent).toMatch(/somente leitura/i);
    expect(host.textContent).not.toMatch(/executar e verificar a missão/i);
    expect(host.textContent).not.toMatch(/Cada tarefa usa worktree isolado/i);
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
          squadCliPolicy="governed"
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
        (button) => button.textContent === "Iniciar missão",
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
          squadCliPolicy="governed"
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
      (button) => button.textContent === "Iniciar missão",
    );
    expect(launch?.disabled).toBe(true);
    act(() => launch?.click());
    expect(onLaunch).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("oferece um worker credenciado como sugestão selecionável (override, part b)", () => {
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
          squadCliPolicy="governed"
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
    // Part (b): governed CLI is a PRE-FILLED SUGGESTION, not a lock. Codex keeps
    // its confined-writer label; a credentialed Kimi is now offered as a
    // selectable "sugerida" override instead of a dead "somente manual" option.
    expect([...workerProvider!.options].map((option) => option.text)).toEqual([
      "Codex · escrita confinada",
      "Kimi · sugerida",
    ]);
    expect(
      [...workerProvider!.options].find((option) =>
        option.text.includes("Kimi"),
      )?.disabled,
    ).toBe(false);
    act(() => root.unmount());
  });

  it("permite lançar um worker credenciado sem escrita confinada (override advisory, part b)", () => {
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
          squadCliPolicy="governed"
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
    // Part (b): the credentialed Kimi worker is now a launchable suggestion,
    // not a blocked "somente manual" pick.
    expect(workerProvider?.selectedOptions[0]?.text).toBe("Kimi · sugerida");
    const launch = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Usar este squad",
    );
    expect(launch?.disabled).toBe(false);
    act(() => launch?.click());
    expect(onLaunch).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("aceita CLI read-only credenciada em qualquer papel (advisory override, part b)", () => {
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
            squadCliPolicy="governed"
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

    // Part (b): a credentialed read-only CLI is a launchable SUGGESTION for an
    // executor too — the release-ladder classification is advisory, not a lock.
    const executor = renderRole("executor");
    expect(
      executor.host.querySelector<HTMLSelectElement>(
        'select[aria-label="Provider de Executor"]',
      )?.selectedOptions[0]?.text,
    ).toBe("Review CLI · leitura supervisionada");
    expect(executor.host.textContent).not.toContain(
      "Esta função exige escrita autônoma confinada",
    );
    expect(
      [...executor.host.querySelectorAll("button")].find(
        (button) => button.textContent === "Usar este squad",
      )?.disabled,
    ).toBe(false);
    act(() => executor.root.unmount());
  });

  it("accepts a managed account and keeps the verified proof operational", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <MissionWizardReview
          squadCliPolicy="governed"
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
        (button) => button.textContent === "Iniciar missão",
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
          squadCliPolicy="governed"
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
          squadCliPolicy="governed"
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

  it("blames auth — not missing qualification — when Claude has read-only but is logged out", () => {
    const scout: SquadAgent = {
      id: "e2e-advisor-claude",
      agentName: "E2E Advisor Claude",
      category: "scout",
      cli: "claude",
      model: claude.models.default,
      effort: "medium",
      allowedTools: [],
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <MissionWizardReview
          squadCliPolicy="governed"
          squad={{ ...squad, agents: [orchestrator, scout] }}
          roster={[orchestrator, scout]}
          adapters={[codex, claude]}
          providers={[
            provider(codex),
            provider(claude, {
              authStrategy: "login-needed",
              authReadyModels: [],
            }),
          ]}
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

    expect(host.textContent).toContain("precisa de autenticação válida");
    expect(host.textContent).not.toContain(
      "não possui essa qualificação nesta release",
    );
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

  it("admits any installed CLI as a reviewer advisor", () => {
    // Advisory participation is derived, not enumerated: the confinement is
    // the Nexus kernel sandbox applied at spawn, so a CLI the operator adds
    // later — aider here, tomorrow anything else — qualifies as soon as its
    // adapter exists and its model is authenticated. No allowlist to extend.
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

    expect(launch?.disabled).toBe(false);
    act(() => launch?.click());
    expect(onLaunch).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});

describe("MissionWizardReview picker liveness (part a)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // Regression: an accidental gate could disable EVERY option — including the
  // one already selected — leaving a dead picker the operator cannot operate.
  // The current CLI/model must always remain a selectable value.
  it("keeps the current CLI and model selectable even when logged out", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const worker: SquadAgent = {
      id: "worker-loggedout",
      agentName: "Executor Kimi",
      category: "executor",
      cli: "kimi",
      model: "kimi-code/kimi-for-coding",
      effort: "medium",
      allowedTools: ["Bash"],
    };
    act(() => {
      root.render(
        <MissionWizardReview
          squadCliPolicy="governed"
          squad={{ ...squad, agents: [orchestrator, worker] }}
          roster={[orchestrator, worker]}
          adapters={[codex, kimi]}
          providers={[
            provider(codex),
            // Kimi is present but logged out: without the part (a) fix its
            // options are all disabled and the picker is dead.
            provider(kimi, { authStrategy: "login-needed", authReadyModels: [] }),
          ]}
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

    const cliSelect = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Provider de Executor Kimi"]',
    );
    const currentCliOption = [...(cliSelect?.options ?? [])].find(
      (option) => option.value === "kimi",
    );
    expect(currentCliOption).toBeTruthy();
    expect(currentCliOption?.disabled).toBe(false);
    expect(cliSelect?.value).toBe("kimi");

    const modelSelect = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Modelo de Executor Kimi"]',
    );
    const currentModelOption = [...(modelSelect?.options ?? [])].find(
      (option) => option.value === "kimi-code/kimi-for-coding",
    );
    expect(currentModelOption).toBeTruthy();
    expect(currentModelOption?.disabled).toBe(false);
    expect(modelSelect?.value).toBe("kimi-code/kimi-for-coding");

    act(() => root.unmount());
  });

  // Part (b): the override only offers CREDENTIALED providers — a logged-out
  // provider stays a disabled option, never a launchable suggestion.
  it("does not offer a logged-out provider as a selectable suggestion", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const worker: SquadAgent = {
      id: "worker-codex",
      agentName: "Executor Codex",
      category: "executor",
      cli: "codex",
      model: "gpt-5.4",
      effort: "medium",
      allowedTools: ["Bash"],
    };
    act(() => {
      root.render(
        <MissionWizardReview
          squadCliPolicy="governed"
          squad={{ ...squad, agents: [orchestrator, worker] }}
          roster={[orchestrator, worker]}
          adapters={[codex, kimi]}
          providers={[
            provider(codex),
            provider(kimi, { authStrategy: "login-needed", authReadyModels: [] }),
          ]}
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

    const cliSelect = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Provider de Executor Codex"]',
    );
    const kimiOption = [...(cliSelect?.options ?? [])].find(
      (option) => option.value === "kimi",
    );
    // Present in the catalog but NOT credentialed -> offered disabled, not a
    // launchable suggestion; its label makes the reason explicit.
    expect(kimiOption).toBeTruthy();
    expect(kimiOption?.disabled).toBe(true);
    expect(kimiOption?.text).toContain("login necessário");
    // The credentialed codex stays the launchable suggestion.
    const codexOption = [...(cliSelect?.options ?? [])].find(
      (option) => option.value === "codex",
    );
    expect(codexOption?.disabled).toBe(false);

    act(() => root.unmount());
  });
});
