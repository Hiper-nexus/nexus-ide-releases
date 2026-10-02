import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PendingRecoverySpawnMeta,
  PendingSpawnMeta,
} from "./pane-registry";

const registryDeps = vi.hoisted(() => ({
  assertMissionSpawnAuthorityCurrent: vi.fn(),
  assertPendingSpawnGrantActive: vi.fn(),
  assertPendingRecoverySpawnGrantActive: vi.fn(),
  claimPendingSpawnMeta: vi.fn((): PendingSpawnMeta | null => null),
  claimPendingSpawnMetaByPane: vi.fn(
    (): PendingSpawnMeta | null => null,
  ),
  claimPendingRecoverySpawnMeta: vi.fn(
    (): PendingRecoverySpawnMeta | null => null,
  ),
  hasLivePaneSession: vi.fn(() => false),
  bindPendingSpawnSession: vi.fn(() => true),
  bindPendingRecoverySpawnSession: vi.fn(() => true),
  attachSessionScope: vi.fn(),
  attachOrchMeta: vi.fn(),
}));
const missionDeps = vi.hoisted(() => ({
  mission: null as { id: string; squadId?: string } | null,
}));
const missionPaneDeps = vi.hoisted(() => ({
  pane: null as typeof persistedPane | null,
}));

vi.mock("./pane-registry", () => ({
  assertMissionSpawnAuthorityCurrent:
    registryDeps.assertMissionSpawnAuthorityCurrent,
  assertPendingSpawnGrantActive:
    registryDeps.assertPendingSpawnGrantActive,
  assertPendingRecoverySpawnGrantActive:
    registryDeps.assertPendingRecoverySpawnGrantActive,
  claimPendingSpawnMeta: registryDeps.claimPendingSpawnMeta,
  claimPendingSpawnMetaByPane: registryDeps.claimPendingSpawnMetaByPane,
  claimPendingRecoverySpawnMeta:
    registryDeps.claimPendingRecoverySpawnMeta,
  hasLivePaneSession: registryDeps.hasLivePaneSession,
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
vi.mock("./mission-pane-store", () => ({
  createScopedMissionPaneStore: () => ({
    findByPaneId: () => missionPaneDeps.pane,
  }),
}));
vi.mock("../persistence/renderer-workspace-scope", () => ({
  requireRendererWorkspaceScope: () => scope,
}));
vi.mock("../../shared/mission-intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/mission-intent")>()),
  hasCurrentDispatchAuthority: () => true,
}));
// Selo atual da missão para o caminho do pane persistido (F-721): o resto da
// comparação de selo é o código real.
const sealDeps = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./mission-pane-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mission-pane-authority")>()),
  resolveMissionPaneAuthoritySeal: () => sealDeps.current,
}));

import {
  authorizeMainOwnedAgentSpawn,
  assertMainOwnedAgentSpawnGrantActive,
  bindMissionLaunchAuthority,
  settleSpawnedMainOwnedAgentSession,
} from "./main-owned-agent-spawn";
import {
  beginOperatorTabResumeTransfer,
  resetOperatorTabResumeTransfersForTests,
} from "./operator-tab-mission-resume";
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
    missionPaneDeps.pane = null;
    sealDeps.current = null;
    resetOperatorTabResumeTransfersForTests();
    registryDeps.claimPendingSpawnMeta.mockReturnValue(null);
    registryDeps.claimPendingSpawnMetaByPane.mockReturnValue(null);
    registryDeps.claimPendingRecoverySpawnMeta.mockReturnValue(null);
    registryDeps.hasLivePaneSession.mockReturnValue(false);
    registryDeps.bindPendingSpawnSession.mockReturnValue(true);
    registryDeps.bindPendingRecoverySpawnSession.mockReturnValue(true);
  });

  it("restores the main-sealed pending authority when presentation loses its token", () => {
    const sealedRequest = {
      requestId: "spawn-a",
      paneId: "pane-a",
      adapterId: "claude",
      model: undefined,
      accountId: undefined,
      effort: undefined,
      cwd: scope.rootRealPath,
      title: "Worker",
      missionId: "mission-a",
      agentName: "worker-a",
      role: "worker" as const,
      resume: false,
      resumeLatestOnly: false,
      restorePersistedAuthority: false,
    } as const;
    registryDeps.claimPendingSpawnMetaByPane.mockReturnValueOnce({
      ...pending,
      requestedCwd: scope.rootRealPath,
      sealedRequest,
    });

    const authorized = authorizeMainOwnedAgentSpawn(
      owner as never,
      {
        kind: "cli-agent",
        cols: 80,
        rows: 24,
        adapterId: "claude",
        cwd: scope.rootRealPath,
        paneId: "pane-a",
        missionId: "mission-a",
      },
      {} as never,
    );

    expect(registryDeps.claimPendingSpawnMetaByPane).toHaveBeenCalledWith(
      { paneId: "pane-a", missionId: "mission-a" },
      owner,
    );
    expect(authorized.pending?.sealedRequest).toEqual(sealedRequest);
    expect(authorized.request).toMatchObject({
      kind: "cli-agent",
      cols: 120,
      rows: 36,
      adapterId: "claude",
      cwd: scope.rootRealPath,
      orchRequestId: "spawn-a",
      paneId: "pane-a",
      missionId: "mission-a",
    });
  });

  it("classifies an orphaned mission layout pane as stale persisted authority when the claimed mission exists", () => {
    // A missão alegada EXISTE no escopo: é conflito real, a recusa fica.
    missionDeps.mission = { id: "mission-deleted" };
    expect(() =>
      authorizeMainOwnedAgentSpawn(
        owner as never,
        {
          kind: "cli-agent",
          cols: 80,
          rows: 24,
          adapterId: "claude",
          cwd: scope.rootRealPath,
          paneId: "pane-from-deleted-mission",
          missionId: "mission-deleted",
        },
        {} as never,
      ),
    ).toThrow(/persisted mission pane authority.*no longer registered/i);
  });

  it("strips a renderer missionId that names a mission Main has never seen", () => {
    // Sem spec persistido e missão alegada inexistente no escopo: o carimbo é
    // órfão do layout — o spawn segue como pane direto em vez de fechar para
    // sempre em "no longer registered".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const authorized = authorizeMainOwnedAgentSpawn(
      owner as never,
      {
        kind: "cli-agent",
        cols: 80,
        rows: 24,
        adapterId: "claude",
        cwd: scope.rootRealPath,
        paneId: "pane-from-deleted-mission",
        missionId: "mission-deleted",
        orchRequestId: "orchspawn-stale-do-layout",
      },
      {} as never,
    );

    expect(authorized.persistedPane).toBeNull();
    expect(authorized.request.missionId).toBeUndefined();
    expect(authorized.request.orchRequestId).toBeUndefined();
    expect(warn).toHaveBeenCalled();
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

  it("F-721: o pane antigo do líder não religa enquanto a retomada da aba leva a conversa", () => {
    // Campo 02/10 07:01: o renderer religou o pane do Maestro antigo durante
    // a retomada da aba; ele nasceu com sessão nova e tomou a conta Claude.
    missionDeps.mission = { id: "mission-a" };
    sealDeps.current = authoritySeal;
    const leaderPane = {
      ...persistedPane,
      role: "orchestrator" as const,
      title: "Orquestrador",
      agentName: "Orquestrador",
      allowedTools: null,
      allowedSkills: null,
      authoritySeal,
    };
    missionPaneDeps.pane = leaderPane as never;
    const restore = {
      kind: "cli-agent" as const,
      cols: 80,
      rows: 24,
      adapterId: "claude",
      cwd: scope.rootRealPath,
      paneId: "pane-a",
      missionId: "mission-a",
      resume: true,
    };

    const release = beginOperatorTabResumeTransfer("mission-a", "pane-a");
    expect(release).toBeTypeOf("function");
    try {
      expect(() =>
        authorizeMainOwnedAgentSpawn(owner as never, restore, {} as never),
      ).toThrow(/persisted mission pane authority is moving/);
      // A retomada pode começar enquanto o restore prepara a conta: a cerca
      // pré-efeito confere de novo antes do processo nascer.
      expect(() =>
        assertMainOwnedAgentSpawnGrantActive({
          owner: owner as never,
          requestId: undefined,
          pending: null,
          recovery: null,
          persistedPane: leaderPane,
        }),
      ).toThrow(/persisted mission pane authority is moving/);
    } finally {
      release!();
    }

    // Fora da transferência o mesmo pane volta a ser retomado no lugar.
    expect(
      authorizeMainOwnedAgentSpawn(owner as never, restore, {} as never).request,
    ).toMatchObject({ paneId: "pane-a", resume: true, restorePersistedAuthority: false });
  });

  it.each(["claude", "codex"])("F-721: o resume selado pelo Main chega ao spawn do pane da retomada (%s)", (adapterId) => {
    // O pedido pendente da retomada da aba nasce com `resume: true` no Main.
    // Canonicalizado como `false`, o pane novo abria conversa nova (campo
    // 02/10 09:14: o Maestro Codex retomado começou um rollout vazio).
    const sealedRequest = {
      requestId: "spawn-resume",
      paneId: "pane-novo",
      adapterId,
      model: undefined,
      accountId: "acct-a",
      effort: undefined,
      cwd: scope.rootRealPath,
      title: "Orquestrador",
      missionId: "mission-a",
      agentName: "Orquestrador",
      role: "orchestrator" as const,
      resume: true,
      resumeLatestOnly: false,
      restorePersistedAuthority: false,
    } as const;
    const claimed = {
      ...pending,
      role: "orchestrator" as const,
      requestedCwd: scope.rootRealPath,
      exactResumeRequired: true as const,
      sealedRequest,
    };
    const fromRenderer = {
      kind: "cli-agent" as const,
      cols: 80,
      rows: 24,
      adapterId,
      accountId: "acct-a",
      cwd: scope.rootRealPath,
      paneId: "pane-novo",
      missionId: "mission-a",
      orchRequestId: "spawn-resume",
    };
    registryDeps.claimPendingSpawnMeta.mockReturnValueOnce(claimed);

    const authorized = authorizeMainOwnedAgentSpawn(
      owner as never,
      fromRenderer,
      {} as never,
    );

    expect(authorized.request).toMatchObject({ paneId: "pane-novo", resume: true });
    expect(authorized.pending?.exactResumeRequired).toBe(true);

    // O renderer continua sem poder pedir resume num token pendente.
    registryDeps.claimPendingSpawnMeta.mockReturnValueOnce(claimed);
    expect(() =>
      authorizeMainOwnedAgentSpawn(
        owner as never,
        { ...fromRenderer, resume: true },
        {} as never,
      ),
    ).toThrow(/divergências: resume/);
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
