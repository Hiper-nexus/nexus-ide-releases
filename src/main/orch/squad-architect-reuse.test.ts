import { beforeEach, describe, expect, it, vi } from "vitest";

const listSquadsMock = vi.fn();
const normalizeEphemeralSquadCandidateMock = vi.fn();
const listAdapterInfosMock = vi.fn();
const listProviderSettingsMock = vi.fn();
const hasAvailableAccountMock = vi.fn();
const listInstalledCatalogItemsMock = vi.fn();
const getOrchSettingsMock = vi.fn();

vi.mock("./squad-store", () => ({
  listSquads: (...args: unknown[]) => listSquadsMock(...args),
  normalizeEphemeralSquadCandidate: (...args: unknown[]) =>
    normalizeEphemeralSquadCandidateMock(...args),
}));
vi.mock("../adapters/adapter-registry", () => ({
  listAdapterInfos: (...args: unknown[]) => listAdapterInfosMock(...args),
}));
vi.mock("../persistence/provider-config-store", () => ({
  listProviderSettings: (...args: unknown[]) =>
    listProviderSettingsMock(...args),
}));
vi.mock("../persistence/account-store", () => ({
  hasAvailableAccount: (...args: unknown[]) => hasAvailableAccountMock(...args),
}));
vi.mock("./catalog-installed", () => ({
  listInstalledCatalogItems: (...args: unknown[]) =>
    listInstalledCatalogItemsMock(...args),
}));
vi.mock("../voice/jarvis-brain", () => ({ chatViaBrainChain: vi.fn() }));
// Probes reais de auth (keychain + `kimi provider list`) não pertencem a
// teste de unidade: lentos e dependentes do estado da máquina.
vi.mock("../adapters/subscription-auth", () => ({
  warmKeychainOnlySubscriptionAuth: async () => {},
}));
vi.mock("../adapters/kimi-seat-probe", () => ({
  refreshKimiSeatReadiness: async () => undefined,
}));
vi.mock("../runtime/doctor-diagnostic-engine", () => ({
  diagnoseWithDoctorGrok: vi.fn(),
}));
vi.mock("../persistence/settings-store", () => ({
  getOrchSettings: (...args: unknown[]) => getOrchSettingsMock(...args),
}));

import { chatViaBrainChain } from "../voice/jarvis-brain";
import {
  designSquadForWorkspace,
  designSquadFromIntent,
} from "./squad-architect";
import { authReadyModelsForProvider } from "../adapters/model-auth-readiness";
import { rememberKimiSeatReadiness } from "../adapters/seat-auth-readiness";

const chatViaBrainChainMock = vi.mocked(chatViaBrainChain);

function adapterInfo(id: string, verifiedOrchestrator = true) {
  return {
    id,
    kind: "cli-pty",
    installed: true,
    // A declared MCP handoff is independent from verified Maestro evidence,
    // but does not qualify Kimi/OpenCode for autonomous guided workspace writes.
    orchestratorCapable: true,
    taskHandoffCapable: true,
    // Main-owned PTY action/result control is available to every physically
    // launchable, prompt-injectable and observable CLI in Autopilot.
    missionControlCapable: true,
    orchestrationEvidence: verifiedOrchestrator
      ? "verified"
      : "experimental",
    autonomousWorkspaceWriteCapable: id === "codex",
    capabilities: {
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: id === "codex",
      governedWriter: id === "codex",
      verifiedMaestro: verifiedOrchestrator,
    },
    models: { default: `${id}-default`, list: [`${id}-default`] },
  };
}

function providerInfo(
  adapterId: string,
  overrides: Record<string, unknown> = {},
) {
  const defaultModel = `${adapterId}-default`;
  const provider = {
    adapterId,
    enabled: true,
    installed: true,
    authStrategy: "subscription",
    defaultModel,
    models: [defaultModel],
    ...overrides,
  };
  const models = [
    ...(Array.isArray(provider.models)
      ? provider.models.filter(
          (model): model is string => typeof model === "string",
        )
      : []),
    ...(typeof provider.defaultModel === "string"
      ? [provider.defaultModel]
      : []),
  ];
  // Production ProviderSettingsInfo always carries the exact auth-ready
  // projection. Derive the same projection from each test override instead of
  // accidentally retaining a ready model after authStrategy/default changes.
  return {
    ...provider,
    authReadyModels: authReadyModelsForProvider(
      {
        adapterId,
        authStrategy:
          typeof provider.authStrategy === "string"
            ? provider.authStrategy
            : "login-needed",
      },
      [...new Set(models)],
    ),
  };
}

const savedSquad = {
  id: "meu-time",
  name: "Meu Time",
  builtin: false,
  createdAt: "2000",
  orchestratorInstructions: "",
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
      cli: "codex",
    },
    { id: "rev", agentName: "Revisor", category: "reviewer", cli: "codex" },
  ],
};

describe("designSquadFromIntent — Agêntico desenha do zero por padrão", () => {
  beforeEach(() => {
    listSquadsMock.mockReset();
    normalizeEphemeralSquadCandidateMock.mockReset();
    listAdapterInfosMock.mockReset();
    listProviderSettingsMock.mockReset();
    hasAvailableAccountMock.mockReset();
    listInstalledCatalogItemsMock.mockReset();
    getOrchSettingsMock.mockReset();
    chatViaBrainChainMock.mockReset();
    listAdapterInfosMock.mockReturnValue([
      adapterInfo("claude"),
      adapterInfo("kimi", false),
      adapterInfo("codex"),
    ]);
    listProviderSettingsMock.mockReturnValue([
      providerInfo("claude"),
      providerInfo("kimi"),
      providerInfo("codex"),
    ]);
    hasAvailableAccountMock.mockReturnValue(true);
    getOrchSettingsMock.mockReturnValue({
      defaultAdapterId: "claude",
      doctorAdapterId: "auto",
      doctorModel: "",
      doctorEffort: "auto",
      squadCliPolicy: "governed",
    });
    listInstalledCatalogItemsMock.mockReturnValue(
      ["check-work", "imagegen", "hatch-pet"].map((name) => ({
        kind: "skill",
        name,
        file: `/skills/${name}`,
        size: 0,
        modifiedAt: 1,
      })),
    );
    normalizeEphemeralSquadCandidateMock.mockImplementation((raw) => ({
      ...(raw as Record<string, unknown>),
      agents: (
        (raw as { agents?: Array<Record<string, unknown>> }).agents ?? []
      ).map((agent) => ({
        ...agent,
        allowedTools:
          agent.allowedTools ??
          (agent.category === "orchestrator" ? null : []),
      })),
    }));
  });

  it("NÃO reusa um squad salvo por padrão — desenha um time novo do zero", async () => {
    // Regressão (bug de campo): "escolhi orquestrador limpo / criar do 0" e o
    // wizard pegou o squad salvo mais recente (roster de outro projeto). Modo
    // Agêntico = desenhar um time para o objetivo, nunca substituir pelo salvo.
    listSquadsMock.mockReturnValue([savedSquad]);
    const result = await designSquadFromIntent(
      "melhorar o onboarding",
      "/tmp/ws",
    );
    expect(result.ok).toBe(true);
    expect(result.squad?.id).not.toBe("meu-time");
    expect(result.squad?.id).toMatch(/^agentic-fallback-/);
    expect(result.warning).toBeUndefined();
    expect(normalizeEphemeralSquadCandidateMock).toHaveBeenCalledTimes(1);
  });

  it("reusa o squad salvo apenas quando preferSavedSquad é explicitamente pedido", async () => {
    listSquadsMock.mockReturnValue([savedSquad]);
    const result = await designSquadFromIntent(
      "melhorar o onboarding",
      "/tmp/ws",
      {
        preferSavedSquad: true,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.squad?.id).toBe("meu-time");
    expect(normalizeEphemeralSquadCandidateMock).not.toHaveBeenCalled();
    expect(result.warning).toContain("Meu Time");
  });

  it("honra o Maestro experimental do roster salvo quando o reuso é pedido", async () => {
    rememberKimiSeatReadiness("present");
    // Doutrina fluxo-por-padrão (2026-08-10): evidência de orquestração deixou
    // de reprovar o squad salvo. Quem pediu explicitamente o próprio roster
    // recebe o próprio roster; confinamento continua na fronteira de spawn.
    listAdapterInfosMock.mockReturnValue([
      {
        ...adapterInfo("kimi"),
        orchestrationEvidence: "experimental",
      },
      adapterInfo("codex"),
    ]);
    listSquadsMock.mockReturnValue([
      {
        ...savedSquad,
        agents: [
          {
            id: "orch",
            agentName: "Maestro",
            category: "orchestrator",
            cli: "kimi",
          },
          {
            id: "exec",
            agentName: "Executor",
            category: "executor",
            cli: "codex",
          },
          {
            id: "qa",
            agentName: "QA",
            category: "reviewer",
            cli: "codex",
          },
        ],
      },
    ]);

    const result = await designSquadFromIntent(
      "melhorar o onboarding",
      "/tmp/ws",
      { preferSavedSquad: true },
    );

    expect(result.ok).toBe(true);
    expect(result.squad?.id).toBe("meu-time");
    expect(result.squad?.agents[0]?.cli).toBe("kimi");
  });

  it("falha com instrução acionável quando não há Maestro verificado", async () => {
    listAdapterInfosMock.mockReturnValue([
      {
        ...adapterInfo("kimi"),
        orchestrationEvidence: "experimental",
      },
    ]);
    listSquadsMock.mockReturnValue([]);

    const result = await designSquadFromIntent(
      "melhorar o onboarding",
      "/tmp/ws",
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /nenhum Maestro.*verificada.*Claude Code.*Codex/i,
      ),
    });
    expect(normalizeEphemeralSquadCandidateMock).not.toHaveBeenCalled();
  });

  it("sem squad elegível, cai no fallback determinístico (comportamento anterior)", async () => {
    listSquadsMock.mockReturnValue([{ ...savedSquad, builtin: true }]);
    const result = await designSquadFromIntent(
      "melhorar o onboarding",
      "/tmp/ws",
    );
    expect(result.ok).toBe(true);
    expect(result.squad?.id).toMatch(/^agentic-fallback-/);
    expect(normalizeEphemeralSquadCandidateMock).toHaveBeenCalledTimes(1);
  });

  it("mantém Claude exclusivo do Maestro no squad determinístico", async () => {
    listSquadsMock.mockReturnValue([]);

    const result = await designSquadFromIntent(
      "implementar e validar uma API",
      "/tmp/ws",
    );

    expect(result.ok).toBe(true);
    expect(result.squad?.agents[0]).toMatchObject({
      category: "orchestrator",
      cli: "claude",
    });
    expect(
      result.squad?.agents
        .filter((agent) => agent.category !== "orchestrator")
        .every((agent) => agent.cli !== "claude"),
    ).toBe(true);
    expect(
      result.squad?.agents.some((agent) => agent.category === "executor"),
    ).toBe(true);
    expect(
      result.squad?.agents.some((agent) => agent.category === "reviewer"),
    ).toBe(true);
  });

  it("atribui skills guiadas por papel e contexto sem aceitar allowlist do modelo", async () => {
    listSquadsMock.mockReturnValue([]);

    const result = await designSquadFromIntent(
      "implementar interface React com autenticação e revisar segurança",
      "/tmp/ws",
    );

    expect(result.ok).toBe(true);
    const executor = result.squad?.agents.find(
      (agent) => agent.category === "executor",
    );
    const reviewers =
      result.squad?.agents.filter(
        (agent) => agent.category === "reviewer",
      ) ?? [];
    expect(result.squad?.agents[0]?.allowedSkills).toEqual([
      "ponytail",
      "check-work",
      "bridgesecurity",
      "dembrandt",
    ]);
    expect(executor?.allowedSkills).toEqual([
      "ponytail",
      "bridgesecurity",
      "impeccable",
    ]);
    expect(executor?.allowedTools).toEqual([]);
    expect(reviewers.length).toBeGreaterThanOrEqual(2);
    expect(
      reviewers.every(
        (agent) =>
          JSON.stringify(agent.allowedSkills) ===
          JSON.stringify(["check-work", "bridgesecurity", "impeccable"]),
      ),
    ).toBe(true);
    expect(
      result.squad?.agents.flatMap((agent) => agent.allowedSkills ?? []),
    ).not.toContain("imagegen");
  });

  it("entrega somente a skill e as tools de mídia governadas ao executor visual", async () => {
    listSquadsMock.mockReturnValue([]);

    const result = await designSquadFromIntent(
      "criar desktop pet v2 em spritesheet com avatar animado",
      "/tmp/ws",
    );

    expect(result.ok).toBe(true);
    const visualExecutor = result.squad?.agents.find(
      (agent) => agent.category === "executor",
    );
    // A rota visual vai para o primeiro worker elegível — desde a doutrina
    // fluxo-por-padrão o inventário não pré-filtra workers por qualificação
    // de escrita, então Kimi entra no roster antes do Codex. O invariante
    // vivo aqui é o ESCOPO: só esse agente recebe a skill e as tools Nexus.
    expect(visualExecutor).toMatchObject({
      cli: "kimi",
      allowedSkills: expect.arrayContaining(["nexus-visual-media"]),
      allowedTools: ["nexus_media_providers", "nexus_image_generate"],
    });
    expect(
      result.squad?.agents
        .filter((agent) => agent.id !== visualExecutor?.id)
        .every(
          (agent) =>
            !agent.allowedSkills?.includes("nexus-visual-media") &&
            (agent.category === "orchestrator"
              ? agent.allowedTools === null
              : agent.allowedTools?.length === 0),
        ),
    ).toBe(true);
    expect(
      result.squad?.agents.flatMap((agent) => agent.allowedSkills ?? []),
    ).not.toEqual(expect.arrayContaining(["imagegen", "hatch-pet"]));
  });

  it("usa Kimi como Maestro e executor comum no operator-choice sem exigir Codex", async () => {
    getOrchSettingsMock.mockReturnValue({
      defaultAdapterId: "kimi",
      doctorAdapterId: "auto",
      doctorModel: "",
      doctorEffort: "auto",
      squadCliPolicy: "operator-choice",
    });
    listAdapterInfosMock.mockReturnValue([adapterInfo("kimi", false)]);
    listProviderSettingsMock.mockReturnValue([providerInfo("kimi")]);
    listSquadsMock.mockReturnValue([]);

    const result = await designSquadFromIntent(
      "implementar e validar uma API",
      "/tmp/ws",
    );

    expect(result.ok).toBe(true);
    expect(
      result.squad?.agents.every((agent) => agent.cli === "kimi"),
    ).toBe(true);
  });

  it("concede a rota visual Nexus ao executor Kimi no operator-choice", async () => {
    getOrchSettingsMock.mockReturnValue({
      defaultAdapterId: "kimi",
      doctorAdapterId: "auto",
      doctorModel: "",
      doctorEffort: "auto",
      squadCliPolicy: "operator-choice",
    });
    listAdapterInfosMock.mockReturnValue([adapterInfo("kimi", false)]);
    listProviderSettingsMock.mockReturnValue([providerInfo("kimi")]);
    listSquadsMock.mockReturnValue([]);

    const result = await designSquadFromIntent(
      "criar desktop pet v2 em spritesheet com avatar animado",
      "/tmp/ws",
    );
    const visualExecutor = result.squad?.agents.find(
      (agent) => agent.category === "executor",
    );

    expect(result.ok).toBe(true);
    expect(visualExecutor).toMatchObject({
      cli: "kimi",
      allowedSkills: expect.arrayContaining(["nexus-visual-media"]),
      allowedTools: ["nexus_media_providers", "nexus_image_generate"],
    });
  });

  it("não promove uma CLI legacy sem evidência a Maestro do fallback guiado", async () => {
    // O que morreu: sob `governed` o inventário filtrava os WORKERS pela
    // qualificação de escrita autônoma, então só Codex entrava no roster.
    // O que vive: a lista verificada continua sendo a autoridade de QUEM
    // coordena, e a CLI `unsupported` nunca vira Maestro.
    listAdapterInfosMock.mockReturnValue([
      adapterInfo("claude"),
      {
        ...adapterInfo("aider", false),
        orchestratorCapable: false,
        orchestrationEvidence: "unsupported",
      },
      adapterInfo("codex"),
    ]);
    listProviderSettingsMock.mockReturnValue([
      providerInfo("claude"),
      providerInfo("aider"),
      providerInfo("codex"),
    ]);
    listSquadsMock.mockReturnValue([]);

    const result = await designSquadFromIntent(
      "implementar e validar uma API",
      "/tmp/ws",
    );

    expect(result.ok).toBe(true);
    expect(result.squad?.agents[0]).toMatchObject({
      category: "orchestrator",
      cli: "claude",
    });
    expect(
      result.squad?.agents
        .filter((agent) => agent.category === "orchestrator")
        .every((agent) => agent.cli !== "aider"),
    ).toBe(true);
  });

  it("falha antes de salvar quando só existe Claude e não há CLI de worker", async () => {
    listAdapterInfosMock.mockReturnValue([adapterInfo("claude")]);
    listSquadsMock.mockReturnValue([]);

    const result = await designSquadFromIntent(
      "implementar e validar uma API",
      "/tmp/ws",
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /nenhuma CLI de worker.*Claude.*Maestro.*guided automático.*Codex.*escrita autônoma confinada.*Kimi.*painéis.*terminais.*manuais\/experimentais/i,
      ),
    });
    expect(normalizeEphemeralSquadCandidateMock).not.toHaveBeenCalled();
  });

  // Doutrina fluxo-por-padrão (2026-08-10): prontidão de ferramenta (auth
  // pendente, ausência de sandbox nativo, modelo externo sem credencial) saiu
  // do caminho do DESENHO — reprovar aqui derrubava missões reais com a CLI
  // instalada e logada. Estas quatro configurações continuam existindo em
  // campo e o desenho agora entrega o time; o fail-closed é a fronteira
  // física de spawn (assertReleaseQualifiedMissionWorkerSpawn), que sob
  // `governed` barra worker sem confinamento nativo de escrita.
  it.each([
    [
      "worker instalado sem autenticação pronta",
      () => [adapterInfo("claude"), adapterInfo("codex")],
      () => [
        providerInfo("claude"),
        providerInfo("codex", { authStrategy: "login-needed" }),
      ],
    ],
    [
      "OpenCode free sem sandbox nativo de escrita",
      () => [adapterInfo("claude"), adapterInfo("opencode", false)],
      () => [
        providerInfo("claude", { defaultModel: "claude-default" }),
        providerInfo("opencode", {
          authStrategy: "login-needed",
          defaultModel: "opencode/big-pickle",
        }),
      ],
    ],
    [
      "default externo do OpenCode sem credencial",
      () => [adapterInfo("claude"), adapterInfo("opencode", false)],
      () => [
        providerInfo("claude", { defaultModel: "claude-default" }),
        providerInfo("opencode", {
          authStrategy: "login-needed",
          defaultModel: "openrouter/openai/gpt-5",
        }),
      ],
    ],
    [
      "catálogo OpenCode misto (externo + free conhecido)",
      () => [adapterInfo("claude"), adapterInfo("opencode", false)],
      () => [
        providerInfo("claude", { defaultModel: "claude-default" }),
        providerInfo("opencode", {
          authStrategy: "login-needed",
          defaultModel: "openrouter/openai/gpt-5",
          models: [
            "openrouter/openai/gpt-5",
            "opencode/big-pickle",
          ],
        }),
      ],
    ],
  ])(
    "desenha o time mesmo com %s — o bloqueio real é o spawn",
    async (_label, adapters, providers) => {
      listAdapterInfosMock.mockReturnValue(adapters());
      listProviderSettingsMock.mockReturnValue(providers());
      listSquadsMock.mockReturnValue([]);

      const result = await designSquadFromIntent(
        "implementar e validar uma API",
        "/tmp/ws",
      );

      expect(result.ok).toBe(true);
      expect(result.squad?.id).toMatch(/^agentic-fallback-/);
      // Claude segue reservado ao Maestro; o worker é a CLI ainda não pronta.
      expect(result.squad?.agents[0]).toMatchObject({
        category: "orchestrator",
        cli: "claude",
      });
      expect(
        result.squad?.agents.some((agent) => agent.category === "executor"),
      ).toBe(true);
    },
  );

  it("squad salvo com cli não roteável não é reusado", async () => {
    listSquadsMock.mockReturnValue([
      {
        ...savedSquad,
        agents: savedSquad.agents.map((agent) =>
          agent.category === "executor" ? { ...agent, cli: "glm" } : agent,
        ),
      },
    ]);
    const result = await designSquadFromIntent(
      "melhorar o onboarding",
      "/tmp/ws",
    );
    expect(result.squad?.id).toMatch(/^agentic-fallback-/);
  });

  it("declara política hardened e catálogo runtime, e aceita a forma devolvida pelo modelo", async () => {
    // Morreu com a doutrina fluxo-por-padrão (2026-08-10): a pós-validação
    // trocava por fallback determinístico o roster do modelo que viesse sem
    // executor. `assessStandardSquadReadiness` só cobra "exatamente um
    // Maestro", então a saída do modelo é aceita como veio. O que continua
    // vivo aqui é o CONTRATO DE PROMPT: a política hardened e o catálogo
    // runtime que o arquiteto recebe.
    chatViaBrainChainMock.mockResolvedValue(
      JSON.stringify({
        name: "Time sem executor",
        orchestratorInstructions: "Revise o workspace.",
        agents: [
          {
            id: "review-a",
            agentName: "Review A",
            category: "reviewer",
            cli: "kimi",
            model: "kimi-default",
          },
          {
            id: "review-b",
            agentName: "Review B",
            category: "reviewer",
            cli: "codex",
            model: "codex-default",
          },
          {
            id: "scout",
            agentName: "Scout",
            category: "scout",
            cli: "kimi",
            model: "kimi-default",
          },
        ],
      }),
    );

    const result = await designSquadForWorkspace("/tmp/ws");

    expect(result.ok).toBe(true);
    const architectSystemPrompt =
      chatViaBrainChainMock.mock.calls[0]?.[0]?.[0]?.content ?? "";
    const architectRuntimeProfile =
      chatViaBrainChainMock.mock.calls[0]?.[0]?.[1]?.content ?? "";
    expect(architectSystemPrompt).toContain(
      'SOMENTE a linhas marcadas\n  "worker guided: qualificado"',
    );
    expect(architectSystemPrompt).toContain(
      "Painel, terminal, handoff ou\n  rota experimental não substituem confinamento autônomo",
    );
    expect(architectRuntimeProfile).toContain(
      "codex [models: codex-default; orquestração: verified; worker guided: qualificado]",
    );
    // O inventário deixou de pré-filtrar workers por qualificação de escrita:
    // toda cli-pty instalada entra como "worker guided: qualificado". A
    // evidência de orquestração continua distinguindo os Maestros.
    expect(architectRuntimeProfile).toContain(
      "kimi [models: kimi-default; orquestração: experimental; worker guided: qualificado]",
    );
    // Sem intent, o id é workspace-driven — não caiu no fallback determinístico.
    expect(result.squad?.id).toBe("custom-ws");
    expect(
      result.squad?.agents.filter(
        (agent) => agent.category === "orchestrator",
      ),
    ).toHaveLength(1);
    expect(normalizeEphemeralSquadCandidateMock).toHaveBeenCalledTimes(1);
  });

  it("não persiste fallback determinístico quando a autoridade já foi revogada", async () => {
    listSquadsMock.mockReturnValue([]);

    await expect(
      designSquadFromIntent("melhorar o onboarding", "/tmp/ws", {
        assertCurrentAuthority: () => {
          throw new Error("renderer workspace authority changed");
        },
      }),
    ).rejects.toThrow("renderer workspace authority changed");
    expect(normalizeEphemeralSquadCandidateMock).not.toHaveBeenCalled();
  });

  it("cancela o provider externo e não persiste quando o escopo é revogado", async () => {
    const controller = new AbortController();
    listSquadsMock.mockReturnValue([]);
    chatViaBrainChainMock.mockImplementation(
      async (_messages, _maxTokens, _deps, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const flight = designSquadForWorkspace("/tmp/ws", {
      signal: controller.signal,
      assertCurrentAuthority: () => {
        if (controller.signal.aborted) throw controller.signal.reason;
      },
    });
    await vi.waitFor(() =>
      expect(chatViaBrainChainMock).toHaveBeenCalledTimes(1),
    );
    controller.abort(new Error("renderer workspace authority changed"));

    await expect(flight).rejects.toThrow(
      "renderer workspace authority changed",
    );
    expect(normalizeEphemeralSquadCandidateMock).not.toHaveBeenCalled();
    expect(chatViaBrainChainMock.mock.calls[0]?.[3]).toBe(controller.signal);
  });
});
