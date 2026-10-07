import { isDeepStrictEqual } from 'node:util';
import type { WebContents } from "electron";
import type { z } from "zod";
import { spawnRequestSchema } from "../../shared/ipc";
import { hasCurrentMissionRuntimeCloseVerdict } from "../../shared/mission-recovery-policy";
import { hasCurrentDispatchAuthority } from "../../shared/mission-intent";
import { PET_STUDIO_SQUAD_ID } from "../../shared/pet-studio";
import type { SpawnResult } from "../../shared/types";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { requireRendererWorkspaceScope, requireLiveRendererWorkspaceScope } from "../persistence/renderer-workspace-scope";
import { getOrchSettings } from "../persistence/settings-store";
import {
  assertPendingRecoverySpawnGrantActive,
  assertPendingSpawnGrantActive,
  assertMissionSpawnAuthorityCurrent,
  attachOrchMeta,
  attachSessionScope,
  bindPendingRecoverySpawnSession,
  bindPendingSpawnSession,
  claimPendingRecoverySpawnMeta,
  claimPendingSpawnMeta,
  claimPendingSpawnMetaByPane,
  hasLivePaneSession,
  type PendingRecoverySpawnMeta,
  type PendingSpawnMeta,
} from "./pane-registry";
import {
  createScopedMissionPaneStore,
  type ScopedMissionPaneSpec,
} from "./mission-pane-store";
import { createScopedMissionStore } from "./mission-store";
import {
  resolveMissionPaneAuthoritySeal,
  sameMissionPaneApprovalSeal,
  sameMissionPaneAuthoritySeal,
} from "./mission-pane-authority";
import { isOperatorTabResumeTransferSource } from "./operator-tab-mission-resume";
import { listSquads } from "./squad-store";
import {
  bindSpawnAuthority,
  consumeImmediateSquadSpawnGrant,
  type BoundSpawnAuthority,
  type ImmediateSquadSpawnRuntimeRequest,
  type SpawnAuthority,
} from "./spawn-authority";

export type MainOwnedAgentSpawnRequest = z.infer<
  typeof spawnRequestSchema
>;

const MAIN_SEALED_AGENT_COLS = 120;
const MAIN_SEALED_AGENT_ROWS = 36;

export interface AuthorizedMainOwnedAgentSpawn {
  readonly request: MainOwnedAgentSpawnRequest;
  readonly pending: PendingSpawnMeta | null;
  readonly recovery: PendingRecoverySpawnMeta | null;
  readonly persistedPane: ScopedMissionPaneSpec | null;
}

export interface ResolvedMainOwnedAgentSpawn
  extends AuthorizedMainOwnedAgentSpawn {
  readonly authority: BoundSpawnAuthority;
}

function immediateRuntimeRequest(
  request: MainOwnedAgentSpawnRequest,
): ImmediateSquadSpawnRuntimeRequest {
  return {
    adapterId: request.adapterId ?? "",
    model: request.model ?? null,
    accountId: request.accountId ?? null,
    effort: request.effort ?? null,
    paneId: request.paneId ?? "",
    missionId: request.missionId ?? null,
  };
}

export function bindMissionLaunchAuthority(
  runtimeManager: ProjectRuntimeManager | null,
  authority: BoundSpawnAuthority,
  requestedMissionId: string | undefined,
): BoundSpawnAuthority {
  const boundMissionId = authority.context?.missionId;
  if (
    requestedMissionId &&
    boundMissionId &&
    requestedMissionId !== boundMissionId
  ) {
    throw new Error("spawn mission does not match main-owned authority");
  }
  const missionId = requestedMissionId ?? boundMissionId;
  if (missionId) {
    if (authority.source === "direct-user" || !authority.context) {
      throw new Error("mission agent spawn requires main-owned role authority");
    }
    if (!runtimeManager) {
      throw new Error("project-scoped PTY runtime is not initialized");
    }
    const coordinationScope = authority.coordinationScope ?? authority.scope;
    const mission = createScopedMissionStore(
      runtimeManager,
      coordinationScope,
    ).get(missionId);
    if (!mission) {
      throw new Error("mission not found for spawn authority");
    }
    if (
      authority.context.squadId &&
      mission.squadId !== authority.context.squadId
    ) {
      throw new Error("mission squad does not match spawn authority");
    }
    if (hasCurrentMissionRuntimeCloseVerdict(mission) || !hasCurrentDispatchAuthority(mission)) {
      throw new Error(
        "approval_required: mission current intent is not authorized for agent spawn",
      );
    }
    return Object.freeze({
      ...authority,
      context: Object.freeze({
        ...authority.context,
        missionId,
        // The renderer/persisted pane never authors squad identity. Rebind it
        // from the current scoped mission so specialized native policy (Pet
        // Studio resume) can require the exact current squad + pane seal.
        ...(mission.squadId ? { squadId: mission.squadId } : {}),
      }),
    });
  }

  if (authority.source === "legacy-squad") {
    const squadId = authority.context?.squadId;
    const isImmediateException =
      squadId === PET_STUDIO_SQUAD_ID ||
      getOrchSettings().intentFirstMissionRuntimeV1 === false;
    if (!isImmediateException) {
      throw new Error(
        "intent-first: immediate squad spawn is not authorized",
      );
    }
  }
  return authority;
}

/**
 * A renderer presents a pending token; it never authors the process request
 * carried by that token. The comparison happens before adapter/provider work.
 */
function spawnFenceValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value.slice(0, 96) || "''";
  return String(value);
}

/** Named divergences so a fence rejection is diagnosable in the field. */
function spawnFenceMismatches(
  checks: ReadonlyArray<readonly [string, unknown, unknown]>,
): string[] {
  return checks
    .filter(([, left, right]) => left !== right)
    .map(
      ([name, left, right]) =>
        `${name}[${spawnFenceValue(left)} != ${spawnFenceValue(right)}]`,
    );
}

function canonicalizePendingSpawnRequest(
  request: MainOwnedAgentSpawnRequest,
  pending: PendingSpawnMeta,
): MainOwnedAgentSpawnRequest {
  const sealed = pending.sealedRequest;
  if (sealed === undefined) {
    throw new Error(
      "renderer payload does not match main-sealed pending spawn request " +
        "— divergências: sealedRequest ausente",
    );
  }
  const mismatches = spawnFenceMismatches([
    ["kind", request.kind, "cli-agent"],
    ["orchRequestId", request.orchRequestId, sealed.requestId],
    ["paneId", request.paneId, sealed.paneId],
    ["adapterId", request.adapterId, sealed.adapterId],
    ["model", request.model, sealed.model],
    ["accountId", request.accountId, sealed.accountId],
    ["effort", request.effort, sealed.effort],
    ["cwd", request.cwd, sealed.cwd],
    ["missionId", request.missionId, sealed.missionId],
    ["resume", request.resume === true, false],
    ["resumeLatestOnly", request.resumeLatestOnly === true, false],
    [
      "restorePersistedAuthority",
      request.restorePersistedAuthority === true,
      false,
    ],
    ["shell", request.shell, undefined],
  ]);
  if (mismatches.length > 0) {
    throw new Error(
      "renderer payload does not match main-sealed pending spawn request " +
        `— divergências: ${mismatches.slice(0, 6).join("; ")}`,
    );
  }

  return {
    kind: "cli-agent",
    cols: MAIN_SEALED_AGENT_COLS,
    rows: MAIN_SEALED_AGENT_ROWS,
    adapterId: sealed.adapterId,
    model: sealed.model,
    accountId: sealed.accountId,
    effort: sealed.effort,
    cwd: sealed.cwd,
    orchRequestId: sealed.requestId,
    missionId: sealed.missionId,
    paneId: sealed.paneId,
    // F-721: o resume vem do pedido que o MAIN selou (retomada da aba,
    // `nexus_pane_spawn { resume }`), nunca do renderer — a cerca acima segue
    // exigindo `resume` ausente no payload. Descartá-lo aqui fazia a retomada
    // da conversa nascer como conversa nova (`--session-id` ditado).
    resume: sealed.resume === true,
    resumeLatestOnly: false,
    restorePersistedAuthority: false,
  };
}

/**
 * F-721: o pane de origem de uma retomada da aba em andamento é do Main.
 * Restore, remontagem e Reiniciar do renderer não o religam: o segundo
 * processo nascia com sessão nova e ficava com a conta da retomada certa.
 */
function assertPersistedPaneNotInTabResumeTransfer(
  persisted: Pick<ScopedMissionPaneSpec, "missionId" | "paneId">,
): void {
  if (
    persisted.paneId &&
    isOperatorTabResumeTransferSource(persisted.missionId, persisted.paneId)
  ) {
    throw new Error(
      "persisted mission pane authority is moving: a retomada da missão da aba " +
        "está levando a conversa deste orquestrador para outro pane; este pane " +
        "não é religado",
    );
  }
}

/**
 * Persisted mission panes are also main-owned process envelopes. Recovery can
 * choose exact resume or one explicitly fresh process, never provider/model/
 * credential/filesystem identity.
 */
function canonicalizePersistedSpawnRequest(
  request: MainOwnedAgentSpawnRequest,
  persisted: ScopedMissionPaneSpec,
  recovery: PendingRecoverySpawnMeta | null,
  paneSessionAlive: boolean,
): MainOwnedAgentSpawnRequest {
  const expectedCwd =
    persisted.cwd ??
    persisted.executionScope?.rootRealPath ??
    persisted.scope.rootRealPath;
  const ambiguousMode =
    request.resume === true &&
    request.restorePersistedAuthority === true;
  const explicitFresh =
    request.resume !== true &&
    request.restorePersistedAuthority === true;
  // Mode policy: main resolves the mode from its own evidence, never from the
  // renderer's word alone. With a recovery grant pending, the grant's
  // fresh-context intent WINS (a consent-resume racing the driver's recovery
  // used to dead-end BOTH paths). Without a grant: a live pane session always
  // reattaches (adoption/exact resume — the renderer cannot destroy a live
  // identity), and an explicitly fresh request is honored only when main
  // proves NO session of this pane is alive (launcher/bridge fallback after
  // the sealed session died; retrying used to dead-end on the one-shot grant
  // with modo(fresh exige grant)). An ambiguous resume+fresh payload stays
  // fenced.
  const effectiveFresh =
    recovery !== null || (explicitFresh && !paneSessionAlive);
  const effectiveResume = !effectiveFresh;
  const mismatches = spawnFenceMismatches([
    ["modo(resume+fresh simultâneos)", ambiguousMode, false],
    ["kind", request.kind, "cli-agent"],
    // Sem recovery grant, o renderer pode ainda carregar o orchRequestId
    // histórico do pane (persistido no layout salvo; os maps de grant do main
    // morrem no restart). O registro persistido é a autoridade mais forte —
    // resolveSpawnAuthority já tolera o id antigo, a fence não pode rejeitá-lo
    // antes. Com recovery ativo, o id tem que ser exatamente o do grant.
    ...(recovery
      ? ([
          ["orchRequestId", request.orchRequestId, recovery.request.requestId],
        ] as const)
      : []),
    ["paneId", request.paneId, persisted.paneId],
    ["adapterId", request.adapterId, persisted.adapterId],
    ["model", request.model, persisted.model],
    ["accountId", request.accountId, persisted.accountId],
    ["effort", request.effort, persisted.effort],
    ["cwd", request.cwd, expectedCwd],
    ["missionId", request.missionId, persisted.missionId],
    ["resumeLatestOnly", request.resumeLatestOnly === true, false],
    ["shell", request.shell, undefined],
    ...(recovery
      ? ([
          ["recovery.paneId", recovery.request.paneId, persisted.paneId],
          [
            "recovery.missionId",
            recovery.request.missionId,
            persisted.missionId,
          ],
          ["recovery.role", recovery.request.role, persisted.role],
          [
            "recovery.adapterId",
            recovery.request.pane.adapterId,
            persisted.adapterId,
          ],
          ["recovery.model", recovery.request.pane.model, persisted.model],
          [
            "recovery.accountId",
            recovery.request.pane.accountId,
            persisted.accountId,
          ],
          ["recovery.effort", recovery.request.pane.effort, persisted.effort],
          ["recovery.cwd", recovery.request.pane.cwd, persisted.cwd],
        ] as const)
      : []),
  ]);
  if (mismatches.length > 0) {
    throw new Error(
      "renderer payload does not match main-sealed persisted pane request " +
        `— divergências: ${mismatches.slice(0, 6).join("; ")}`,
    );
  }

  return {
    kind: "cli-agent",
    cols: MAIN_SEALED_AGENT_COLS,
    rows: MAIN_SEALED_AGENT_ROWS,
    adapterId: persisted.adapterId,
    model: persisted.model,
    accountId: persisted.accountId,
    effort: persisted.effort,
    cwd: expectedCwd,
    ...(recovery
      ? { orchRequestId: recovery.request.requestId }
      : {}),
    missionId: persisted.missionId,
    paneId: persisted.paneId,
    resume: effectiveResume,
    resumeLatestOnly: false,
    restorePersistedAuthority: effectiveFresh,
  };
}

function assertCurrentPersistedPaneAuthority(
  runtimeManager: ProjectRuntimeManager,
  persisted: ScopedMissionPaneSpec,
): ScopedMissionPaneSpec {
  const mission = createScopedMissionStore(
    runtimeManager,
    persisted.scope,
  ).get(persisted.missionId);
  const targetSquadId =
    mission?.squadId ??
    listSquads().find((candidate) => candidate.id === "nexus-fullstack")?.id ??
    listSquads().find((candidate) => candidate.id !== PET_STUDIO_SQUAD_ID)?.id;
  const squads = listSquads().filter(
    (candidate) => candidate.id === targetSquadId,
  );
  const currentSeal = mission
    ? resolveMissionPaneAuthoritySeal(
        persisted.scope,
        mission,
        mission.squadId && squads.length === 1 ? squads[0] : null,
      )
    : null;
  if (sameMissionPaneAuthoritySeal(persisted.authoritySeal, currentSeal)) {
    return persisted;
  }
  if (
    persisted.role === "orchestrator" &&
    currentSeal &&
    sameMissionPaneApprovalSeal(persisted.authoritySeal, currentSeal)
  ) {
    return createScopedMissionPaneStore(
      runtimeManager,
      persisted.scope,
    ).rebindOrchestratorAuthority({
      missionId: persisted.missionId,
      paneId: persisted.paneId!,
      expectedAuthoritySeal: persisted.authoritySeal!,
      authoritySeal: currentSeal,
    });
  }
  const seal = persisted.authoritySeal;
  const detail = !mission
    ? "missão ausente no store"
    : mission.status !== "running"
      ? `status=${mission.status}/${mission.intentState ?? "?"} — missão precisa estar running`
      : mission.squadId && squads.length !== 1
        ? `squad '${mission.squadId ?? targetSquadId ?? "?"}' indisponível`
        : !currentSeal
          ? `seal atual nulo (status=${mission.status}/${mission.intentState ?? "?"} — missão precisa estar running)`
          : !seal
            ? "pane sem authoritySeal persistido (legado)"
            : spawnFenceMismatches([
                ["intentVersion", seal.intentVersion, currentSeal.intentVersion],
                [
                  "intentContractHash",
                  seal.intentContractHash,
                  currentSeal.intentContractHash,
                ],
                [
                  "squadRevisionHash",
                  seal.squadRevisionHash,
                  currentSeal.squadRevisionHash,
                ],
                ["contextRevision", seal.contextRevision, currentSeal.contextRevision],
                ["contractHash", seal.contractHash, currentSeal.contractHash],
              ]).join("; ");
  throw new Error(
    "stale or legacy persisted mission pane authority; replane and approve " +
      `the current revision — divergências: ${detail}`,
  );
}

/**
 * Renderer layout outlives Main state: a pane can resurrect carrying a
 * missionId that exists nowhere in the scope store (deleted row, pane copied
 * between workspaces). That stale binding must never fence a live pane —
 * warn once per (paneId, claimed mission) so sync/heartbeat retries don't
 * spam, and let the fail-closed path below decide.
 */
const staleRendererMissionWarned = new Set<string>();

function warnStaleRendererMissionBinding(
  paneId: string,
  claimedMissionId: string,
  detail: string,
): void {
  const key = `${paneId}${claimedMissionId}`;
  if (staleRendererMissionWarned.has(key)) return;
  staleRendererMissionWarned.add(key);
  console.warn(
    `[mission-pane] missionId do renderer ignorado: pane ${paneId} ` +
      `alega '${claimedMissionId}' que não existe no escopo — ${detail}`,
  );
}

/**
 * Claims and canonicalizes every opaque renderer token at one main-process
 * boundary. Both PTY and RPC consume this exact envelope.
 */
export function authorizeMainOwnedAgentSpawn(
  owner: WebContents,
  request: MainOwnedAgentSpawnRequest,
  runtimeManager: ProjectRuntimeManager | null,
): AuthorizedMainOwnedAgentSpawn {
  let canonicalRequest = request;
  const pending = request.orchRequestId
    ? claimPendingSpawnMeta(request.orchRequestId, owner)
    : request.paneId && request.missionId
      ? claimPendingSpawnMetaByPane(
          {
            paneId: request.paneId,
            missionId: request.missionId,
          },
          owner,
        )
    : null;
  if (pending) {
    const sealedRequestId = pending.sealedRequest?.requestId;
    const pendingRequest =
      !canonicalRequest.orchRequestId && sealedRequestId
        ? { ...canonicalRequest, orchRequestId: sealedRequestId }
        : canonicalRequest;
    canonicalRequest = canonicalizePendingSpawnRequest(
      pendingRequest,
      pending,
    );
  }

  let recovery: PendingRecoverySpawnMeta | null = null;
  if (!pending && canonicalRequest.orchRequestId) {
    recovery = claimPendingRecoverySpawnMeta(
      canonicalRequest.orchRequestId,
      owner,
    );
  }

  let persistedPane: ScopedMissionPaneSpec | null = null;
  let rendererScope: ReturnType<typeof requireRendererWorkspaceScope> | null =
    null;
  if (
    !pending &&
    canonicalRequest.kind !== "shell" &&
    canonicalRequest.paneId &&
    (
      canonicalRequest.resume ||
      canonicalRequest.restorePersistedAuthority ||
      Boolean(canonicalRequest.missionId)
    )
  ) {
    if (!runtimeManager) {
      throw new Error("project-scoped PTY runtime is not initialized");
    }
    const scope = requireRendererWorkspaceScope(owner);
    rendererScope = scope;
    const found = createScopedMissionPaneStore(
      runtimeManager,
      scope,
    ).findByPaneId(canonicalRequest.paneId);
    if (
      found &&
      canonicalRequest.missionId &&
      canonicalRequest.missionId !== found.missionId &&
      !createScopedMissionStore(runtimeManager, scope).get(
        canonicalRequest.missionId,
      )
    ) {
      // O layout do renderer traz um missionId que não existe em lugar
      // nenhum do escopo: vínculo órfão, não conflito. A spec persistida é
      // a autoridade — o request herda o missionId dela antes do gate e da
      // fence (resume e fresh). Uma missão alegada que EXISTE é divergência
      // real e segue cercada abaixo.
      warnStaleRendererMissionBinding(
        canonicalRequest.paneId,
        canonicalRequest.missionId,
        `persistido=${found.missionId}`,
      );
      canonicalRequest = { ...canonicalRequest, missionId: found.missionId };
    }
    if (
      found &&
      (
        canonicalRequest.resume ||
        canonicalRequest.restorePersistedAuthority ||
        canonicalRequest.missionId === found.missionId
      )
    ) {
      persistedPane = assertCurrentPersistedPaneAuthority(
        runtimeManager,
        found,
      );
      assertPersistedPaneNotInTabResumeTransfer(persistedPane);
      const livenessPaneId = persistedPane.paneId ?? canonicalRequest.paneId;
      canonicalRequest = canonicalizePersistedSpawnRequest(
        canonicalRequest,
        persistedPane,
        recovery,
        livenessPaneId !== undefined && hasLivePaneSession(livenessPaneId),
      );
    }
  }
  if (recovery && !persistedPane) {
    throw new Error("pane recovery has no current persisted authority");
  }
  if (
    !pending &&
    !persistedPane &&
    rendererScope &&
    runtimeManager &&
    canonicalRequest.missionId &&
    canonicalRequest.paneId &&
    !createScopedMissionStore(runtimeManager, rendererScope).get(
      canonicalRequest.missionId,
    )
  ) {
    // Pane sem spec persistido reivindicando missão inexistente: carimbo
    // órfão do layout (missão apagada/pane copiado entre workspaces). Sem o
    // strip o pane nunca mais abria — "no longer registered" eterno. Uma
    // missão que EXISTE continua fechando abaixo.
    warnStaleRendererMissionBinding(
      canonicalRequest.paneId,
      canonicalRequest.missionId,
      "sem spec persistido — segue como pane direto",
    );
    canonicalRequest = {
      ...canonicalRequest,
      missionId: undefined,
      orchRequestId: undefined,
    };
  }
  if (
    !pending &&
    !persistedPane &&
    !canonicalRequest.orchRequestId &&
    canonicalRequest.missionId &&
    canonicalRequest.paneId
  ) {
    throw new Error(
      "stale persisted mission pane authority: pane is no longer registered by Main",
    );
  }

  return Object.freeze({
    request: canonicalRequest,
    pending,
    recovery,
    persistedPane,
  });
}

/**
 * Resolves the single immutable role/scope/runtime authority used by either
 * physical transport. One-shot immediate grants are consumed here.
 */
export function resolveMainOwnedAgentSpawn(
  owner: WebContents,
  envelope: AuthorizedMainOwnedAgentSpawn,
  runtimeManager: ProjectRuntimeManager | null,
): ResolvedMainOwnedAgentSpawn {
  const squads = listSquads();
  const needsActiveScope =
    !envelope.pending?.scope && !envelope.persistedPane?.scope;
  const trustedUserScope = needsActiveScope
    ? requireRendererWorkspaceScope(owner)
    : null;
  let requestId = envelope.request.orchRequestId;
  let immediateGrant: SpawnAuthority | null = null;
  let sealedImmediateRuntime:
    | import("./spawn-authority").ImmediateSquadSpawnRuntime
    | null = null;
  if (
    requestId &&
    !envelope.pending &&
    !envelope.persistedPane
  ) {
    const consumed = trustedUserScope
      ? consumeImmediateSquadSpawnGrant({
          requestId,
          owner,
          scope: trustedUserScope,
          squads,
          runtime: immediateRuntimeRequest(envelope.request),
        })
      : null;
    immediateGrant = consumed?.authority ?? null;
    sealedImmediateRuntime = consumed?.runtime ?? null;
    if (!immediateGrant) {
      if (
        requestId.startsWith("orchspawn-") &&
        !envelope.request.missionId
      ) {
        requestId = undefined;
      } else {
        throw new Error(
          `unknown or expired orchestration spawn grant: ${requestId}`,
        );
      }
    }
  }
  const runtimeRequest = sealedImmediateRuntime
    ? {
        ...envelope.request,
        adapterId: sealedImmediateRuntime.adapterId,
        model: sealedImmediateRuntime.model ?? undefined,
        accountId: sealedImmediateRuntime.accountId ?? undefined,
        effort: sealedImmediateRuntime.effort ?? undefined,
        paneId: sealedImmediateRuntime.paneId,
        missionId: sealedImmediateRuntime.missionId ?? undefined,
      }
    : envelope.request;
  const authority = bindMissionLaunchAuthority(
    runtimeManager,
    bindSpawnAuthority({
      requestId,
      pending: envelope.pending,
      immediateGrant,
      squads,
      persistedPane: envelope.persistedPane,
      trustedUserScope,
      requestedCwd: envelope.request.cwd,
    }),
    runtimeRequest.missionId,
  );

  return Object.freeze({
    ...envelope,
    request: runtimeRequest,
    authority,
  });
}

/** Exact pre-effect fence shared by PTY spawn and the RPC spawn callback. */
export function assertMainOwnedAgentSpawnGrantActive(input: {
  readonly owner: WebContents;
  readonly requestId: string | undefined;
  readonly pending: PendingSpawnMeta | null;
  readonly recovery: PendingRecoverySpawnMeta | null;
  /** F-721: a retomada da aba pode ter começado durante a preparação. */
  readonly persistedPane?: ScopedMissionPaneSpec | null;
  readonly runtimeManager?: ProjectRuntimeManager | null;
}): void {
  const assertMissionStillDispatchable = (missionId: string, scope: ScopedMissionPaneSpec['scope']) => {
    if (!input.runtimeManager) throw new Error('mission runtime authority unavailable');
    const mission = createScopedMissionStore(input.runtimeManager, scope).get(missionId);
    if (!mission || hasCurrentMissionRuntimeCloseVerdict(mission) || !hasCurrentDispatchAuthority(mission)) {
      throw new Error('approval_required: mission stopped during spawn preparation');
    }
  };
  if (input.persistedPane) {
    const pane = input.persistedPane;
    assertPersistedPaneNotInTabResumeTransfer(pane);
    requireLiveRendererWorkspaceScope(input.owner, pane.scope);
    if (!input.runtimeManager || !pane.paneId) throw new Error('persisted pane runtime authority unavailable');
    const current = createScopedMissionPaneStore(input.runtimeManager, pane.scope).findByPaneId(pane.paneId);
    if (!isDeepStrictEqual(current, pane)) throw new Error('persisted mission pane authority changed during preparation');
    assertMissionStillDispatchable(pane.missionId, pane.scope);
    assertMissionSpawnAuthorityCurrent({ missionId: pane.missionId, scope: pane.scope,
      contextRevision: pane.authoritySeal?.contextRevision, authoritySeal: pane.authoritySeal });
  }
  if (input.pending && input.requestId) {
    assertPendingSpawnGrantActive(input.requestId, input.owner);
    if (
      input.pending.missionId &&
      (input.pending.role === "orchestrator" ||
        input.pending.role === "worker") &&
      input.pending.scope
    ) {
      assertMissionStillDispatchable(input.pending.missionId, input.pending.scope);
      assertMissionSpawnAuthorityCurrent({
        missionId: input.pending.missionId,
        scope: input.pending.scope,
        contextRevision: input.pending.contextRevision,
        authoritySeal: input.pending.authoritySeal,
      });
    }
  }
  if (input.recovery && input.requestId) {
    assertPendingRecoverySpawnGrantActive(input.requestId, input.owner);
    assertMissionStillDispatchable(input.recovery.request.missionId, input.recovery.scope);
  }
}

function attachSpawnedSessionAuthority(input: {
  readonly owner: WebContents;
  readonly sessionId: string;
  readonly authority: BoundSpawnAuthority;
  readonly persistedPane: ScopedMissionPaneSpec | null;
}): void {
  attachSessionScope(input.sessionId, input.authority.coordinationScope ?? input.authority.scope);
  const paneId = input.persistedPane?.paneId;
  if (!input.persistedPane || !paneId) return;
  attachOrchMeta(input.owner, paneId, {
    missionId: input.persistedPane.missionId,
    agentName: input.persistedPane.agentName,
    workerIncarnationId: input.persistedPane.workerIncarnationId,
    role: input.persistedPane.role,
    scope: input.persistedPane.scope,
    executionScope: input.persistedPane.executionScope,
    allowedTools: input.persistedPane.allowedTools,
    allowedSkills: input.persistedPane.allowedSkills,
    contextRevision: input.persistedPane.authoritySeal?.contextRevision,
    authoritySeal: input.persistedPane.authoritySeal
      ? Object.freeze({ ...input.persistedPane.authoritySeal })
      : undefined,
  });
}

async function terminateUnboundSession(
  backend: "PTY" | "RPC",
  label: "orchestration request" | "pane recovery",
  terminate: () => Promise<boolean>,
): Promise<SpawnResult> {
  try {
    const exited = await terminate();
    return {
      ok: false as const,
      error: exited
        ? `${label} could not bind spawned ${backend} session`
        : `${label} could not bind spawned ${backend} session; ` +
          "physical exit was not proven and replacement remains denied",
    };
  } catch {
    return {
      ok: false as const,
      error:
        `${label} could not bind spawned ${backend} session; ` +
        "physical exit was not proven and replacement remains denied",
    };
  }
}

/**
 * Durable post-spawn transaction shared by PTY and RPC. Binding happens before
 * metadata publication; a failed bind awaits exact physical termination and
 * never makes the orphan visible as an authorized mission session.
 */
export function settleSpawnedMainOwnedAgentSession(input: {
  readonly backend: "PTY" | "RPC";
  readonly owner: WebContents;
  readonly requestId: string | undefined;
  readonly sessionId: string;
  readonly authority: BoundSpawnAuthority;
  readonly pending: PendingSpawnMeta | null;
  readonly recovery: PendingRecoverySpawnMeta | null;
  readonly persistedPane: ScopedMissionPaneSpec | null;
  readonly terminate: () => Promise<boolean>;
}): Promise<SpawnResult> | null {
  if (
    input.authority.source === "pending" &&
    (!input.requestId ||
      !bindPendingSpawnSession(
        input.requestId,
        input.owner,
        input.sessionId,
      ))
  ) {
    return terminateUnboundSession(
      input.backend,
      "orchestration request",
      input.terminate,
    );
  }
  if (
    input.recovery &&
    (!input.requestId ||
      !bindPendingRecoverySpawnSession(
        input.requestId,
        input.owner,
        input.sessionId,
      ))
  ) {
    return terminateUnboundSession(
      input.backend,
      "pane recovery",
      input.terminate,
    );
  }
  attachSpawnedSessionAuthority(input);
  return null;
}
