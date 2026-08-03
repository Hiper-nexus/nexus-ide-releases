import { vi } from "vitest";
import type { AdapterInfo } from "../../shared/adapter-types";
import { FEATURE_FLAG_IDS } from "../../shared/feature-flags";
import { getFeatureFlagRegistry } from "../feature-flags/feature-flag-registry";
import type { Mission, Squad } from "../../shared/orch-types";
import { compileIntentContract } from "../../shared/mission-intent";
import { testProjectScope } from "./__tests__/scope-fixture";
import { plannedTaskId, snapshotTaskPlanRoster } from "./task-store";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import {
  ensureGuidedMissionPlan,
  guidedLiveRosterAdapter,
  type GuidedMissionPlannerDeps,
} from "./guided-mission-planner";
import type { ProjectDomainStoreSuite } from "./project-domain-store-registry";
import {
  type WorktreeRecord,
  type WorktreeStateSnapshot,
  type WorktreeStateStore,
} from "../runtime/worktree-manager";

export const scope = testProjectScope({ rootRealPath: "/workspace/guided" });

export class MemoryWorktreeStateStore implements WorktreeStateStore {
  readonly #states = new Map<string, WorktreeStateSnapshot>();

  read(scopeKey: string): WorktreeStateSnapshot {
    return this.#states.get(scopeKey) ?? { revision: 0, records: [] };
  }

  compareAndSwap(
    scopeKey: string,
    expectedRevision: number,
    records: readonly WorktreeRecord[],
  ): boolean {
    const current = this.read(scopeKey);
    if (current.revision !== expectedRevision) return false;
    this.#states.set(scopeKey, {
      revision: current.revision + 1,
      records: structuredClone(records),
    });
    return true;
  }
}

export const squad: Squad = {
  id: "agentic-guided-squad",
  name: "Guided squad",
  createdAt: "1",
  builtin: false,
  orchestratorInstructions: "Coordene pelo Nexus.",
  agents: [
    {
      id: "orch",
      agentName: "Maestro",
      category: "orchestrator",
      cli: "claude",
    },
    {
      id: "frontend",
      agentName: "Frontend",
      category: "executor",
      cli: "codex",
      effort: "medium",
    },
    {
      id: "generalist",
      agentName: "Generalist",
      category: "executor",
      cli: "codex",
      effort: "medium",
    },
    {
      id: "qa",
      agentName: "QA de execução",
      category: "reviewer",
      cli: "codex",
      effort: "high",
    },
    {
      id: "reviewer",
      agentName: "Revisor sênior",
      category: "reviewer",
      cli: "codex",
      effort: "high",
    },
  ],
};

export function mission(overrides: Partial<Mission> = {}): Mission {
  const base = compileIntentContract({
    goal: "Implemente a entrega em `src/app.ts` e `package.json` com testes reais",
    acceptanceCriteria: [
      "Código pronto em src/app.ts",
      "Testes relevantes verdes em tests/app.test.ts",
    ],
    intentVersion: 3,
    source: "typed",
    lane: "standard",
  });
  return {
    id: "mission-guided",
    title: "Entrega guiada",
    description: base.goal,
    status: "running",
    squadId: squad.id,
    milestones: [],
    learnings: "",
    intentState: "dispatched",
    intentVersion: 3,
    intentContract: {
      ...base,
      approvedAt: 10,
      dispatchedAt: 10,
      squadRevisionHash: snapshotSquadAuthority(squad).hash,
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function squadWithAgentCli(agentId: string, cli: string): Squad {
  return {
    ...squad,
    agents: squad.agents.map((agent) =>
      agent.id === agentId ? { ...agent, cli } : agent,
    ),
  };
}

export function missionForSquad(liveSquad: Squad): Mission {
  const current = mission();
  return {
    ...current,
    intentContract: {
      ...current.intentContract!,
      squadRevisionHash: snapshotSquadAuthority(liveSquad).hash,
    },
  };
}

export function denseUiMission(): Mission {
  const goal = (
    "Crie `ui-panel.tsx`. Melhorar a interface React " + "g".repeat(20_000)
  ).slice(0, 16_384);
  const contract = compileIntentContract({
    goal,
    acceptanceCriteria: Array.from({ length: 21 }, () => "c".repeat(2_048)),
    intentVersion: 3,
    source: "typed",
    lane: "standard",
  });
  return mission({
    description: goal,
    intentContract: {
      ...contract,
      approvedAt: 10,
      dispatchedAt: 10,
      squadRevisionHash: snapshotSquadAuthority(squad).hash,
    },
  });
}

export function liveAdapter(
  id: string,
  installed = true,
): ReturnType<GuidedMissionPlannerDeps["listLiveAdapters"]>[number] {
  const canonicalDefault =
    id === "codex"
      ? "gpt-5.6-terra"
      : id === "glm"
        ? "glm-5.2"
        : id === "grok"
          ? "grok-4.5"
          : `${id}-default`;
  return {
    id,
    installed,
    models: {
      list: [canonicalDefault],
      default: canonicalDefault,
    },
  };
}

export function adapterInfo(id: string): AdapterInfo {
  const codex = id === "codex";
  const nativeReadOnly = codex || id === "grok" || id === "claude";
  return {
    id,
    kind: "cli-pty",
    label: id,
    icon: "",
    models: { list: [`${id}-default`], default: `${id}-default` },
    installed: true,
    installCommand: "",
    idleTimeoutMs: 800,
    orchestratorCapable: codex,
    autonomousWorkspaceWriteCapable: codex,
    orchestrationEvidence: codex ? "verified" : "unsupported",
    capabilities: {
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: nativeReadOnly,
      governedWriter: codex,
      verifiedMaestro: codex,
    },
  };
}

export function providerBackedLiveAdapter(
  adapterId: string,
  overrides: Partial<
    Omit<Parameters<typeof guidedLiveRosterAdapter>[0]["provider"], "adapterId">
  > = {},
  accountAvailable = true,
): ReturnType<GuidedMissionPlannerDeps["listLiveAdapters"]>[number] {
  const defaultModel = overrides.defaultModel ?? `${adapterId}-default`;
  return guidedLiveRosterAdapter({
    provider: {
      adapterId,
      enabled: true,
      installed: true,
      authStrategy: "subscription",
      models: [defaultModel],
      defaultModel,
      ...overrides,
    },
    accountAvailable,
  });
}

export function harness(
  options: {
    currentMission?: Mission;
    liveSquad?: Squad;
    adapters?: readonly ReturnType<
      GuidedMissionPlannerDeps["listLiveAdapters"]
    >[number][];
    existing?: readonly Record<string, unknown>[];
    /**
     * Warm-up advisories are production-default ON, but the legacy planner
     * suites assert the pre-warmup sealed graph byte-for-byte. The harness
     * pins the flag deterministically; warm-up suites opt in explicitly.
     */
    warmupAdvisories?: boolean;
  } = {},
) {
  getFeatureFlagRegistry().setOverride(
    FEATURE_FLAG_IDS.missionWarmupAdvisories,
    options.warmupAdvisories === true,
  );
  const currentMission = options.currentMission ?? mission();
  const createPlanAtomically = vi.fn(
    (input: {
      missionId: string;
      intentVersion: number;
      rows: readonly {
        plannerId: string;
        title: string;
        detail: string;
        agentRef: string;
        agentCategory: "executor" | "reviewer" | "scout" | "architect";
      }[];
    }) =>
      input.rows.map((row, index) => ({
        id: plannedTaskId(input.missionId, input.intentVersion, row.plannerId),
        missionId: input.missionId,
        title: row.title,
        detail: row.detail,
        status: "pending" as const,
        createdAt: index + 1,
        updatedAt: index + 1,
        ...scope,
      })),
  );
  const listPlannedTasks = vi.fn(() => options.existing ?? []);
  const suite = {
    missions: { get: vi.fn(() => currentMission) },
    tasks: {
      scope,
      listPlannedTasks,
      createPlanAtomically,
    },
  } as unknown as Pick<ProjectDomainStoreSuite, "missions" | "tasks">;
  const deps: GuidedMissionPlannerDeps = {
    getSquad: vi.fn(() => options.liveSquad ?? squad),
    getAdapterInfo: vi.fn((adapterId) => adapterInfo(adapterId)),
    listMissionWorktrees: vi.fn(() => []),
    squadCliPolicy: () => "operator-choice",
    listLiveAdapters: vi.fn(
      () =>
        options.adapters ?? [
          liveAdapter("codex"),
          liveAdapter("kimi"),
          liveAdapter("glm"),
          liveAdapter("claude"),
        ],
    ),
    listRepositoryOwnership: vi.fn(() => ["package.json", "src", "tests"]),
    assertStandardSquadReadiness: vi.fn(),
  };
  return {
    suite,
    deps,
    createPlanAtomically,
    listPlannedTasks,
  };
}

export function sealedGuidedV2Receipt(
  options: { warmupAdvisories?: boolean } = {},
) {
  const firstPass = harness(options);
  ensureGuidedMissionPlan(firstPass.suite, "mission-guided", firstPass.deps);
  const rows = firstPass.createPlanAtomically.mock.calls[0]![0].rows;
  const rosterHash = snapshotTaskPlanRoster(squad.agents).hash;
  return rows.map((row, index) => {
    const taskId = plannedTaskId("mission-guided", 3, row.plannerId);
    const task = {
      id: taskId,
      missionId: "mission-guided",
      title: row.title,
      detail: row.detail,
      status: "pending" as const,
      createdAt: index + 1,
      updatedAt: index + 1,
      ...scope,
    };
    return {
      plannerId: row.plannerId,
      taskId,
      missionId: "mission-guided",
      intentVersion: 3,
      squadId: squad.id,
      rosterHash,
      agentRef: row.agentRef,
      agentCategory: row.agentCategory,
      agent: squad.agents.find((agent) => agent.id === row.agentRef)!,
      plannedTitle: row.title,
      plannedDetail: row.detail,
      task,
    };
  });
}
