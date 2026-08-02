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

import {
  consultantRoleForObjective,
  designSquadFromIntent,
} from "./squad-architect";
import { authReadyModelsForProvider } from "../adapters/model-auth-readiness";

function adapterInfo(id: string, verifiedOrchestrator = true) {
  return {
    id,
    kind: "cli-pty",
    installed: true,
    orchestratorCapable: true,
    taskHandoffCapable: true,
    missionControlCapable: true,
    orchestrationEvidence: verifiedOrchestrator ? "verified" : "experimental",
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

function providerInfo(adapterId: string) {
  const defaultModel = `${adapterId}-default`;
  return {
    adapterId,
    enabled: true,
    installed: true,
    authStrategy: "subscription",
    defaultModel,
    models: [defaultModel],
    authReadyModels: authReadyModelsForProvider(
      { adapterId, authStrategy: "subscription" },
      [defaultModel],
    ),
  };
}

describe("consultantRoleForObjective", () => {
  it("gives a bug objective a reproduction scout", () => {
    const role = consultantRoleForObjective(
      "Corrigir o bug do login que quebra a sessão",
    );
    expect(role).toMatchObject({ category: "scout", id: "reproducao" });
    expect(role?.mandate).toContain("ANTES da correção");
  });

  it("gives a feature objective a consultative architect", () => {
    expect(
      consultantRoleForObjective("Implementar exportação CSV no painel"),
    ).toMatchObject({ category: "architect" });
  });

  it("gives a visual objective an interface architect tied to the design contract", () => {
    const role = consultantRoleForObjective(
      "Redesenhar a interface do dashboard com design system",
    );
    expect(role).toMatchObject({ category: "architect" });
    expect(role?.mandate).toContain("contrato de design");
  });

  it("invents NO role for an unclassifiable objective", () => {
    // `unknown` must stay the generic path: a role we cannot justify is a
    // guess, and a guess is exactly what the classifier refuses to make.
    expect(
      consultantRoleForObjective(
        "Estabelecer a cadência semanal de sincronia entre os times",
      ),
    ).toBeNull();
  });
});

describe("the automatic roster fills the consultative lane", () => {
  beforeEach(() => {
    for (const mock of [
      listSquadsMock,
      normalizeEphemeralSquadCandidateMock,
      listAdapterInfosMock,
      listProviderSettingsMock,
      hasAvailableAccountMock,
      listInstalledCatalogItemsMock,
      getOrchSettingsMock,
    ]) {
      mock.mockReset();
    }
    listSquadsMock.mockReturnValue([]);
    listAdapterInfosMock.mockReturnValue([
      adapterInfo("claude"),
      adapterInfo("codex"),
    ]);
    listProviderSettingsMock.mockReturnValue([
      providerInfo("claude"),
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
    listInstalledCatalogItemsMock.mockReturnValue([]);
    normalizeEphemeralSquadCandidateMock.mockImplementation((raw) => ({
      ...(raw as Record<string, unknown>),
      agents: (
        (raw as { agents?: Array<Record<string, unknown>> }).agents ?? []
      ).map((agent) => ({
        ...agent,
        allowedTools:
          agent.allowedTools ?? (agent.category === "orchestrator" ? null : []),
      })),
    }));
  });

  it("creates a scout for a bug objective — the lane used to be always empty", async () => {
    const result = await designSquadFromIntent(
      "Corrigir o bug do login que quebra a sessão quando o token expira",
      "/tmp/ws",
    );
    expect(result.ok).toBe(true);
    const consultants = (result.squad?.agents ?? []).filter(
      (agent) => agent.category === "scout" || agent.category === "architect",
    );
    expect(consultants).toHaveLength(1);
    expect(consultants[0]).toMatchObject({ category: "scout" });
    // Never invented for an absent CLI: the identity routes to an installed,
    // eligible worker adapter.
    expect(["codex", "claude"]).toContain(consultants[0]!.cli);
    expect(result.squad?.orchestratorInstructions).toContain(
      "investigador de reprodução",
    );
  });

  it("creates an architect for a feature objective", async () => {
    const result = await designSquadFromIntent(
      "Implementar a exportação de relatórios em CSV para o painel de vendas",
      "/tmp/ws",
    );
    expect(result.ok).toBe(true);
    expect(
      (result.squad?.agents ?? []).filter(
        (agent) => agent.category === "architect",
      ),
    ).toHaveLength(1);
  });

  it("keeps the generic roster when the objective cannot be classified", async () => {
    const result = await designSquadFromIntent(
      "Estabelecer a cadência semanal de sincronia entre os times envolvidos",
      "/tmp/ws",
    );
    expect(result.ok).toBe(true);
    expect(
      (result.squad?.agents ?? []).filter(
        (agent) => agent.category === "scout" || agent.category === "architect",
      ),
    ).toEqual([]);
  });
});
