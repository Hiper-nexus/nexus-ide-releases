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

  it("não promove Maestro experimental ao reusar squad salvo", async () => {
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
    expect(result.squad?.id).toMatch(/^agentic-fallback-/);
    expect(result.squad?.agents[0]?.cli).toBe("codex");
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

  it("entrega somente a skill e as tools de mídia governadas ao Codex visual", async () => {
    listSquadsMock.mockReturnValue([]);

    const result = await designSquadFromIntent(
      "criar desktop pet v2 em spritesheet com avatar animado",
      "/tmp/ws",
    );

    expect(result.ok).toBe(true);
    const visualExecutor = result.squad?.agents.find(
      (agent) => agent.category === "executor",
    );
    expect(visualExecutor).toMatchObject({
      cli: "codex",
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

  it("não coloca uma CLI legacy sem handoff físico no fallback guiado", async () => {
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
    expect(
      result.squad?.agents
        .filter((agent) => agent.category !== "orchestrator")
        .every((agent) => agent.cli === "codex"),
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

  it("não cria fallback com worker instalado mas sem autenticação pronta", async () => {
    listAdapterInfosMock.mockReturnValue([
      adapterInfo("claude"),
      adapterInfo("codex"),
    ]);
    listProviderSettingsMock.mockReturnValue([
      providerInfo("claude"),
      providerInfo("codex", { authStrategy: "login-needed" }),
    ]);
    listSquadsMock.mockReturnValue([]);

    const result = await designSquadFromIntent(
      "implementar e validar uma API",
      "/tmp/ws",
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/nenhuma CLI de worker.*pronta/i),
    });
    expect(normalizeEphemeralSquadCandidateMock).not.toHaveBeenCalled();
  });

  it("não usa OpenCode free sem sandbox nativo de escrita qualificado", async () => {
    listAdapterInfosMock.mockReturnValue([
      adapterInfo("claude"),
      adapterInfo("opencode", false),
    ]);
    listProviderSettingsMock.mockReturnValue([
      providerInfo("claude", { defaultModel: "claude-default" }),
      providerInfo("opencode", {
        authStrategy: "login-needed",
        defaultModel: "opencode/big-pickle",
      }),
    ]);
    listSquadsMock.mockReturnValue([]);

    const result = await designSquadFromIntent(
      "implementar e validar uma API",
      "/tmp/ws",
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/nenhuma CLI de worker.*pronta/i),
    });
  });

  it("não transforma um default externo do OpenCode em rota sem credencial", async () => {
    listAdapterInfosMock.mockReturnValue([
      adapterInfo("claude"),
      adapterInfo("opencode", false),
    ]);
    listProviderSettingsMock.mockReturnValue([
      providerInfo("claude", { defaultModel: "claude-default" }),
      providerInfo("opencode", {
        authStrategy: "login-needed",
        defaultModel: "openrouter/openai/gpt-5",
      }),
    ]);
    listSquadsMock.mockReturnValue([]);

    const result = await designSquadFromIntent(
      "implementar e validar uma API",
      "/tmp/ws",
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/nenhuma CLI de worker.*pronta/i),
    });
    expect(normalizeEphemeralSquadCandidateMock).not.toHaveBeenCalled();
  });

  it("não promove nem modelo free conhecido sem sandbox nativo de escrita", async () => {
    listAdapterInfosMock.mockReturnValue([
      adapterInfo("claude"),
      adapterInfo("opencode", false),
    ]);
    listProviderSettingsMock.mockReturnValue([
      providerInfo("claude", { defaultModel: "claude-default" }),
      providerInfo("opencode", {
        authStrategy: "login-needed",
        defaultModel: "openrouter/openai/gpt-5",
        models: [
          "openrouter/openai/gpt-5",
          "opencode/big-pickle",
        ],
      }),
    ]);
    listSquadsMock.mockReturnValue([]);

    const result = await designSquadFromIntent(
      "implementar e validar uma API",
      "/tmp/ws",
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/nenhuma CLI de worker.*pronta/i),
    });
  });

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

  it("pós-valida saída automática e substitui roster sem executor por fallback seguro", async () => {
    chatViaBrainChainMock.mockResolvedValue(
      JSON.stringify({
        name: "Time inválido",
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
    expect(architectRuntimeProfile).toContain(
      "kimi [models: kimi-default; orquestração: experimental; worker guided: não qualificado (somente painel/terminal/manual)]",
    );
    expect(result.squad?.id).toMatch(/^agentic-fallback-/);
    expect(
      result.squad?.agents.some((agent) => agent.category === "executor"),
    ).toBe(true);
    expect(
      result.squad?.agents.some((agent) => agent.category === "reviewer"),
    ).toBe(true);
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
