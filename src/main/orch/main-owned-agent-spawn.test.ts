import { beforeEach, describe, expect, it, vi } from "vitest";

const registryDeps = vi.hoisted(() => ({
  assertMissionSpawnAuthorityCurrent: vi.fn(),
  assertPendingSpawnGrantActive: vi.fn(),
  assertPendingRecoverySpawnGrantActive: vi.fn(),
  bindPendingSpawnSession: vi.fn(() => true),
  bindPendingRecoverySpawnSession: vi.fn(() => true),
  attachSessionScope: vi.fn(),
  attachOrchMeta: vi.fn(),
}));
const missionDeps = vi.hoisted(() => ({
  mission: null as { id: string; squadId?: string } | null,
}));

vi.mock("./pane-registry", () => ({
  assertMissionSpawnAuthorityCurrent:
    registryDeps.assertMissionSpawnAuthorityCurrent,
  assertPendingSpawnGrantActive:
    registryDeps.assertPendingSpawnGrantActive,
  assertPendingRecoverySpawnGrantActive:
    registryDeps.assertPendingRecoverySpawnGrantActive,
  bindPendingSpawnSession: registryDeps.bindPendingSpawnSession,
  bindPendingRecoverySpawnSession:
    registryDeps.bindPendingRecoverySpawnSession,
  attachSessionScope: registryDeps.attachSessionScope,
  attachOrchMeta: registryDeps.attachOrchMeta,
}));
vi.mock("./mission-store", () => ({
  createScopedMissionStore: () => ({
    get: () => missionDeps.mission,
  }),
}));
vi.mock("../../shared/mission-intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/mission-intent")>()),
  hasCurrentDispatchAuthority: () => true,
}));

import {
  assertMainOwnedAgentSpawnGrantActive,
  bindMissionLaunchAuthority,
  settleSpawnedMainOwnedAgentSession,
} from "./main-owned-agent-spawn";
import { PET_STUDIO_SQUAD_ID } from "../../shared/pet-studio";

const scope = {
  version: 1 as const,
  installationId: "installation-a",
  projectId: "project-a",
  checkoutId: "checkout-a",
  rootRealPath: "/workspace/a",
  identitySource: "manifest" as const,
};

const owner = { id: 7 };
const authoritySeal = {
  intentVersion: 1,
  intentContractHash: "intent-contract-hash",
  contextRevision: "context-revision-a",
  contractHash: "contract-hash",
  squadRevisionHash: "squad-revision-hash",
};
const pending = {
  missionId: "mission-a",
  contextRevision: authoritySeal.contextRevision,
  authoritySeal,
  agentName: "worker-a",
  role: "worker" as const,
  scope,
};
const recovery = {
  scope,
  request: {
    requestId: "recovery-a",
    paneId: "pane-a",
    missionId: "mission-a",
    role: "worker" as const,
    pane: {
      adapterId: "claude",
      model: undefined,
      accountId: undefined,
      effort: undefined,
      cwd: undefined,
      title: "Worker",
      agentName: "worker-a",
      role: "worker" as const,
    },
    recap: "Recovery context",
  },
};
const authority = {
  source: "pending" as const,
  context: pending,
  scope,
  coordinationScope: scope,
  cwd: "/workspace/a",
};
const persistedPane = {
  id: "mission-pane-a",
  missionId: "mission-a",
  adapterId: "claude",
  title: "Worker",
  agentName: "worker-a",
  role: "worker" as const,
  paneId: "pane-a",
  scope,
  executionScope: scope,
  allowedTools: [],
  allowedSkills: ["review"],
  createdAt: 1,
};

describe("main-owned agent spawn boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    missionDeps.mission = null;
    registryDeps.bindPendingSpawnSession.mockReturnValue(true);
    registryDeps.bindPendingRecoverySpawnSession.mockReturnValue(true);
  });

  it("derives persisted squad identity only from the current scoped mission", () => {
    missionDeps.mission = {
      id: "mission-pet",
      squadId: PET_STUDIO_SQUAD_ID,
    };
    const persistedAuthority = {
      ...authority,
      source: "persisted-pane" as const,
      context: {
        ...authority.context,
        missionId: "mission-pet",
        role: "orchestrator" as const,
        squadId: undefined,
      },
    };

    const rebound = bindMissionLaunchAuthority(
      {} as never,
      persistedAuthority,
      "mission-pet",
    );

    expect(rebound.context).toMatchObject({
      missionId: "mission-pet",
      squadId: PET_STUDIO_SQUAD_ID,
    });
    expect(() =>
      bindMissionLaunchAuthority(
        {} as never,
        {
          ...persistedAuthority,
          context: {
            ...persistedAuthority.context,
            squadId: "renderer-lookalike",
          },
        },
        "mission-pet",
      ),
    ).toThrow(/mission squad does not match spawn authority/i);
  });

  it("uses one pre-effect fence for pending and recovery grants", () => {
    assertMainOwnedAgentSpawnGrantActive({
      owner: owner as never,
      requestId: "spawn-a",
      pending,
      recovery,
    });

    expect(
      registryDeps.assertPendingSpawnGrantActive,
    ).toHaveBeenCalledWith("spawn-a", owner);
    expect(
      registryDeps.assertMissionSpawnAuthorityCurrent,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-a",
        scope,
        contextRevision: authoritySeal.contextRevision,
        authoritySeal,
      }),
    );
    expect(
      registryDeps.assertPendingRecoverySpawnGrantActive,
    ).toHaveBeenCalledWith("spawn-a", owner);
  });

  it.each(["PTY", "RPC"] as const)(
    "settles a successful %s session through the same durable bindings",
    async (backend) => {
      const terminate = vi.fn(async () => true);

      const result = settleSpawnedMainOwnedAgentSession({
        backend,
        owner: owner as never,
        requestId: "spawn-a",
        sessionId: "session-a",
        authority,
        pending,
        recovery: null,
        persistedPane,
        terminate,
      });

      expect(result).toBeNull();
      expect(registryDeps.bindPendingSpawnSession).toHaveBeenCalledWith(
        "spawn-a",
        owner,
        "session-a",
      );
      expect(registryDeps.attachSessionScope).toHaveBeenCalledWith(
        "session-a",
        scope,
      );
      expect(registryDeps.attachOrchMeta).toHaveBeenCalledWith(
        owner,
        "pane-a",
        expect.objectContaining({
          missionId: "mission-a",
          role: "worker",
          scope,
          executionScope: scope,
        }),
      );
      expect(terminate).not.toHaveBeenCalled();
    },
  );

  it.each(["PTY", "RPC"] as const)(
    "awaits exact %s exit and withholds metadata when binding fails",
    async (backend) => {
      registryDeps.bindPendingSpawnSession.mockReturnValueOnce(false);
      const terminate = vi.fn(async () => false);

      const result = settleSpawnedMainOwnedAgentSession({
        backend,
        owner: owner as never,
        requestId: "spawn-a",
        sessionId: "session-a",
        authority,
        pending,
        recovery: null,
        persistedPane,
        terminate,
      });

      expect(terminate).toHaveBeenCalledTimes(1);
      await expect(result).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(
          new RegExp(
            `could not bind spawned ${backend} session.*physical exit was not proven`,
            "i",
          ),
        ),
      });
      expect(registryDeps.attachSessionScope).not.toHaveBeenCalled();
      expect(registryDeps.attachOrchMeta).not.toHaveBeenCalled();
    },
  );
});
