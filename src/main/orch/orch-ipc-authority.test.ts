import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import type { Squad } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';

interface TestOwner {
  id: number;
  isDestroyed(): boolean;
  isCrashed(): boolean;
  destroy(): void;
  crash(): void;
}

const harness = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const scopes = new Map<number, ProjectExecutionScope>();
  const windows = new Map<number, { isDestroyed(): boolean }>();
  const squads: any[] = [];
  const paneSnapshots: any[] = [];
  const ompSessions: any[] = [];
  const agentSessions: any[] = [];
  const scopeChangeListeners = new Set<
    (
      owner: { id: number },
      previous: ProjectExecutionScope | null,
      next: ProjectExecutionScope | null,
    ) => void
  >();
  return {
    handlers,
    scopes,
    windows,
    squads,
    paneSnapshots,
    ompSessions,
    agentSessions,
    /** Teclado do operador: posse de sessão, missões e o que chegou ao PTY. */
    operatorInput: {
      ownedSessions: new Map<string, { missionId?: string }>(),
      missions: new Map<
        string,
        { status: string; orchestratorSessionId?: string }
      >(),
      missionPanes: [] as Array<{ id: string; missionId: string }>,
      writes: [] as Array<{ sessionId: string; data: string }>,
    },
    scopeChangeListeners,
    dialog: {
      showMessageBox: vi.fn(
        async (_window: unknown, _options: Record<string, unknown>) => ({ response: 1 }),
      ),
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
    },
    BrowserWindow: {
      fromWebContents: vi.fn((owner: { id: number }) => windows.get(owner.id) ?? null),
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      on: vi.fn(),
    },
    writeAgentSpec: vi.fn(() => ({ ok: true, path: '/home/user/.claude/agents/reviewer.md' })),
    designSquadForWorkspace: vi.fn(),
    designSquadFromIntent: vi.fn(),
    loadEnrichedCatalog: vi.fn(),
    runHarnessEnrichWithBrain: vi.fn(),
    designMdSearch: vi.fn(),
    prepareAgentSpec: vi.fn(),
    reviewCatalogInstall: vi.fn(),
    installCatalogItem: vi.fn(),
    buildRecipeOverlay: vi.fn(),
    proposeRecipes: vi.fn(),
    saveCatalogOverlay: vi.fn(),
    bootstrapMissionOrchestrator: vi.fn(),
    stopPlanPromotion: vi.fn(),
    restartPlanPromotion: vi.fn(),
    terminatePty: vi.fn(async (_sessionId: string) => true),
    missionRemovalCandidate: vi.fn(),
    removeMission: vi.fn(),
    missionApprovalCandidate: vi.fn(),
    approveMission: vi.fn(),
    planPromotionCandidate: vi.fn(),
    promotePlan: vi.fn(),
    missionLifecycleCandidate: vi.fn(),
    updateMission: vi.fn(),
    listMissions: vi.fn((): any[] => []),
    prepareClarifyAnswer: vi.fn(),
    persistClarifyAnswer: vi.fn(),
    prepareOperatorReview: vi.fn(),
    persistOperatorReview: vi.fn(),
    exportSquadsJson: vi.fn(() => JSON.stringify({ squads }, null, 2)),
    prepareSquadSave: vi.fn((raw: any) => {
      const squad = {
        ...raw,
        builtin: false,
        agents: (raw.agents ?? []).map((agent: any) => ({
          ...agent,
          ...(agent.model
            ? {}
            : agent.cli === 'agy'
              ? { model: 'gemini-3.6-flash-high' }
              : {}),
          allowedTools:
            agent.allowedTools ??
            (agent.category === 'orchestrator' ? null : []),
        })),
      };
      const exact = JSON.stringify(squad);
      const snapshot = {
        ...squad,
        nativeInstructions: squad.nativeInstructions ?? null,
        agents: squad.agents.map((agent: any) => ({
          ...agent,
          model: agent.model ?? null,
          effort: agent.effort ?? null,
          allowedTools: agent.allowedTools ?? null,
          allowedSkills: agent.allowedSkills ?? null,
        })),
        hash: createHash('sha256').update(exact).digest('hex'),
      };
      const existing = squads.find((item) => item.id === squad.id);
      return {
        squad,
        snapshot,
        canonicalJson: exact,
        canonicalSha256: snapshot.hash,
        expectedTarget: {
          id: squad.id,
          exists: Boolean(existing),
          canonicalSha256: existing
            ? createHash('sha256')
                .update(JSON.stringify(existing))
                .digest('hex')
            : null,
        },
      };
    }),
    prepareMissionRuntimeSquadSave: vi.fn((raw: any) =>
      harness.prepareSquadSave(raw),
    ),
    applyPreparedSquadSave: vi.fn((candidate: any) => {
      const squad = candidate.squad;
      const index = squads.findIndex((item) => item.id === squad.id);
      const current = index >= 0 ? squads[index] : undefined;
      const currentHash = current
        ? createHash('sha256')
            .update(JSON.stringify(current))
            .digest('hex')
        : null;
      if (
        Boolean(current) !== candidate.expectedTarget.exists ||
        currentHash !== candidate.expectedTarget.canonicalSha256
      ) {
        throw new Error('squad CAS changed while confirmation was open');
      }
      if (index >= 0) squads[index] = squad;
      else squads.push(squad);
      return squad;
    }),
    prepareSquadsImport: vi.fn((raw: string | Buffer) => {
      const rawText =
        typeof raw === 'string' ? raw : raw.toString('utf8');
      const parsed = JSON.parse(rawText);
      const squadsToImport = parsed.squads.map((squad: any) => ({
        ...squad,
        builtin: false,
        agents: (squad.agents ?? []).map((agent: any) => ({
          ...agent,
          allowedTools:
            agent.allowedTools ??
            (agent.category === 'orchestrator' ? null : []),
        })),
      }));
      const canonicalJson = JSON.stringify(
        { squads: squadsToImport },
        null,
        2,
      );
      return {
        rawSha256: createHash('sha256').update(rawText).digest('hex'),
        canonicalSha256: createHash('sha256')
          .update(canonicalJson)
          .digest('hex'),
        canonicalJson,
        squads: squadsToImport,
        snapshots: squadsToImport.map((squad: any) => ({
          ...squad,
          nativeInstructions: squad.nativeInstructions ?? null,
          agents: squad.agents.map((agent: any) => ({
            ...agent,
            model: agent.model ?? null,
            effort: agent.effort ?? null,
            allowedTools: agent.allowedTools ?? null,
            allowedSkills: agent.allowedSkills ?? null,
          })),
          hash: createHash('sha256')
            .update(JSON.stringify(squad))
            .digest('hex'),
        })),
        squadCount: squadsToImport.length,
        agentCount: squadsToImport.reduce(
          (count: number, squad: any) => count + squad.agents.length,
          0,
        ),
        targetIds: squadsToImport.map((squad: any) => squad.id),
        expectedTargets: squadsToImport.map((squad: any) => ({
          id: squad.id,
          exists: false,
          canonicalSha256: null,
        })),
      };
    }),
    applyPreparedSquadsImport: vi.fn((candidate: any) => {
      for (const squad of candidate.squads) squads.push(squad);
      return candidate.squadCount;
    }),
    saveSquad: vi.fn((squad: any) => {
      const index = squads.findIndex((item) => item.id === squad.id);
      if (index >= 0) squads[index] = squad;
      else squads.push(squad);
    }),
    deleteSquad: vi.fn((id: string) => {
      const index = squads.findIndex((item) => item.id === id);
      if (index < 0) return false;
      squads.splice(index, 1);
      return true;
    }),
    projectStores: {
      onChange: vi.fn(),
      onScope: vi.fn(),
      forScope: vi.fn(),
      listSuites: vi.fn((): any[] => []),
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: harness.BrowserWindow,
  dialog: harness.dialog,
  ipcMain: harness.ipcMain,
}));

vi.mock('../design/designmd-api-client', () => ({
  DesignMdApiClient: vi.fn().mockImplementation(() => ({
    searchKits: harness.designMdSearch,
    getKit: vi.fn(),
    publishKit: vi.fn(),
  })),
  DesignMdApiError: class DesignMdApiError extends Error {},
  DesignMdAuthError: class DesignMdAuthError extends Error {},
  DesignMdLicenseError: class DesignMdLicenseError extends Error {},
}));

vi.mock('../persistence/renderer-workspace-scope', () => ({
  requireLiveRendererWorkspaceScope: (
    owner: TestOwner,
    expected?: ProjectExecutionScope,
  ) => {
    if (owner.isDestroyed() || owner.isCrashed()) {
      throw new Error('renderer is unavailable');
    }
    const current = harness.scopes.get(owner.id);
    if (!current) throw new Error('renderer has no authorized workspace scope');
    if (
      expected &&
      (current.installationId !== expected.installationId ||
        current.projectId !== expected.projectId ||
        current.checkoutId !== expected.checkoutId ||
        current.rootRealPath !== expected.rootRealPath)
    ) {
      throw new Error('renderer workspace authority changed');
    }
    return current;
  },
  requireRendererWorkspaceScope: (owner: { id: number }) => {
    const current = harness.scopes.get(owner.id);
    if (!current) throw new Error('renderer has no authorized workspace scope');
    return current;
  },
  onRendererWorkspaceScopeChange: (
    listener: (
      owner: { id: number },
      previous: ProjectExecutionScope | null,
      next: ProjectExecutionScope | null,
    ) => void,
  ) => {
    harness.scopeChangeListeners.add(listener);
    return () => harness.scopeChangeListeners.delete(listener);
  },
}));

vi.mock('../persistence/db', () => ({ getDb: vi.fn() }));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: vi.fn(() => ({ intentFirstMissionRuntimeV1: false })),
}));
vi.mock('./squad-store', () => ({
  MAX_SQUADS_IMPORT_BYTES: 1024 * 1024,
  applyPreparedSquadSave: harness.applyPreparedSquadSave,
  applyPreparedSquadsImport: harness.applyPreparedSquadsImport,
  deleteSquad: harness.deleteSquad,
  exportSquadsJson: harness.exportSquadsJson,
  getSquad: vi.fn(
    (squadId: string) =>
      harness.squads.find((squad) => squad.id === squadId) ?? null,
  ),
  importSquadsJson: vi.fn(),
  initSquadStore: vi.fn(),
  listSquads: vi.fn(() => [...harness.squads]),
  onSquadsChange: vi.fn(),
  prepareSquadSave: harness.prepareSquadSave,
  prepareMissionRuntimeSquadSave:
    harness.prepareMissionRuntimeSquadSave,
  prepareSquadsImport: harness.prepareSquadsImport,
  saveSquad: harness.saveSquad,
}));
vi.mock('./squad-architect', () => ({
  designSquadForWorkspace: harness.designSquadForWorkspace,
  designSquadFromIntent: harness.designSquadFromIntent,
}));
vi.mock('./harness-enrich', () => ({
  loadEnrichedCatalog: harness.loadEnrichedCatalog,
  runHarnessEnrichWithBrain: harness.runHarnessEnrichWithBrain,
}));
vi.mock('./pane-registry', () => ({
  getPaneRuntimeAuthorityBySession: vi.fn(),
  initPaneRegistry: vi.fn(),
  listPaneSnapshots: vi.fn(() => [...harness.paneSnapshots]),
  registerOrchRenderer: vi.fn(),
  requestMissionPaneClose: vi.fn(async () => true),
  requestPaneClose: vi.fn(),
  resolveBrowserOpen: vi.fn(),
  resolveMissionPaneRecovery: vi.fn(),
  resolvePaneSpawn: vi.fn(),
  syncPanes: vi.fn(),
  unregisterOrchRenderer: vi.fn(),
}));
vi.mock('../adapters/omp-rpc-ipc', () => ({
  getOmpRpcSessionAuthority: vi.fn(() => null),
  isOmpRpcSession: vi.fn(() => false),
  listOmpRpcSessions: vi.fn(() => [...harness.ompSessions]),
  terminateOmpRpcSession: vi.fn(async () => true),
}));
vi.mock('../pty/pty-manager', () => ({
  getSessionState: (sessionId: string) =>
    harness.agentSessions.some((entry) => entry.sessionId === sessionId)
      ? 'idle'
      : null,
  listAgentSessions: vi.fn(() => [...harness.agentSessions]),
  orchTerminateSession: harness.terminatePty,
  getOwnedAgentSessionInfo: (owner: { id: number }, sessionId: string) =>
    harness.operatorInput.ownedSessions.get(`${owner.id}:${sessionId}`) ?? null,
  orchWriteSession: vi.fn((sessionId: string, data: string) => {
    harness.operatorInput.writes.push({ sessionId, data });
    return true;
  }),
}));
vi.mock('./renderer-mission-authority', () => ({
  RendererMissionAuthority: class {
    missionApprovalCandidateFromRenderer(owner: unknown, input: unknown) {
      return harness.missionApprovalCandidate(owner, input);
    }
    approveIntentFromRenderer(
      owner: unknown,
      input: unknown,
      fence: string,
      approvalReviewSha256: string,
    ) {
      return harness.approveMission(
        owner,
        input,
        fence,
        approvalReviewSha256,
      );
    }
    planPromotionCandidateFromRenderer(owner: unknown, input: unknown) {
      return harness.planPromotionCandidate(owner, input);
    }
    planPromotionCandidateAfterTeardownFromMain(
      owner: unknown,
      input: unknown,
      expectedPlan: unknown,
    ) {
      return harness.planPromotionCandidate(owner, input, expectedPlan);
    }
    promotePlanLaneFromRenderer(
      owner: unknown,
      input: unknown,
      fence: string,
      expectedPlan: unknown,
      approvalReviewSha256: string,
    ) {
      return harness.promotePlan(
        owner,
        input,
        fence,
        expectedPlan,
        approvalReviewSha256,
      );
    }
    missionLifecycleCandidateFromRenderer(
      owner: unknown,
      missionId: string,
      patch: unknown,
    ) {
      return harness.missionLifecycleCandidate(owner, missionId, patch);
    }
    updateMissionFromRenderer(
      owner: unknown,
      missionId: string,
      patch: unknown,
      fence?: string,
    ) {
      return harness.updateMission(owner, missionId, patch, fence);
    }
    missionRemovalCandidateFromRenderer(owner: unknown, missionId: string) {
      return harness.missionRemovalCandidate(owner, missionId);
    }
    removeMissionFromRenderer(owner: unknown, missionId: string) {
      return harness.removeMission(owner, missionId);
    }
  },
}));
vi.mock('./mission-orchestrator-bootstrap', () => ({
  bootstrapMissionOrchestratorForScope: vi.fn(),
  bootstrapMissionOrchestratorFromRenderer: harness.bootstrapMissionOrchestrator,
  stopMissionOrchestratorBeforePlanPromotionForScope:
    harness.stopPlanPromotion,
  restartMissionOrchestratorAfterPlanPromotionForScope:
    harness.restartPlanPromotion,
}));
vi.mock("./promoted-plan-git-authority", () => ({
  commitPromotedPlanToGit: vi.fn(() => ({
    headSha: "a".repeat(40),
    paths: ["plan.md"],
    summarySha256: "b".repeat(64),
    committed: true,
  })),
}));
vi.mock('./project-domain-store-registry', () => ({
  ProjectDomainStoreRegistry: class {},
  configureProjectDomainStoreRegistry: vi.fn(() => harness.projectStores),
  disposeProjectDomainStoreRegistry: vi.fn(),
  getProjectDomainStores: vi.fn(() => ({
    missions: {
      get: (missionId: string) => harness.operatorInput.missions.get(missionId),
    },
    missionPanes: {
      list: (missionId: string) =>
        harness.operatorInput.missionPanes.filter(
          (pane) => pane.missionId === missionId,
        ),
    },
  })),
}));
vi.mock('./project-scoped-broadcast', () => ({
  broadcastToProject: vi.fn(),
  sameProjectScope: (
    left: ProjectExecutionScope,
    right: ProjectExecutionScope,
  ) =>
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath,
}));
vi.mock('./idle-delivery', () => ({
  initIdleDelivery: vi.fn(),
  shutdownIdleDelivery: vi.fn(),
}));
vi.mock('./clarify-flow', () => ({
  prepareClarifyAnswerAuthorityCandidate: harness.prepareClarifyAnswer,
  persistClarifyAnswer: harness.persistClarifyAnswer,
}));
vi.mock('./operator-review-feedback', () => ({
  prepareOperatorReviewAuthorityCandidate: harness.prepareOperatorReview,
  persistOperatorReviewFeedback: harness.persistOperatorReview,
}));
vi.mock('./stall-watchdog', () => ({
  initStallWatchdog: vi.fn(),
  shutdownStallWatchdog: vi.fn(),
}));
vi.mock('./orchestration-coordinator', () => ({
  requestMissionRuntimeAuthorityReconciliation: vi.fn(),
  startOrchestrationCoordinator: vi.fn(),
  stopOrchestrationCoordinator: vi.fn(),
}));
vi.mock('./preview-server', () => ({ stopAllPreviews: vi.fn() }));
vi.mock('../remote/remote-bridge', () => ({ stopRemoteBridge: vi.fn() }));
vi.mock('./recipe-overlay', () => ({
  buildRecipeOverlay: harness.buildRecipeOverlay,
}));
vi.mock('./catalog-overlay', () => ({
  assertValidCatalogOverlayPatch: vi.fn(),
  proposeRecipes: harness.proposeRecipes,
  saveCatalogOverlay: harness.saveCatalogOverlay,
}));
vi.mock('./agent-spec-writer', () => ({
  prepareAgentSpecWrite: harness.prepareAgentSpec,
  writeAgentSpec: harness.writeAgentSpec,
}));
vi.mock('./mcp-server', () => ({
  getMcpRuntimeInfo: vi.fn(),
  getToolCatalog: vi.fn(),
  startMcpServer: vi.fn(),
  stopMcpServer: vi.fn(),
}));
vi.mock('./catalog', () => ({
  getCatalogIndex: vi.fn(),
  installCatalogItem: harness.installCatalogItem,
  listHookHomes: vi.fn(),
  listInstalledCatalogItems: vi.fn(),
  listPluginFiles: vi.fn(),
  reviewCatalogInstall: harness.reviewCatalogInstall,
}));

import {
  closeOrchestration,
  configureRendererMissionAuthority,
  initOrchestration,
  ASYNC_ENRICHMENT_TIMEOUT_MS,
  missionApproveIntentSchema,
  missionSubmitIntentSchema,
  registerOrchIpc,
} from './orch-ipc';
import { consumeImmediateSquadSpawnGrant } from './spawn-authority';
import {
  startOrchestrationCoordinator,
  stopOrchestrationCoordinator,
} from './orchestration-coordinator';
import { startMcpServer, stopMcpServer } from './mcp-server';
import { disposeProjectDomainStoreRegistry } from './project-domain-store-registry';

const SCOPE_A = Object.freeze({
  version: 1 as const,
  installationId: 'installation-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest' as const,
});
const SCOPE_B = Object.freeze({
  ...SCOPE_A,
  projectId: 'project-b',
  checkoutId: 'checkout-b',
  rootRealPath: '/workspace/b',
});
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-squad-ipc-'));
  tempDirs.push(dir);
  return dir;
}

function owner(id = 1): TestOwner {
  let destroyed = false;
  let crashed = false;
  return {
    id,
    isDestroyed: () => destroyed,
    isCrashed: () => crashed,
    destroy: () => {
      destroyed = true;
    },
    crash: () => {
      crashed = true;
    },
  };
}

function changeScope(
  sender: TestOwner,
  next: ProjectExecutionScope | null,
): void {
  const previous = harness.scopes.get(sender.id) ?? null;
  if (next) harness.scopes.set(sender.id, next);
  else harness.scopes.delete(sender.id);
  for (const listener of [...harness.scopeChangeListeners]) {
    listener(sender, previous, next);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function write(sender: ReturnType<typeof owner>, raw: unknown) {
  const handler = harness.handlers.get(ORCH_CHANNELS.agentSpecWrite);
  if (!handler) throw new Error('missing agent spec writer handler');
  return handler({ sender }, raw);
}

const AGENT_SPEC = Object.freeze({
  name: 'release-reviewer',
  tools: ['Read', 'Grep'],
  model: 'sonnet',
  systemPrompt: 'private operating instructions',
});

const SAVED_SQUAD = Object.freeze({
  id: 'squad-secure',
  name: 'Squad seguro',
  createdAt: '1',
  builtin: false,
  orchestratorInstructions: '## Política\nCoordene somente pelo contrato.',
  agents: [
    {
      id: 'orch',
      agentName: 'Maestro',
      category: 'orchestrator',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      allowedTools: ['nexus_task'],
      allowedSkills: ['check-work'],
    },
  ],
});

function designedSquad(id: string): Squad {
  return {
    ...SAVED_SQUAD,
    id,
    name: `Design ${id}`,
    builtin: false,
    agents: SAVED_SQUAD.agents.map((agent) => ({ ...agent })) as Squad["agents"],
  };
}

beforeEach(() => {
  harness.handlers.clear();
  harness.scopes.clear();
  harness.windows.clear();
  harness.squads.splice(0);
  harness.paneSnapshots.splice(0);
  harness.ompSessions.splice(0);
  harness.agentSessions.splice(0);
  harness.scopeChangeListeners.clear();
  harness.operatorInput.ownedSessions.clear();
  harness.operatorInput.missions.clear();
  harness.operatorInput.missionPanes.splice(0);
  harness.operatorInput.writes.length = 0;
  vi.clearAllMocks();
  harness.dialog.showMessageBox.mockReset();
  harness.dialog.showOpenDialog.mockReset();
  harness.dialog.showSaveDialog.mockReset();
  harness.projectStores.listSuites.mockReturnValue([]);
  harness.exportSquadsJson.mockImplementation(() =>
    JSON.stringify({ squads: harness.squads }, null, 2),
  );
  harness.designSquadForWorkspace.mockResolvedValue({
    ok: true,
    squad: designedSquad('designed-workspace'),
  });
  harness.designSquadFromIntent.mockResolvedValue({
    ok: true,
    squad: designedSquad('designed-intent'),
  });
  harness.loadEnrichedCatalog.mockReturnValue(null);
  harness.runHarnessEnrichWithBrain.mockResolvedValue({
    version: 1,
    updatedAt: 1,
    items: [],
  });
  harness.designMdSearch.mockResolvedValue([]);
  harness.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  harness.dialog.showOpenDialog.mockResolvedValue({
    canceled: true,
    filePaths: [],
  });
  harness.dialog.showSaveDialog.mockResolvedValue({
    canceled: true,
    filePath: undefined,
  });
  harness.reviewCatalogInstall.mockReturnValue({
    ok: true,
    candidate: {
      kind: 'agent',
      slug: 'reviewer',
      name: 'reviewer.md',
      repository: 'davila7/claude-code-templates',
      commitSha: 'a'.repeat(40),
      targetPath: '/home/user/.claude/agents/reviewer.md',
      alreadyInstalled: false,
    },
  });
  harness.installCatalogItem.mockImplementation(
    async (
      input: { kind: 'agent' | 'skill'; slug: string },
      options: {
        beforePublish?: (candidate: unknown) => Promise<boolean> | boolean;
        assertCurrentAuthority?: () => void;
      },
    ) => {
      const candidate = {
        kind: input.kind,
        slug: input.slug,
        name: input.kind === 'agent' ? 'reviewer.md' : 'reviewer',
        repository: 'davila7/claude-code-templates',
        commitSha: 'a'.repeat(40),
        targetPath: '/home/user/.claude/agents/reviewer.md',
        alreadyInstalled: false,
        sha256: 'b'.repeat(64),
        fileCount: 3,
        totalBytes: 1234,
        warnings: ['SKILL.md: network fetch piped into a shell interpreter'],
      };
      try {
        options.assertCurrentAuthority?.();
        const approved = await options.beforePublish?.(candidate);
        options.assertCurrentAuthority?.();
        return approved === false
          ? { ok: false, error: 'user_denied' }
          : { ok: true, installed: { name: candidate.name, path: candidate.targetPath } };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  harness.writeAgentSpec.mockReturnValue({
    ok: true,
    path: '/home/user/.claude/agents/release-reviewer.md',
  });
  harness.prepareAgentSpec.mockImplementation((patch: typeof AGENT_SPEC) => ({
    patch,
    currentFingerprint: 'spec-fingerprint-a',
    nextContents:
      '---\ntools: Read, Grep\nmodel: sonnet\n---\n\n' +
      `${patch.systemPrompt}\n`,
    path: `/home/user/.claude/agents/${patch.name}.md`,
  }));
  harness.missionRemovalCandidate.mockReturnValue({
    missionId: 'mission-draft',
    title: 'Rascunho seguro',
  });
  harness.removeMission.mockReturnValue(true);
  harness.missionApprovalCandidate.mockReturnValue({
    missionId: 'mission-1',
    title: 'Corrigir o golden path',
    goal: 'Implementar, testar e entregar a missão real',
    lane: 'standard',
    risk: 'sensitive',
    executionMode: 'autopilot',
    contextPolicy: 'on-demand',
    acceptanceCriteria: ['Teste real passa', 'Handoff aceito'],
    deniedTools: ['nexus_git_force_push'],
    evidenceAttached: true,
    attachmentPaths: ['/Users/me/.nexus/dropped/proof.png'],
    attachmentSnapshots: [
      {
        path: '/Users/me/.nexus/dropped/proof.png',
        sha256: 'e'.repeat(64),
        size: 321,
      },
    ],
    squad: {
      id: 'saved-squad',
      name: 'Squad auditado',
      orchestratorInstructions: 'Coordene somente pelo contrato exibido.',
      agents: [
        {
          id: 'orch',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
          allowedTools: ['nexus_task'],
          allowedSkills: ['check-work'],
        },
      ],
      hash: 'a'.repeat(64),
    },
    orchestratorRuntime: {
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      accountId: 'account-a',
      effort: 'high',
      readOnly: false,
      nativeReadOnly: true,
    },
    orchestratorEvidence: 'verified',
    intentVersion: 3,
    budgets: {
      planningTokens: 4_000,
      executionTokens: 12_000,
      maxWorkers: 3,
      maxSteps: 12,
    },
    fence: 'approval-fence-3',
  });
  harness.approveMission.mockReturnValue({ id: 'mission-1', status: 'running' });
  harness.planPromotionCandidate.mockReturnValue({
    missionId: 'mission-plan',
    title: 'Plano revisado',
    goal: 'Aplicar o plano aprovado no workspace',
    lane: 'plan',
    risk: 'normal',
    executionMode: 'assisted',
    contextPolicy: 'minimal',
    acceptanceCriteria: ['Plano validado'],
    deniedTools: [],
    evidenceAttached: false,
    attachmentPaths: [],
    attachmentSnapshots: [],
    squad: {
      id: 'saved-squad',
      name: 'Squad auditado',
      orchestratorInstructions: 'Planeje antes de executar.',
      agents: [],
      hash: 'b'.repeat(64),
    },
    orchestratorRuntime: {
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      accountId: 'account-a',
      effort: 'high',
      readOnly: false,
      nativeReadOnly: true,
    },
    orchestratorEvidence: 'verified',
    promotedPlan: {
      version: 1,
      handoffId: 'handoff-plan-v5',
      sourceIntentVersion: 5,
      sourceSessionId: 'session-plan-v5',
      handoffCreatedAt: 500,
      physicalReceipt: {
        receiptId: 'receipt-plan-v5',
        toolCallId: 'tool-plan-v5',
        source: 'http-mcp',
        authoritySha256: 'c'.repeat(64),
        issuedAt: 500,
      },
      summary: '# PRD\nPlano exato revisado.',
      artifacts: [{ path: 'plan.md' }],
      summarySha256: 'd'.repeat(64),
      artifactsSha256: 'e'.repeat(64),
      digest: 'f'.repeat(64),
    },
    intentVersion: 5,
    budgets: {
      planningTokens: 4_000,
      executionTokens: 12_000,
      maxWorkers: 2,
    },
    fence: 'promotion-fence-5',
  });
  harness.promotePlan.mockReturnValue({
    id: 'mission-plan',
    status: 'running',
    intentVersion: 6,
  });
  harness.operatorInput.missions.set('mission-plan', {
    status: 'pending',
    orchestratorSessionId: undefined,
  });
  harness.stopPlanPromotion.mockResolvedValue({
    ok: true,
    missionId: 'mission-plan',
  });
  harness.restartPlanPromotion.mockImplementation(async () => {
    harness.operatorInput.missions.delete('mission-plan');
    return {
      ok: true,
      missionId: 'mission-plan',
      pane: {
        paneId: 'pane-plan-v2',
        sessionId: 'session-plan-v2',
        adapterId: 'codex',
        cwd: '/workspace/a',
        title: 'Plano revisado · orq',
        agentName: 'Maestro',
        role: 'orchestrator',
      },
      kickoff: { accepted: true },
    };
  });
  harness.missionLifecycleCandidate.mockReturnValue({
    missionId: 'mission-1',
    title: 'Missão em execução',
    fromStatus: 'running',
    toStatus: 'blocked',
    description: 'Ambiente externo indisponível; retomar após restaurar credenciais.',
    fence: 'lifecycle-fence-7',
  });
  harness.updateMission.mockReturnValue({ id: 'mission-1', status: 'blocked' });
  harness.listMissions.mockReturnValue([]);
  harness.prepareClarifyAnswer.mockReturnValue({
    missionId: 'mission-1',
    missionTitle: 'Missão exata',
    intentVersion: 3,
    orchestratorSessionId: 'orch-session-3',
    questionId: 'question-1',
    question: 'Qual banco deve ser usado?',
    chips: [
      { id: 'opt-1', label: 'Postgres' },
      { id: 'opt-2', label: 'SQLite' },
    ],
    allowFreeform: false,
    answer: { kind: 'chip', chipId: 'opt-2', value: 'SQLite' },
    fence: 'c'.repeat(64),
  });
  harness.persistClarifyAnswer.mockReturnValue({ ok: true, handoffId: 'answer-1' });
  harness.prepareOperatorReview.mockReturnValue({
    missionId: 'mission-1',
    missionTitle: 'Missão exata',
    intentVersion: 3,
    orchestratorSessionId: 'orch-session-3',
    annotations: [
      { path: 'src/checkout.ts', line: 42, body: 'Trate o valor nulo integralmente.' },
    ],
    fence: 'd'.repeat(64),
  });
  harness.persistOperatorReview.mockReturnValue({ ok: true, handoffId: 'review-1' });
  harness.projectStores.forScope.mockReturnValue({
    scope: SCOPE_A,
    missions: {
      get: vi.fn((missionId: string) =>
        missionId === 'mission-1'
          ? {
              id: 'mission-1',
              title: 'Missão em execução',
              description:
                'Ambiente externo indisponível; retomar após restaurar credenciais.',
              status: 'running',
              milestones: [],
              learnings: '',
              createdAt: 1,
              updatedAt: 2,
            }
          : undefined,
      ),
      list: harness.listMissions,
    },
    missionPanes: { list: vi.fn(() => []) },
  });
  registerOrchIpc();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('bounded enrichment authority', () => {
  it.each([
    ORCH_CHANNELS.squadsList,
    ORCH_CHANNELS.mcpInfo,
    ORCH_CHANNELS.catalogInstalled,
    ORCH_CHANNELS.toolsList,
    ORCH_CHANNELS.pluginsList,
    ORCH_CHANNELS.hooksList,
  ])('requires a live workspace scope for global inventory read %s', (channel) => {
    const handler = harness.handlers.get(channel);
    if (!handler) throw new Error(`missing handler ${channel}`);
    expect(() => handler({ sender: owner(799) })).toThrow(
      /authorized workspace scope/i,
    );
  });

  it('aborts a provider that outlives the bounded enrichment deadline', async () => {
    vi.useFakeTimers();
    try {
      const sender = owner(800);
      harness.scopes.set(sender.id, SCOPE_A);
      const pending = deferred<unknown>();
      let operationSignal: AbortSignal | undefined;
      harness.designSquadFromIntent.mockImplementationOnce(
        async (
          _intent: string,
          _workspacePath: string,
          options?: { signal?: AbortSignal },
        ) => {
          operationSignal = options?.signal;
          return pending.promise;
        },
      );
      const handler = harness.handlers.get(ORCH_CHANNELS.squadDesign);
      if (!handler) throw new Error('missing squad design handler');

      const flight = handler({ sender }, { intent: 'deadline-800' });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.designSquadFromIntent).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(ASYNC_ENRICHMENT_TIMEOUT_MS + 1);
      const wasAborted = operationSignal?.aborted;
      pending.resolve({ ok: true, squad: { id: 'too-late' } });
      const result = await flight;

      expect(wasAborted).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringMatching(/deadline/i),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the deadline while abort-ignoring providers keep their bounded slots', async () => {
    vi.useFakeTimers();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let flightA: Promise<unknown> | undefined;
    let flightB: Promise<unknown> | undefined;
    try {
      const sender = owner(807);
      harness.scopes.set(sender.id, SCOPE_A);
      harness.designSquadFromIntent
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise)
        .mockResolvedValueOnce({
          ok: true,
          squad: designedSquad('after-settlement'),
        });
      const handler = harness.handlers.get(ORCH_CHANNELS.squadDesign);
      if (!handler) throw new Error('missing squad design handler');

      flightA = handler({ sender }, { intent: 'ignore-abort-a-807' }) as Promise<unknown>;
      flightB = handler({ sender }, { intent: 'ignore-abort-b-807' }) as Promise<unknown>;
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.designSquadFromIntent).toHaveBeenCalledTimes(2);

      let settled = 0;
      void flightA.then(() => {
        settled += 1;
      });
      void flightB.then(() => {
        settled += 1;
      });
      await vi.advanceTimersByTimeAsync(ASYNC_ENRICHMENT_TIMEOUT_MS + 1);
      await Promise.resolve();
      expect(settled).toBe(2);
      await expect(
        handler({ sender }, { intent: 'still-bounded-c-807' }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/limite global|operaç/i),
      });
      expect(harness.designSquadFromIntent).toHaveBeenCalledTimes(2);

      first.resolve({ ok: true, squad: { id: 'late-a' } });
      second.resolve({ ok: true, squad: { id: 'late-b' } });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await expect(
        handler({ sender }, { intent: 'after-settlement-d-807' }),
      ).resolves.toMatchObject({
        ok: true,
        squad: { id: 'after-settlement' },
        designDraftToken: expect.any(String),
      });
    } finally {
      first.resolve({ ok: true, squad: { id: 'cleanup-a' } });
      second.resolve({ ok: true, squad: { id: 'cleanup-b' } });
      await Promise.allSettled(
        [flightA, flightB].filter(
          (flight): flight is Promise<unknown> => flight !== undefined,
        ),
      );
      vi.useRealTimers();
    }
  });

  it('caps distinct squad design flights globally while same-key work remains single-flight', async () => {
    const sender = owner(801);
    harness.scopes.set(sender.id, SCOPE_A);
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    harness.designSquadFromIntent
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const handler = harness.handlers.get(ORCH_CHANNELS.squadDesign);
    if (!handler) throw new Error('missing squad design handler');

    const flightA = handler({ sender }, { intent: 'bounded-a-801' });
    const joinedA = handler({ sender }, { intent: 'bounded-a-801' });
    const flightB = handler({ sender }, { intent: 'bounded-b-801' });
    const rejected = handler({ sender }, { intent: 'bounded-c-801' });

    await expect(rejected).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/limite global|operaç/i),
    });
    expect(harness.designSquadFromIntent).toHaveBeenCalledTimes(2);

    first.resolve({ ok: true, squad: designedSquad('a') });
    second.resolve({ ok: true, squad: designedSquad('b') });
    const results = await Promise.all([flightA, joinedA, flightB]);
    expect(results).toEqual([
      expect.objectContaining({
        ok: true,
        squad: expect.objectContaining({ id: 'a' }),
        designDraftToken: expect.any(String),
      }),
      expect.objectContaining({
        ok: true,
        squad: expect.objectContaining({ id: 'a' }),
        designDraftToken: expect.any(String),
      }),
      expect.objectContaining({
        ok: true,
        squad: expect.objectContaining({ id: 'b' }),
        designDraftToken: expect.any(String),
      }),
    ]);
  });

  it('aborts squad design immediately on scope revocation and rejects its result', async () => {
    const sender = owner(802);
    harness.scopes.set(sender.id, SCOPE_A);
    const pending = deferred<unknown>();
    let operationSignal: AbortSignal | undefined;
    harness.designSquadFromIntent.mockImplementationOnce(
      async (
        _intent: string,
        _workspacePath: string,
        options?: { signal?: AbortSignal },
      ) => {
        operationSignal = options?.signal;
        return pending.promise;
      },
    );
    const handler = harness.handlers.get(ORCH_CHANNELS.squadDesign);
    if (!handler) throw new Error('missing squad design handler');

    const flight = handler({ sender }, { intent: 'revoked-802' });
    await vi.waitFor(() =>
      expect(harness.designSquadFromIntent).toHaveBeenCalledOnce(),
    );
    changeScope(sender, SCOPE_B);
    expect(operationSignal?.aborted).toBe(true);
    pending.resolve({ ok: true, squad: { id: 'must-not-escape' } });

    await expect(flight).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/authority changed/i),
    });
  });

  it('requires live scope, single-flights same-scope harness work and rejects cross-scope saturation', async () => {
    const senderA = owner(803);
    const senderB = owner(804);
    harness.scopes.set(senderA.id, SCOPE_A);
    harness.scopes.set(senderB.id, SCOPE_B);
    const pending = deferred<any>();
    harness.runHarnessEnrichWithBrain.mockImplementationOnce(() => pending.promise);
    const handler = harness.handlers.get(ORCH_CHANNELS.harnessEnrich);
    const read = harness.handlers.get(ORCH_CHANNELS.harnessEnriched);
    if (!handler || !read) throw new Error('missing harness handlers');

    const first = handler({ sender: senderA });
    const joined = handler({ sender: senderA });
    await expect(handler({ sender: senderB })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/limite global|operaç/i),
    });
    expect(harness.runHarnessEnrichWithBrain).toHaveBeenCalledOnce();
    expect(() => read({ sender: owner(805) })).toThrow(
      /authorized workspace scope/i,
    );

    const catalog = { version: 1 as const, updatedAt: 2, items: [] };
    pending.resolve(catalog);
    await expect(Promise.all([first, joined])).resolves.toEqual([
      { ok: true, catalog },
      { ok: true, catalog },
    ]);
  });

  it('aborts harness external work on scope revocation before a result can escape', async () => {
    const sender = owner(806);
    harness.scopes.set(sender.id, SCOPE_A);
    const pending = deferred<any>();
    let operationSignal: AbortSignal | undefined;
    harness.runHarnessEnrichWithBrain.mockImplementationOnce(
      async (options?: { signal?: AbortSignal }) => {
        operationSignal = options?.signal;
        return pending.promise;
      },
    );
    const handler = harness.handlers.get(ORCH_CHANNELS.harnessEnrich);
    if (!handler) throw new Error('missing harness enrich handler');

    const flight = handler({ sender });
    await vi.waitFor(() =>
      expect(harness.runHarnessEnrichWithBrain).toHaveBeenCalledOnce(),
    );
    changeScope(sender, SCOPE_B);
    expect(operationSignal?.aborted).toBe(true);
    pending.resolve({ version: 1, updatedAt: 3, items: [] });

    await expect(flight).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/authority changed/i),
    });
  });

  it('requires live scope and bounds design-system search fan-out', async () => {
    const handler = harness.handlers.get(ORCH_CHANNELS.designSystemsSearch);
    if (!handler) throw new Error('missing design systems search handler');
    const unauthorized = owner(807);
    await expect(
      handler({ sender: unauthorized }, { query: 'no-scope-807' }),
    ).resolves.toMatchObject({ ok: false });
    expect(harness.designMdSearch).not.toHaveBeenCalled();

    const senderA = owner(808);
    const senderB = owner(809);
    harness.scopes.set(senderA.id, SCOPE_A);
    harness.scopes.set(senderB.id, SCOPE_B);
    const pending = deferred<unknown[]>();
    harness.designMdSearch.mockImplementationOnce(() => pending.promise);

    const first = handler({ sender: senderA }, { query: 'bounded-search-808' });
    const joined = handler({ sender: senderA }, { query: 'bounded-search-808' });
    await vi.waitFor(() => expect(harness.designMdSearch).toHaveBeenCalledOnce());
    await expect(
      handler({ sender: senderB }, { query: 'distinct-search-809' }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/limite global|operaç/i),
    });
    expect(harness.designMdSearch).toHaveBeenCalledOnce();

    changeScope(senderA, SCOPE_B);
    pending.resolve([{ slug: 'must/not-escape' }]);
    await expect(Promise.all([first, joined])).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.stringMatching(/authority changed/i),
      }),
      expect.objectContaining({
        ok: false,
        error: expect.stringMatching(/authority changed/i),
      }),
    ]);
  });

  it('times out design-system search without freeing an abort-ignoring provider slot', async () => {
    vi.useFakeTimers();
    const pending = deferred<unknown[]>();
    let flight: Promise<unknown> | undefined;
    try {
      const sender = owner(810);
      harness.scopes.set(sender.id, SCOPE_A);
      harness.designMdSearch
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValueOnce([]);
      const handler = harness.handlers.get(ORCH_CHANNELS.designSystemsSearch);
      if (!handler) throw new Error('missing design systems search handler');

      flight = handler(
        { sender },
        { query: 'ignores-abort-search-810' },
      ) as Promise<unknown>;
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.designMdSearch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(ASYNC_ENRICHMENT_TIMEOUT_MS + 1);
      await expect(flight).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/deadline/i),
      });
      await expect(
        handler({ sender }, { query: 'still-bounded-search-810' }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/limite global|operaç/i),
      });
      expect(harness.designMdSearch).toHaveBeenCalledOnce();

      pending.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        handler({ sender }, { query: 'settled-search-810' }),
      ).resolves.toEqual({ ok: true, kits: [] });
    } finally {
      pending.resolve([]);
      if (flight) await Promise.allSettled([flight]);
      vi.useRealTimers();
    }
  });
});

describe('immediate squad native grant authority', () => {
  it('issues one opaque grant bound to the reviewed squad, runtime and goal', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.squads.push(SAVED_SQUAD);
    const handler = harness.handlers.get(
      ORCH_CHANNELS.missionAuthorizeImmediateSquad,
    );
    if (!handler) throw new Error('missing immediate squad handler');

    const result = (await handler(
      { sender },
      {
        squadId: SAVED_SQUAD.id,
        paneId: 'pane-immediate',
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        accountId: 'account-a',
        effort: 'high',
        missionTitle: 'Implementar o objetivo exato',
        missionGoal: 'Implementar o objetivo exato',
      },
    )) as { grant: string };

    expect(result.grant).toMatch(/^squadgrant_[A-Za-z0-9_-]{40,}$/);
    const options = harness.dialog.showMessageBox.mock.calls.at(-1)?.[1];
    expect(options?.detail).toContain('Implementar o objetivo exato');
    // Compacto: instruções integrais ficam fixadas pelo hash, fora do modal.
    expect(options?.detail).not.toContain('Coordene somente pelo contrato');
    expect(options?.detail).toContain('Hash exato');
    const consumed = consumeImmediateSquadSpawnGrant({
      requestId: result.grant,
      owner: sender as never,
      scope: SCOPE_A,
      squads: [SAVED_SQUAD as unknown as Squad],
      runtime: {
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        accountId: 'account-a',
        effort: 'high',
        paneId: 'pane-immediate',
      },
    });
    expect(consumed?.authority.immediateMissionTitle).toBe(
      'Implementar o objetivo exato',
    );
    expect(consumed?.runtime).toMatchObject({
      title: 'Maestro',
      missionTitle: 'Implementar o objetivo exato',
      missionGoal: 'Implementar o objetivo exato',
    });
  });

  it('denial produces no grant and no process-capable receipt', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.squads.push(SAVED_SQUAD);
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const handler = harness.handlers.get(
      ORCH_CHANNELS.missionAuthorizeImmediateSquad,
    )!;

    await expect(
      handler(
        { sender },
        {
          squadId: SAVED_SQUAD.id,
          paneId: 'pane-immediate',
          adapterId: 'codex',
          missionTitle: 'Denied goal',
          missionGoal: 'Denied goal',
        },
      ),
    ).rejects.toThrow(/user_denied/);
  });

  it('expõe a fronteira exata do Pet Studio no único modal de início', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.squads.push(PET_STUDIO_SQUAD);
    const handler = harness.handlers.get(
      ORCH_CHANNELS.missionAuthorizeImmediateSquad,
    )!;

    await handler(
      { sender },
      {
        squadId: PET_STUDIO_SQUAD.id,
        paneId: 'pane-pet',
        adapterId: 'codex',
        effort: 'high',
        missionTitle: 'Criar mascote',
        missionGoal: 'Criar mascote com a referência autorizada',
      },
    );

    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const detail = String(
      harness.dialog.showMessageBox.mock.calls[0]?.[1]?.detail ?? '',
    );
    expect(detail).toContain('nexus-pet-studio');
    expect(detail).toContain('nexus_media_providers,nexus_image_generate');
    expect(detail).toContain(
      'Codex pode escrever somente neste workspace, sem rede de subprocessos',
    );
    expect(detail).toContain('.agents/.codex continuam protegidos');
    expect(detail).toContain('sem sobrescrever pets existentes');
  });
});

describe('catalog and overlay renderer authority', () => {
  function setupCatalog(channel: string) {
    const sender = owner(41);
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    const handler = harness.handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return { sender, handler };
  }

  it('does not download or publish a catalog payload when native source review is denied', async () => {
    const { sender, handler } = setupCatalog(ORCH_CHANNELS.catalogInstall);
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });

    const result = await handler(
      { sender },
      { kind: 'agent', slug: 'reviewer' },
    );

    expect(result).toEqual({ ok: false, error: 'user_denied' });
    expect(harness.reviewCatalogInstall).toHaveBeenCalledOnce();
    expect(harness.installCatalogItem).not.toHaveBeenCalled();
    const detail = String(
      harness.dialog.showMessageBox.mock.calls[0]?.[1]?.detail ?? '',
    );
    expect(detail).toContain('davila7/claude-code-templates');
    expect(detail).toContain('a'.repeat(40));
    expect(detail).toContain('/home/user/.claude/agents/reviewer.md');
  });

  it('publishes only after a second dialog shows exact digest, bytes and scan warnings', async () => {
    const { sender, handler } = setupCatalog(ORCH_CHANNELS.catalogInstall);

    const result = await handler(
      { sender },
      { kind: 'agent', slug: 'reviewer' },
    );

    expect(result).toMatchObject({ ok: true });
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    const detail = String(
      harness.dialog.showMessageBox.mock.calls[1]?.[1]?.detail ?? '',
    );
    expect(detail).toContain('b'.repeat(64));
    expect(detail).toContain('Arquivos: 3');
    expect(detail).toContain('Bytes: 1234');
    expect(detail).toContain('network fetch piped');
    expect(harness.installCatalogItem).toHaveBeenCalledWith(
      { kind: 'agent', slug: 'reviewer' },
      expect.objectContaining({
        expectedCommitSha: 'a'.repeat(40),
        beforePublish: expect.any(Function),
        assertCurrentAuthority: expect.any(Function),
      }),
    );
  });

  it('bounds a large warning set while preserving exact totals and digest', async () => {
    const { sender, handler } = setupCatalog(ORCH_CHANNELS.catalogInstall);
    harness.installCatalogItem.mockImplementationOnce(
      async (_input: unknown, options: { beforePublish(candidate: unknown): Promise<boolean> }) => {
        const approved = await options.beforePublish({
          kind: 'agent',
          slug: 'reviewer',
          name: 'reviewer.md',
          repository: 'davila7/claude-code-templates',
          commitSha: 'a'.repeat(40),
          targetPath: '/home/user/.claude/agents/reviewer.md',
          alreadyInstalled: false,
          sha256: 'b'.repeat(64),
          fileCount: 200,
          totalBytes: 12_345,
          warnings: Array.from(
            { length: 200 },
            (_, index) => `asset-${index}: conteúdo binário não inspecionado`,
          ),
        });
        return approved ? { ok: true } : { ok: false, error: 'user_denied' };
      },
    );

    await handler({ sender }, { kind: 'agent', slug: 'reviewer' });
    const detail = String(
      harness.dialog.showMessageBox.mock.calls[1]?.[1]?.detail ?? '',
    );
    expect(detail.length).toBeLessThan(16_000);
    expect(detail).toContain('200 total');
    expect(detail).toContain('200 arquivo(s) binário(s)');
    expect(detail).toContain('192 alerta(s) adicional(is) oculto(s)');
    expect(detail).toContain('b'.repeat(64));
  });

  it('denies publication when renderer workspace authority changes during payload review', async () => {
    const { sender, handler } = setupCatalog(ORCH_CHANNELS.catalogInstall);
    harness.dialog.showMessageBox
      .mockResolvedValueOnce({ response: 1 })
      .mockImplementationOnce(async () => {
        harness.scopes.set(sender.id, SCOPE_B);
        return { response: 1 };
      });

    const result = await handler(
      { sender },
      { kind: 'agent', slug: 'reviewer' },
    );

    expect(result).toMatchObject({ ok: false });
    expect((result as { error?: string }).error).toMatch(/authority changed/i);
  });

  it('derives every overlay/proposal path from the main-owned renderer scope', async () => {
    const overlay = setupCatalog(ORCH_CHANNELS.recipeOverlay);
    await overlay.handler(
      { sender: overlay.sender },
      {},
    );
    expect(harness.buildRecipeOverlay).toHaveBeenCalledWith(
      SCOPE_A.rootRealPath,
    );

    const save = setupCatalog(ORCH_CHANNELS.catalogOverlaySave);
    await save.handler(
      { sender: save.sender },
      { stacks: ['electron'] },
    );
    expect(harness.saveCatalogOverlay).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: SCOPE_A.rootRealPath,
        stacks: ['electron'],
      }),
    );

    const propose = setupCatalog(ORCH_CHANNELS.recipePropose);
    await propose.handler(
      { sender: propose.sender },
      {},
    );
    expect(harness.proposeRecipes).toHaveBeenCalledWith(SCOPE_A.rootRealPath);
  });

  it('rejects renderer-supplied workspace paths instead of preserving false authority', async () => {
    const overlay = setupCatalog(ORCH_CHANNELS.recipeOverlay);
    expect(() =>
      overlay.handler(
        { sender: overlay.sender },
        { workspacePath: SCOPE_B.rootRealPath },
      ),
    ).toThrow(/invalid recipe overlay request/i);
    expect(harness.buildRecipeOverlay).not.toHaveBeenCalled();

    const save = setupCatalog(ORCH_CHANNELS.catalogOverlaySave);
    expect(() =>
      save.handler(
        { sender: save.sender },
        { workspacePath: SCOPE_B.rootRealPath, stacks: ['electron'] },
      ),
    ).toThrow(/invalid catalog overlay/i);
    expect(harness.saveCatalogOverlay).not.toHaveBeenCalled();
  });

  it('rejects an oversized categories map before persistent overlay write', async () => {
    const { sender, handler } = setupCatalog(ORCH_CHANNELS.catalogOverlaySave);
    const categories = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [`key-${index}`, 'value']),
    );

    expect(() =>
      handler({ sender }, { categories }),
    ).toThrow(/invalid catalog overlay/i);
    expect(harness.saveCatalogOverlay).not.toHaveBeenCalled();
  });
});

describe('agent spec renderer authority', () => {
  it('rejects missing, destroyed, and crashed renderer authority', async () => {
    const missing = owner();
    await expect(write(missing, AGENT_SPEC)).rejects.toThrow(
      /no authorized workspace scope/i,
    );

    harness.scopes.set(missing.id, SCOPE_A);
    missing.destroy();
    await expect(write(missing, AGENT_SPEC)).rejects.toThrow(
      /renderer is unavailable/i,
    );
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(harness.writeAgentSpec).not.toHaveBeenCalled();
  });

  it('requires a main-owned confirmation for every write invocation', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });

    await write(sender, AGENT_SPEC);
    await write(sender, AGENT_SPEC);

    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(harness.writeAgentSpec).toHaveBeenCalledTimes(2);
    const confirmation = harness.dialog.showMessageBox.mock.calls[0]![1];
    expect(confirmation).toMatchObject({ defaultId: 0, cancelId: 0, noLink: true });
    expect(confirmation.detail).toContain(SCOPE_A.rootRealPath);
    expect(confirmation.detail).toContain(AGENT_SPEC.name);
    expect(confirmation.detail).toContain(AGENT_SPEC.systemPrompt);
    expect(confirmation.detail).toContain('tools: Read, Grep');
    expect(harness.writeAgentSpec).toHaveBeenLastCalledWith(
      AGENT_SPEC,
      'spec-fingerprint-a',
    );
  });

  it('does not write when the user denies the exact invocation', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await expect(write(sender, AGENT_SPEC)).resolves.toEqual({
      ok: false,
      error: 'user_denied',
    });
    expect(harness.writeAgentSpec).not.toHaveBeenCalled();
  });

  it('invalidates approval if the renderer changes project during confirmation', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.dialog.showMessageBox.mockImplementationOnce(async () => {
      harness.scopes.set(sender.id, SCOPE_B);
      return { response: 1 };
    });

    await expect(
      write(sender, { ...AGENT_SPEC, scope: SCOPE_B }),
    ).rejects.toThrow(/workspace authority changed/i);
    expect(harness.writeAgentSpec).not.toHaveBeenCalled();
  });

  it('invalidates approval if the renderer dies during confirmation', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.dialog.showMessageBox.mockImplementationOnce(async () => {
      sender.crash();
      return { response: 1 };
    });

    await expect(write(sender, AGENT_SPEC)).rejects.toThrow(
      /renderer is unavailable/i,
    );
    expect(harness.writeAgentSpec).not.toHaveBeenCalled();
  });
});

describe('mission intent IPC evidence contract', () => {
  it('preserves evidenceAttached through submit and approve validation', () => {
    expect(missionSubmitIntentSchema.parse({
      missionId: 'mission-1',
      goal: 'Analisar os anexos da missão',
      evidenceAttached: true,
    })).toMatchObject({ evidenceAttached: true });
    expect(missionApproveIntentSchema.parse({
      missionId: 'mission-1',
      evidenceAttached: true,
      attachmentPaths: ['/Users/me/.nexus/dropped/proof.png'],
    })).toMatchObject({
      evidenceAttached: true,
      attachmentPaths: ['/Users/me/.nexus/dropped/proof.png'],
    });
    expect(() =>
      missionApproveIntentSchema.parse({
        missionId: 'mission-1',
        evidenceAttached: true,
        providerId: 'forged',
      }),
    ).toThrow();
    expect(() =>
      missionApproveIntentSchema.parse({
        missionId: 'mission-1',
        attachmentPaths: Array.from(
          { length: 7 },
          (_, index) => `/Users/me/.nexus/dropped/${index}`,
        ),
      }),
    ).toThrow();
  });

  it('accepts only missionId for main-owned orchestrator bootstrap', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.bootstrapMissionOrchestrator.mockResolvedValueOnce({
      ok: true,
      missionId: 'mission-1',
    });
    const handler = harness.handlers.get(
      ORCH_CHANNELS.missionBootstrapOrchestrator,
    );
    expect(handler).toBeTypeOf('function');

    await expect(
      handler?.({ sender }, { missionId: 'mission-1' }),
    ).resolves.toMatchObject({ ok: true, missionId: 'mission-1' });
    expect(harness.bootstrapMissionOrchestrator).toHaveBeenCalledWith(
      sender,
      { missionId: 'mission-1' },
    );

    await expect(async () =>
      handler?.(
        { sender },
        {
          missionId: 'mission-1',
          adapterId: 'forged-provider',
          model: 'forged-model',
          cwd: '/tmp/forged',
        },
      )
    ).rejects.toThrow(/invalid mission orchestrator bootstrap payload/i);
    expect(harness.bootstrapMissionOrchestrator).toHaveBeenCalledTimes(1);
  });
});

describe('mission authority native confirmation', () => {
  function missionHandler(channel: string) {
    configureRendererMissionAuthority({} as never);
    const handler = harness.handlers.get(channel);
    if (!handler) throw new Error(`missing ${channel} handler`);
    return handler;
  }

  it('nega aprovação sem clique nativo e não inicia bootstrap', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const handler = missionHandler(ORCH_CHANNELS.missionApproveIntent);

    await expect(
      handler({ sender }, { missionId: 'mission-1', evidenceAttached: true }),
    ).rejects.toThrow(/user_denied/i);
    expect(harness.missionApprovalCandidate).toHaveBeenCalledOnce();
    expect(harness.approveMission).not.toHaveBeenCalled();
    expect(harness.bootstrapMissionOrchestrator).not.toHaveBeenCalled();
  });

  it('amarra aprovação ao scope e fence em um resumo nativo que cabe em tela pequena', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    const handler = missionHandler(ORCH_CHANNELS.missionApproveIntent);

    await expect(
      handler({ sender }, { missionId: 'mission-1' }),
    ).resolves.toMatchObject({ id: 'mission-1', status: 'running' });
    const options = harness.dialog.showMessageBox.mock.calls.at(-1)?.[1];
    if (!options) throw new Error('missing native confirmation options');
    const detail = String(options.detail ?? '');
    const reviewSha256 = detail.match(
      /Review integral: SHA-256=([a-f0-9]{64})/,
    )?.[1];
    expect(reviewSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.approveMission).toHaveBeenCalledWith(
      sender,
      { missionId: 'mission-1' },
      'approval-fence-3',
      reviewSha256,
    );
    expect(options).toMatchObject({ defaultId: 0, cancelId: 0, noLink: true });
    expect(detail).toContain(SCOPE_A.rootRealPath);
    expect(detail).toContain('Corrigir o golden path');
    expect(detail).toContain('sensitive');
    expect(detail).toContain('lane=standard');
    expect(detail).toContain('modo=autopilot');
    expect(detail).toContain('orçamento P4000/E12000/W3/S12');
    expect(detail).toContain('Critérios/permissões: critérios=2');
    expect(detail).toContain('negadas=1, tools=1');
    expect(detail).toContain('skills=1');
    expect(detail).toContain('Evidências/plano: evidência=sim · anexos=1');
    expect(detail).toContain('Maestro/workers');
    expect(detail).toContain('workers=0');
    expect(detail).toContain('squad=Squad auditado (saved-squad) SHA-256');
    expect(detail).toContain('a'.repeat(64));
    expect(detail).toContain('gpt-5.6-sol');
    expect(detail).toContain('verificada');
    expect(detail).toContain('Rede: desativada');
    expect(detail).toContain('Review integral: SHA-256=');
    expect(detail.split('\n')).toHaveLength(9);
    expect(detail.length).toBeLessThanOrEqual(1_800);
  });

  it('mantém shell Codex offline e limita dependências ao runtime empacotado', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    const base = harness.missionApprovalCandidate();
    harness.missionApprovalCandidate.mockReturnValueOnce({
      ...base,
      squad: {
        ...base.squad,
        agents: [
          ...base.squad.agents,
          {
            id: 'executor',
            agentName: 'Executor Codex',
            category: 'executor',
            cli: 'codex',
            model: 'gpt-5.6-sol',
            effort: 'high',
            allowedTools: [],
            allowedSkills: ['ponytail'],
          },
        ],
      },
    });
    const handler = missionHandler(ORCH_CHANNELS.missionApproveIntent);

    await handler({ sender }, { missionId: 'mission-1' });

    const detail = String(
      harness.dialog.showMessageBox.mock.calls.at(-1)?.[1]?.detail ?? '',
    );
    expect(detail).toContain('Rede de shell: desativada');
    expect(detail).toContain(
      'provider/MCP somente no binário Codex fixado',
    );
    expect(detail).toContain(
      'runtime empacotado via load_workspace_dependencies',
    );
    expect(detail).toContain('instalação remota de pacotes indisponível');
    expect(detail).not.toContain('limited/MITM');
    expect(detail).not.toContain('registry.npmjs.org');
    expect(detail).toContain(
      createHash('sha256')
        .update(JSON.stringify({
          enabled: false,
          reason: 'codex-shell-network-denied-use-main-owned-mcp',
          providerNetwork: 'pinned-vendor-process-only',
          workspaceWriteWorkersNetwork: false,
          readOnlyWorkersNetwork: false,
          remotePackageInstall: false,
          dependencyCapability: 'bundled-runtime-paths-only',
          dependencyTool: 'load_workspace_dependencies',
          mainOwnedTerminalAndBackground: false,
        }))
        .digest('hex'),
    );
    expect(detail.split('\n')).toHaveLength(9);
  });

  it('expõe a evidência experimental no único diálogo nativo final', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    const candidate = harness.missionApprovalCandidate();
    harness.missionApprovalCandidate.mockReturnValueOnce({
      ...candidate,
      orchestratorEvidence: 'experimental',
    });
    const handler = missionHandler(ORCH_CHANNELS.missionApproveIntent);

    await handler({ sender }, { missionId: 'mission-1' });

    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const options = harness.dialog.showMessageBox.mock.calls.at(-1)?.[1];
    expect(String(options?.detail ?? '')).toContain(
      'experimental (gate incompleto)',
    );
    expect(options).toMatchObject({
      type: 'warning',
      buttons: ['Negar', 'Aprovar experimental e iniciar'],
      defaultId: 0,
      cancelId: 0,
    });
  });

  it('mantém o resumo da aprovação limitado mesmo com conteúdo máximo', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    const base = harness.missionApprovalCandidate();
    harness.missionApprovalCandidate.mockReturnValueOnce({
      ...base,
      goal: 'objetivo '.repeat(1_000),
      acceptanceCriteria: Array.from(
        { length: 20 },
        (_, index) => `critério ${index + 1} ${'detalhe '.repeat(100)}`,
      ),
      deniedTools: Array.from(
        { length: 40 },
        (_, index) => `nexus_tool_${index + 1}`,
      ),
      squad: {
        ...base.squad,
        orchestratorInstructions: 'instrução '.repeat(1_000),
        agents: Array.from({ length: 24 }, (_, index) => ({
          id: `agent-${index + 1}`,
          agentName: `Agente ${index + 1} ${'nome '.repeat(20)}`,
          category: index === 0 ? 'orchestrator' : 'executor',
          cli: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
          allowedTools: ['nexus_task'],
          allowedSkills: ['check-work'],
        })),
      },
    });
    const handler = missionHandler(ORCH_CHANNELS.missionApproveIntent);

    await handler({ sender }, { missionId: 'mission-1' });

    const options = harness.dialog.showMessageBox.mock.calls.at(-1)?.[1];
    if (!options) throw new Error('missing native confirmation options');
    const detail = String(options.detail ?? '');
    expect(detail.split('\n')).toHaveLength(9);
    expect(detail.length).toBeLessThanOrEqual(1_800);
    expect(detail).toContain('workers=23');
    expect(detail).toContain('critérios=20');
    expect(detail).toContain('negadas=40, tools=24');
    expect(detail).toContain('skills=24');
    expect(detail).toMatch(/Review integral: SHA-256=[a-f0-9]{64}/);
    expect(detail).not.toContain('Agente 24');
    expect(detail).not.toContain('instrução '.repeat(30));
  });

  it('faz o receipt integral mudar quando autoridade não exibida muda', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    const base = harness.missionApprovalCandidate();
    const handler = missionHandler(ORCH_CHANNELS.missionApproveIntent);
    harness.missionApprovalCandidate.mockReturnValue({
      ...base,
      squad: {
        ...base.squad,
        orchestratorInstructions: 'autoridade integral alfa',
      },
    });

    await handler({ sender }, { missionId: 'mission-1' });
    const firstDetail = String(
      harness.dialog.showMessageBox.mock.calls.at(-1)?.[1]?.detail ?? '',
    );
    const firstReceipt = firstDetail.match(
      /Review integral: SHA-256=([a-f0-9]{64})/,
    )?.[1];

    harness.missionApprovalCandidate.mockReturnValue({
      ...base,
      squad: {
        ...base.squad,
        orchestratorInstructions: 'autoridade integral beta',
      },
    });
    await handler({ sender }, { missionId: 'mission-1' });
    const secondDetail = String(
      harness.dialog.showMessageBox.mock.calls.at(-1)?.[1]?.detail ?? '',
    );
    const secondReceipt = secondDetail.match(
      /Review integral: SHA-256=([a-f0-9]{64})/,
    )?.[1];

    expect(firstDetail).not.toContain('autoridade integral alfa');
    expect(secondDetail).not.toContain('autoridade integral beta');
    expect(firstReceipt).toMatch(/^[a-f0-9]{64}$/);
    expect(secondReceipt).toMatch(/^[a-f0-9]{64}$/);
    expect(secondReceipt).not.toBe(firstReceipt);
  });

  it('invalida aprovação se o renderer muda de workspace durante o modal', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.dialog.showMessageBox.mockImplementationOnce(async () => {
      harness.scopes.set(sender.id, SCOPE_B);
      return { response: 1 };
    });
    const handler = missionHandler(ORCH_CHANNELS.missionApproveIntent);

    await expect(
      handler({ sender }, { missionId: 'mission-1' }),
    ).rejects.toThrow(/workspace authority changed/i);
    expect(harness.approveMission).not.toHaveBeenCalled();
  });

  it('exige confirmação separada para promover lane de plano', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    const handler = missionHandler(ORCH_CHANNELS.missionPromotePlanLane);

    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await expect(
      handler({ sender }, { missionId: 'mission-plan' }),
    ).rejects.toThrow(/user_denied/i);
    expect(harness.promotePlan).not.toHaveBeenCalled();

    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(
      handler({ sender }, { missionId: 'mission-plan' }),
    ).resolves.toMatchObject({ id: 'mission-plan', status: 'running' });
    const detail = String(
      harness.dialog.showMessageBox.mock.calls.at(-1)?.[1]?.detail ?? '',
    );
    const reviewSha256 = detail.match(
      /Review integral: SHA-256=([a-f0-9]{64})/,
    )?.[1];
    expect(reviewSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(detail).toContain('lane=plan→standard');
    expect(detail).toContain(`plano=handoff=handoff-plan-v5`);
    expect(harness.promotePlan).toHaveBeenCalledWith(
      sender,
      { missionId: 'mission-plan' },
      'promotion-fence-5',
      expect.objectContaining({
        handoffId: 'handoff-plan-v5',
        digest: 'f'.repeat(64),
      }),
      reviewSha256,
    );
    expect(harness.stopPlanPromotion).toHaveBeenCalledWith(
      SCOPE_A,
      'mission-plan',
      5,
    );
    expect(harness.stopPlanPromotion).toHaveBeenCalledBefore(
      harness.promotePlan,
    );
    // One candidate for the denied attempt, then initial + pre-teardown +
    // post-teardown revalidation for the approved attempt.
    expect(harness.planPromotionCandidate).toHaveBeenCalledTimes(4);
    expect(harness.restartPlanPromotion).toHaveBeenCalledWith(
      SCOPE_A,
      'mission-plan',
      6,
    );
  });

  it('recusa texto ou seleção de handoff vindos do renderer na promoção', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    const handler = missionHandler(ORCH_CHANNELS.missionPromotePlanLane);

    await expect(
      handler(
        { sender },
        {
          missionId: 'mission-plan',
          handoffId: 'renderer-selected',
          summary: 'texto injetado pelo renderer',
        },
      ),
    ).rejects.toThrow(/invalid promote plan lane payload/i);
    expect(harness.planPromotionCandidate).not.toHaveBeenCalled();
    expect(harness.promotePlan).not.toHaveBeenCalled();
  });

  it('não grava standard-v2 quando o encerramento físico do plano falha', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.stopPlanPromotion.mockResolvedValueOnce({
      ok: false,
      missionId: 'mission-plan',
      error: 'sem prova de encerramento físico',
      cta: 'Executar plano novamente',
    });
    const handler = missionHandler(ORCH_CHANNELS.missionPromotePlanLane);

    await expect(
      handler({ sender }, { missionId: 'mission-plan' }),
    ).rejects.toThrow(/encerramento físico/i);

    expect(harness.stopPlanPromotion).toHaveBeenCalledWith(
      SCOPE_A,
      'mission-plan',
      5,
    );
    expect(harness.promotePlan).not.toHaveBeenCalled();
    expect(harness.restartPlanPromotion).not.toHaveBeenCalled();
  });

  it('mantém o plano sem pane se a autoridade revisada mudar durante o teardown', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    const reviewed = harness.planPromotionCandidate();
    harness.planPromotionCandidate.mockReset();
    harness.planPromotionCandidate
      .mockReturnValueOnce(reviewed)
      .mockReturnValueOnce(reviewed)
      .mockReturnValueOnce({
        ...reviewed,
        goal: 'Objetivo alterado durante o encerramento',
        fence: 'promotion-fence-after-teardown',
      });
    const handler = missionHandler(ORCH_CHANNELS.missionPromotePlanLane);

    await expect(
      handler({ sender }, { missionId: 'mission-plan' }),
    ).rejects.toThrow(/reviewed mission authority changed/i);

    expect(harness.stopPlanPromotion).toHaveBeenCalledOnce();
    expect(harness.promotePlan).not.toHaveBeenCalled();
    expect(harness.restartPlanPromotion).not.toHaveBeenCalled();
  });

  it('recusa promoção se um pane reaparecer depois do teardown', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.stopPlanPromotion.mockImplementationOnce(async () => {
      harness.operatorInput.missionPanes.push({
        id: 'pane-row-reappeared',
        missionId: 'mission-plan',
      });
      return { ok: true, missionId: 'mission-plan' };
    });
    const handler = missionHandler(ORCH_CHANNELS.missionPromotePlanLane);

    await expect(
      handler({ sender }, { missionId: 'mission-plan' }),
    ).rejects.toThrow(/runtime.*reappeared/i);

    expect(harness.promotePlan).not.toHaveBeenCalled();
    expect(harness.restartPlanPromotion).not.toHaveBeenCalled();
  });

  it('confirma demotion e nunca permite ressurreição direta pelo renderer', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    const handler = missionHandler(ORCH_CHANNELS.missionUpdate);
    const patch = {
      status: 'blocked',
      description: 'Ambiente externo indisponível; retomar após restaurar credenciais.',
    };

    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await expect(
      handler({ sender }, { missionId: 'mission-1', patch }),
    ).rejects.toThrow(/user_denied/i);
    expect(harness.updateMission).not.toHaveBeenCalled();

    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(
      handler({ sender }, { missionId: 'mission-1', patch }),
    ).resolves.toMatchObject({ status: 'blocked' });
    expect(harness.updateMission).toHaveBeenCalledWith(
      sender,
      'mission-1',
      patch,
      'lifecycle-fence-7',
    );
    const options = harness.dialog.showMessageBox.mock.calls.at(-1)?.[1];
    if (!options) throw new Error('missing lifecycle confirmation options');
    expect(options).toMatchObject({ defaultId: 0, cancelId: 0, noLink: true });
    expect(options.detail).toContain('running → blocked');
    expect(options.detail).toContain('revoga imediatamente');

    harness.updateMission.mockImplementationOnce(() => {
      throw new Error('mission lifecycle promotion/reopen is main-owned');
    });
    await expect(
      handler({ sender }, {
        missionId: 'mission-1',
        patch: { status: 'running' },
      }),
    ).rejects.toThrow(/main-owned/i);
  });

  it('returns an honest technical block when demotion cannot prove physical exit', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    let stored = {
      id: 'mission-1',
      title: 'Missão em execução',
      description: 'Bloqueio solicitado pelo operador.',
      status: 'blocked' as const,
      intentState: 'blocked_user' as const,
      intentVersion: 3,
      orchestratorSessionId: 'pty-stuck',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    };
    harness.updateMission.mockReturnValue(stored);
    harness.agentSessions.push({
      sessionId: 'pty-stuck',
      paneId: 'pane-stuck',
      adapterId: 'codex',
      cwd: SCOPE_A.rootRealPath,
      missionId: stored.id,
      role: 'orchestrator',
      scope: SCOPE_A,
    });
    harness.terminatePty.mockResolvedValueOnce(false);
    harness.projectStores.forScope.mockReturnValue({
      scope: SCOPE_A,
      missions: {
        get: (missionId: string) =>
          missionId === stored.id ? stored : null,
        list: () => [stored],
        update: (missionId: string, patch: Record<string, unknown>) => {
          if (missionId !== stored.id) return null;
          stored = {
            ...stored,
            ...patch,
            updatedAt: stored.updatedAt + 1,
          } as typeof stored;
          return stored;
        },
      },
      missionPanes: {
        list: () => [
          {
            id: 'mission-pane-stuck',
            missionId: stored.id,
            paneId: 'pane-stuck',
            adapterId: 'codex',
            title: 'Orquestrador',
            agentName: 'Maestro',
            role: 'orchestrator',
            scope: SCOPE_A,
            createdAt: 1,
          },
        ],
      },
    });
    const handler = missionHandler(ORCH_CHANNELS.missionUpdate);

    await expect(
      handler(
        { sender },
        {
          missionId: stored.id,
          patch: {
            status: 'blocked',
            description: 'Bloqueio solicitado pelo operador.',
          },
        },
      ),
    ).resolves.toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
      orchestratorSessionId: 'pty-stuck',
      description: expect.stringMatching(/encerramento físico.*pendente/i),
    });
    expect(harness.terminatePty).toHaveBeenCalledWith('pty-stuck');
  });
});

describe('mission removal IPC authority', () => {
  function configureAndGetHandler() {
    configureRendererMissionAuthority({} as never);
    const handler = harness.handlers.get(ORCH_CHANNELS.missionRemove);
    if (!handler) throw new Error('missing mission remove handler');
    return handler;
  }

  it('usa payload strict e nunca chama o store diretamente', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    const handler = configureAndGetHandler();

    await expect(handler({ sender }, 'mission-draft')).rejects.toThrow(
      /invalid mission remove payload/i,
    );
    await expect(
      handler({ sender }, { missionId: 'mission-draft', forged: true }),
    ).rejects.toThrow(/invalid mission remove payload/i);
    expect(harness.missionRemovalCandidate).not.toHaveBeenCalled();
  });

  it('exige confirmação nativa e revalida o mesmo workspace antes de remover', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    const handler = configureAndGetHandler();

    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await expect(
      handler({ sender }, { missionId: 'mission-draft' }),
    ).resolves.toEqual({ removed: false });
    expect(harness.removeMission).not.toHaveBeenCalled();

    harness.dialog.showMessageBox.mockImplementationOnce(async () => {
      harness.scopes.set(sender.id, SCOPE_B);
      return { response: 1 };
    });
    await expect(
      handler({ sender }, { missionId: 'mission-draft' }),
    ).rejects.toThrow(/workspace authority changed/i);
    expect(harness.removeMission).not.toHaveBeenCalled();

    harness.scopes.set(sender.id, SCOPE_A);
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(
      handler({ sender }, { missionId: 'mission-draft' }),
    ).resolves.toEqual({ removed: true });
    expect(harness.removeMission).toHaveBeenCalledWith(
      sender,
      'mission-draft',
    );
    const options = harness.dialog.showMessageBox.mock.calls.at(-1)?.[1];
    if (!options) throw new Error('missing native removal confirmation options');
    expect(options).toMatchObject({ defaultId: 0, cancelId: 0, noLink: true });
    expect(options.detail).toContain(SCOPE_A.rootRealPath);
    expect(options.detail).toContain('mission-draft');
  });

  it('não abre modal quando a autoridade recusa missão ativa ou terminal', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.missionRemovalCandidate.mockImplementationOnce(() => {
      throw new Error('missão ativa/terminal é preservada');
    });
    const handler = configureAndGetHandler();

    await expect(
      handler({ sender }, { missionId: 'mission-running' }),
    ).rejects.toThrow(/preservada/i);
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(harness.removeMission).not.toHaveBeenCalled();
  });
});

describe('mission runtime close IPC authority', () => {
  function configureAndGetHandler() {
    configureRendererMissionAuthority({} as never);
    const handler = harness.handlers.get(ORCH_CHANNELS.missionCloseRuntime);
    if (!handler) throw new Error('missing mission close runtime handler');
    return handler;
  }

  it('closes an already-blocked physical runtime and preserves the mission row', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    let stored = {
      id: 'mission-stuck',
      title: 'Missão travada',
      description: 'Histórico e receipts preservados.',
      status: 'blocked' as const,
      intentState: 'blocked_user' as const,
      intentVersion: 3,
      orchestratorSessionId: 'pty-stuck-close',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    };
    const persistedPane = {
      id: 'mission-pane-stuck-close',
      missionId: stored.id,
      paneId: 'pane-stuck-close',
      adapterId: 'codex',
      title: 'Orquestrador',
      agentName: 'Maestro',
      role: 'orchestrator' as const,
      scope: SCOPE_A,
      createdAt: 1,
    };
    harness.agentSessions.push({
      sessionId: 'pty-stuck-close',
      paneId: persistedPane.paneId,
      adapterId: 'codex',
      cwd: SCOPE_A.rootRealPath,
      missionId: stored.id,
      role: 'orchestrator',
      scope: SCOPE_A,
    });
    harness.terminatePty.mockImplementationOnce(async (sessionId: string) => {
      const index = harness.agentSessions.findIndex(
        (entry) => entry.sessionId === sessionId,
      );
      if (index >= 0) harness.agentSessions.splice(index, 1);
      return true;
    });
    harness.projectStores.forScope.mockReturnValue({
      scope: SCOPE_A,
      missions: {
        get: (missionId: string) =>
          missionId === stored.id ? stored : null,
        list: () => [stored],
        block: () => stored,
        update: (missionId: string, patch: Record<string, unknown>) => {
          if (missionId !== stored.id) return null;
          stored = {
            ...stored,
            ...patch,
            updatedAt: stored.updatedAt + 1,
          } as typeof stored;
          return stored;
        },
        setOrchestratorSession: (
          missionId: string,
          sessionId: string | null,
        ) => {
          if (missionId !== stored.id) return null;
          stored = {
            ...stored,
            orchestratorSessionId: sessionId ?? undefined,
            updatedAt: stored.updatedAt + 1,
          } as typeof stored;
          return stored;
        },
      },
      missionPanes: {
        list: (missionId: string) =>
          missionId === stored.id ? [persistedPane] : [],
      },
    });
    const handler = configureAndGetHandler();

    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await expect(
      handler({ sender }, { missionId: stored.id }),
    ).resolves.toEqual({
      ok: false,
      cancelled: true,
      terminatedSessionIds: [],
    });
    expect(harness.terminatePty).not.toHaveBeenCalled();

    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(
      handler({ sender }, { missionId: stored.id }),
    ).resolves.toMatchObject({
      ok: true,
      mission: {
        id: stored.id,
        status: 'blocked',
        orchestratorSessionId: undefined,
        description: 'Histórico e receipts preservados.',
      },
      terminatedSessionIds: ['pty-stuck-close'],
    });
    expect(harness.terminatePty).toHaveBeenCalledWith('pty-stuck-close');
    expect(stored.id).toBe('mission-stuck');
    const options = harness.dialog.showMessageBox.mock.calls.at(-1)?.[1];
    expect(options).toMatchObject({
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(options?.detail).toContain('Tasks, entregas');
  });

  it('encerra mesmo quando a missão recebe escrita durável enquanto o modal está aberto', async () => {
    // Regressão: a cerca pré-encerramento comparava um hash que incluía
    // updatedAt/intentVersion. Qualquer escrita durável na missão durante os
    // segundos do modal nativo (supervisor de delegação, learnings do agente,
    // transição de status) invalidava a aprovação e devolvia
    // "mission runtime changed while confirmation was open" — o operador não
    // conseguia encerrar uma missão VIVA, justamente a que mais escreve.
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    let stored = {
      id: 'mission-viva',
      title: 'Missão viva',
      description: 'Escreve enquanto o modal está aberto.',
      status: 'running' as 'running' | 'blocked',
      intentState: 'dispatched' as const,
      intentVersion: 4,
      orchestratorSessionId: 'pty-viva',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    };
    const persistedPane = {
      id: 'mission-pane-viva',
      missionId: stored.id,
      paneId: 'pane-viva',
      adapterId: 'claude',
      title: 'Orquestrador',
      agentName: 'Maestro',
      role: 'orchestrator' as const,
      scope: SCOPE_A,
      createdAt: 1,
    };
    harness.agentSessions.push({
      sessionId: 'pty-viva',
      paneId: persistedPane.paneId,
      adapterId: 'claude',
      cwd: SCOPE_A.rootRealPath,
      missionId: stored.id,
      role: 'orchestrator',
      scope: SCOPE_A,
    });
    harness.terminatePty.mockImplementationOnce(async (sessionId: string) => {
      const index = harness.agentSessions.findIndex(
        (entry) => entry.sessionId === sessionId,
      );
      if (index >= 0) harness.agentSessions.splice(index, 1);
      return true;
    });
    harness.projectStores.forScope.mockReturnValue({
      scope: SCOPE_A,
      missions: {
        get: (missionId: string) => (missionId === stored.id ? stored : null),
        list: () => [stored],
        block: () => {
          stored = {
            ...stored,
            status: 'blocked',
            updatedAt: stored.updatedAt + 1,
          } as typeof stored;
          return stored;
        },
        update: (missionId: string, patch: Record<string, unknown>) => {
          if (missionId !== stored.id) return null;
          stored = {
            ...stored,
            ...patch,
            updatedAt: stored.updatedAt + 1,
          } as typeof stored;
          return stored;
        },
        setOrchestratorSession: (
          missionId: string,
          sessionId: string | null,
        ) => {
          if (missionId !== stored.id) return null;
          stored = {
            ...stored,
            orchestratorSessionId: sessionId ?? undefined,
            updatedAt: stored.updatedAt + 1,
          } as typeof stored;
          return stored;
        },
      },
      missionPanes: {
        list: (missionId: string) =>
          missionId === stored.id ? [persistedPane] : [],
      },
    });
    const handler = configureAndGetHandler();

    // O agente grava um learning e o supervisor sobe intentVersion enquanto o
    // operador ainda lê o modal.
    harness.dialog.showMessageBox.mockImplementationOnce(async () => {
      stored = {
        ...stored,
        learnings: 'nota gravada durante a confirmação',
        intentVersion: stored.intentVersion + 1,
        updatedAt: stored.updatedAt + 7,
      } as typeof stored;
      return { response: 1 };
    });

    await expect(
      handler({ sender }, { missionId: stored.id }),
    ).resolves.toMatchObject({
      ok: true,
      terminatedSessionIds: ['pty-viva'],
    });
    expect(harness.terminatePty).toHaveBeenCalledWith('pty-viva');
  });

  it('validates the close payload before inspecting or terminating anything', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    const handler = configureAndGetHandler();

    await expect(handler({ sender }, { missionId: '' })).rejects.toThrow(
      /invalid mission close runtime payload/i,
    );
    await expect(
      handler({ sender }, { missionId: 'mission-a', forged: true }),
    ).rejects.toThrow(/invalid mission close runtime payload/i);
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(harness.terminatePty).not.toHaveBeenCalled();
  });
});

describe('saved squad mutation authority', () => {
  function setup(channel: string) {
    configureRendererMissionAuthority({} as never);
    const handler = harness.handlers.get(channel);
    if (!handler) throw new Error(`missing ${channel} handler`);
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    return { handler, sender };
  }

  it('salva a configuração global como rascunho inerte sem modal', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadSave);
    harness.squads.push({ ...SAVED_SQUAD });
    const edited = {
      ...SAVED_SQUAD,
      nativeInstructions: 'INSTRUÇÃO NATIVA ATUALIZADA',
    };
    await expect(handler({ sender }, edited)).resolves.toMatchObject({
      ok: true,
      squad: expect.objectContaining({ id: SAVED_SQUAD.id }),
    });
    expect(harness.applyPreparedSquadSave).toHaveBeenCalledOnce();
    expect(harness.squads[0].nativeInstructions).toBe(
      'INSTRUÇÃO NATIVA ATUALIZADA',
    );
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('recusa criar ou sobrescrever metadata de squad builtin gerenciado', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadSave);
    await expect(
      handler({ sender }, { ...SAVED_SQUAD, builtin: true }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/built-in.*cannot be edited/i),
    });
    harness.squads.push({ ...SAVED_SQUAD, builtin: true });
    await expect(
      handler({ sender }, { ...SAVED_SQUAD, builtin: false }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/built-in.*cannot be edited/i),
    });
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(harness.applyPreparedSquadSave).not.toHaveBeenCalled();
  });

  it('mantém confirmação nativa para excluir o rascunho', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadDelete);
    harness.squads.push({ ...SAVED_SQUAD });
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await expect(handler({ sender }, SAVED_SQUAD.id)).resolves.toEqual({
      ok: false,
      error: 'user_denied',
    });
    expect(harness.squads).toHaveLength(1);
    const options = harness.dialog.showMessageBox.mock.calls.at(-1)?.[1];
    expect(options).toMatchObject({
      title: 'Nexus IDE — excluir squad',
      buttons: ['Cancelar', 'Excluir squad'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });

    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(handler({ sender }, SAVED_SQUAD.id)).resolves.toEqual({
      ok: true,
    });
    expect(harness.squads).toHaveLength(0);
  });

  it('squad global novo normaliza e persiste sem cerimônia de execução', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadSave);
    const raw = {
      id: 'normalized-ipc-save',
      name: 'Normalized IPC save',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: 'Exact instructions',
      nativeInstructions: 'Exact native instructions',
      agents: [
        {
          id: 'orch',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'agy',
        },
        {
          id: 'worker',
          agentName: 'Worker',
          category: 'executor',
          cli: 'codex',
        },
      ],
    };

    await expect(handler({ sender }, raw)).resolves.toMatchObject({
      ok: true,
      squad: expect.objectContaining({ id: raw.id }),
    });
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(harness.squads[0].agents[0]).toMatchObject({
      model: 'gemini-3.6-flash-high',
      allowedTools: null,
    });
    expect(harness.squads[0].agents[1]).toMatchObject({ allowedTools: [] });
  });

  it('mantém o design fora do catálogo e aceita seu token só no renderer e workspace originais', async () => {
    const { handler: saveHandler, sender } = setup(
      ORCH_CHANNELS.squadSave,
    );
    const designHandler = harness.handlers.get(ORCH_CHANNELS.squadDesign);
    if (!designHandler) throw new Error('missing squad design handler');

    const designed = (await designHandler(
      { sender },
      { intent: 'design efêmero com autoridade exata' },
    )) as {
      ok: boolean;
      squad?: Squad;
      designDraftToken?: string;
    };
    expect(designed).toMatchObject({
      ok: true,
      squad: { id: 'designed-intent' },
      designDraftToken: expect.any(String),
    });
    expect(designed.designDraftToken?.length).toBeGreaterThanOrEqual(32);
    expect(harness.squads).toHaveLength(0);
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
    if (!designed.squad || !designed.designDraftToken) {
      throw new Error('missing ephemeral design authority');
    }

    const request = {
      squad: designed.squad,
      purpose: 'mission-runtime',
      guided: true,
      sourceSquadId: designed.squad.id,
      designDraftToken: designed.designDraftToken,
    };
    const otherRenderer = owner(902);
    harness.scopes.set(otherRenderer.id, SCOPE_A);
    harness.windows.set(otherRenderer.id, { isDestroyed: () => false });
    await expect(
      saveHandler({ sender: otherRenderer }, request),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/source squad is unavailable/i),
    });

    await expect(saveHandler({ sender }, request)).resolves.toMatchObject({
      ok: true,
      squad: {
        id: expect.stringMatching(/^agentic-runtime-[0-9a-f-]{36}$/i),
        runtimeSourceSquadId: designed.squad.id,
      },
    });
    expect(harness.prepareMissionRuntimeSquadSave).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ id: designed.squad.id }),
      true,
      'ephemeral',
    );
    await expect(saveHandler({ sender }, request)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/source squad is unavailable/i),
    });
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('salva silenciosamente somente uma cópia runtime nova e main-owned', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadSave);
    harness.squads.push({ ...SAVED_SQUAD });
    const request = {
      squad: {
        ...SAVED_SQUAD,
        id: 'renderer-id-is-ignored',
        builtin: true,
      },
      purpose: 'mission-runtime',
      guided: false,
      sourceSquadId: SAVED_SQUAD.id,
    };

    const result = (await handler({ sender }, request)) as {
      ok: boolean;
      squad?: Squad;
    };

    expect(result).toMatchObject({
      ok: true,
      squad: {
        builtin: false,
        orchestratorInstructions: SAVED_SQUAD.orchestratorInstructions,
      },
    });
    expect(result.squad?.id).toMatch(
      /^mission-runtime-[0-9a-f-]{36}$/i,
    );
    expect(result.squad?.id).not.toBe(request.squad.id);
    expect(result.squad).toMatchObject({
      runtimeSourceSquadId: SAVED_SQUAD.id,
      runtimeSourceSquadRevisionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(harness.applyPreparedSquadSave).toHaveBeenCalledOnce();
  });

  it('save runtime + início abre exatamente o único modal semântico da missão', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadSave);
    await expect(handler({ sender }, SAVED_SQUAD)).resolves.toMatchObject({
      ok: true,
      squad: expect.objectContaining({ id: SAVED_SQUAD.id }),
    });
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
    const saved = (await handler(
      { sender },
      {
        squad: SAVED_SQUAD,
        purpose: 'mission-runtime',
        guided: false,
        sourceSquadId: SAVED_SQUAD.id,
      },
    )) as { ok: boolean; squad?: Squad };
    if (!saved.squad) throw new Error('missing runtime squad');
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();

    const base = harness.missionApprovalCandidate();
    const runtimeSnapshot = harness.prepareSquadSave(saved.squad).snapshot;
    harness.missionApprovalCandidate.mockReturnValueOnce({
      ...base,
      squad: runtimeSnapshot,
    });
    const approve = harness.handlers.get(ORCH_CHANNELS.missionApproveIntent);
    if (!approve) throw new Error('missing mission approval handler');

    await approve({ sender }, { missionId: 'mission-1' });

    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const options = harness.dialog.showMessageBox.mock.calls[0]?.[1];
    expect(options).toMatchObject({
      title: 'Nexus IDE — iniciar missão',
      buttons: ['Negar', 'Aprovar e iniciar'],
    });
    const detail = String(options?.detail ?? '');
    expect(detail).toContain(saved.squad.id);
    expect(detail).toContain('Maestro/workers');
    expect(detail).toContain(`SHA-256=${runtimeSnapshot.hash}`);
    expect(detail).toContain('tools=1+0 irrestrito(s)');
    expect(detail).toContain('skills=1+0 irrestrito(s)');
    expect(detail).toMatch(/Review integral: SHA-256=[a-f0-9]{64}/);
  });

  it('runtime é imutável e worker com wildcard não ganha save silencioso', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadSave);
    harness.squads.push({ ...SAVED_SQUAD });
    const first = (await handler(
      { sender },
      {
        squad: SAVED_SQUAD,
        purpose: 'mission-runtime',
        guided: false,
        sourceSquadId: SAVED_SQUAD.id,
      },
    )) as { ok: boolean; squad?: Squad };
    expect(first.ok).toBe(true);
    const runtime = first.squad;
    expect(runtime?.id).toMatch(/^mission-runtime-/);
    if (!runtime) throw new Error('missing runtime squad');

    await expect(handler({ sender }, runtime)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/runtime squads are immutable/i),
    });

    await expect(
      handler(
        { sender },
        {
          squad: {
            ...SAVED_SQUAD,
            agents: [
              SAVED_SQUAD.agents[0],
              {
                id: 'worker-wide',
                agentName: 'Worker wide',
                category: 'executor',
                cli: 'codex',
                allowedTools: ['*'],
              },
            ],
          },
          purpose: 'mission-runtime',
          guided: false,
          sourceSquadId: SAVED_SQUAD.id,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/authority-fenced/i),
    });
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(harness.applyPreparedSquadSave).toHaveBeenCalledTimes(1);
  });

  it('não deixa o renderer promover um squad comum para identidade guided', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadSave);
    harness.squads.push({ ...SAVED_SQUAD });

    await expect(
      handler(
        { sender },
        {
          squad: SAVED_SQUAD,
          purpose: 'mission-runtime',
          guided: true,
          sourceSquadId: SAVED_SQUAD.id,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/guided identity.*main-owned source/i),
    });
    expect(harness.prepareMissionRuntimeSquadSave).not.toHaveBeenCalled();
  });

  it('não altera/exclui squad de missão running aprovada', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadSave);
    harness.listMissions.mockReturnValueOnce([
      {
        id: 'mission-running',
        squadId: SAVED_SQUAD.id,
        status: 'running',
        intentVersion: 1,
        intentContract: {
          goal: 'Executar',
          intentVersion: 1,
          approvedAt: 1,
        },
      },
    ]);
    await expect(handler({ sender }, SAVED_SQUAD)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/squad_in_use/i),
    });
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(harness.applyPreparedSquadSave).not.toHaveBeenCalled();
  });

  it('bloqueia squad running em qualquer suite global, não só na janela atual', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadSave);
    harness.projectStores.listSuites.mockReturnValueOnce([
      {
        scope: SCOPE_B,
        missions: {
          list: () => [
            {
              id: 'mission-other-scope',
              squadId: SAVED_SQUAD.id,
              status: 'running',
            },
          ],
        },
      },
    ]);

    await expect(handler({ sender }, SAVED_SQUAD)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/squad_in_use/i),
    });
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('bloqueia inventário físico/OMP ainda vivo ligado ao squad', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadSave);
    harness.projectStores.listSuites.mockReturnValue([
      {
        scope: SCOPE_A,
        missions: {
          list: () => [
            {
              id: 'mission-physical',
              squadId: SAVED_SQUAD.id,
              status: 'blocked',
            },
          ],
        },
      },
    ]);
    harness.ompSessions.push({
      missionId: 'mission-physical',
      state: 'idle',
    });

    await expect(handler({ sender }, SAVED_SQUAD)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/squad_in_use.*OMP|physical/i),
    });
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('bloqueia PTY detached do registry visual pelo inventário main completo', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadSave);
    harness.agentSessions.push({
      sessionId: 'pty-detached',
      paneId: 'pane-gone-from-renderer',
      squadId: SAVED_SQUAD.id,
      role: 'worker',
      adapterId: 'codex',
      cwd: SCOPE_A.rootRealPath,
      scope: SCOPE_A,
      source: 'legacy-squad',
      readOnly: false,
      allowedTools: [],
      allowedSkills: [],
    });

    await expect(handler({ sender }, SAVED_SQUAD)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/squad_in_use.*PTY/i),
    });
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
  });
});

describe('squad import/export global authority boundary', () => {
  function setup(channel: string, id = 880) {
    const handler = harness.handlers.get(channel);
    if (!handler) throw new Error(`missing ${channel} handler`);
    const sender = owner(id);
    const window = { isDestroyed: () => false };
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, window);
    return { handler, sender, window };
  }

  function validImportFile(
    nativeInstructions = 'NATIVE IMPORT AUTHORITY',
  ): { dir: string; file: string; raw: string } {
    const dir = makeTempDir();
    const file = path.join(dir, 'squads.json');
    const raw = JSON.stringify({
      squads: [
        {
          id: 'imported-secure',
          name: 'Imported secure',
          createdAt: '1',
          builtin: false,
          orchestratorInstructions: 'ORCHESTRATOR IMPORT AUTHORITY',
          nativeInstructions,
          agents: [
            {
              id: 'orch',
              agentName: 'Maestro',
              category: 'orchestrator',
              cli: 'codex',
            },
          ],
        },
      ],
    });
    fs.writeFileSync(file, raw, 'utf8');
    return { dir, file, raw };
  }

  it('prepara sem mutação, mostra hashes e resumo compacto e nega por padrão', async () => {
    const { handler, sender, window } = setup(ORCH_CHANNELS.squadImport);
    const { file } = validImportFile('NATIVE EXACTLY VISIBLE');
    harness.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [file],
    });
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await expect(handler({ sender })).resolves.toEqual({
      ok: false,
      error: 'user_denied',
    });
    expect(harness.applyPreparedSquadsImport).not.toHaveBeenCalled();
    expect(harness.squads).toHaveLength(0);
    expect(harness.dialog.showOpenDialog).toHaveBeenCalledWith(
      window,
      expect.anything(),
    );
    const options = harness.dialog.showMessageBox.mock.calls.at(-1)?.[1];
    expect(options).toMatchObject({ defaultId: 0, cancelId: 0, noLink: true });
    // Compacto: o par de SHA-256 fixa o conteúdo integral; o dump não cabe
    // num alerta nativo sem scroll.
    expect(options?.detail).toContain('SHA-256 canônico');
    expect(options?.detail).toMatch(/Squads: \d+; agentes: \d+/);
    expect(options?.detail).not.toContain('NATIVE EXACTLY VISIBLE');
    expect(options?.detail).not.toContain('"allowedTools": null');
  });

  it('escapa o path selecionado no modal para impedir injeção de linhas', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadImport, 892);
    const { dir, file } = validImportFile();
    const injectedPath = path.join(dir, 'squads\nFAKE AUTHORITY.json');
    fs.renameSync(file, injectedPath);
    harness.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [injectedPath],
    });
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await handler({ sender });
    const options = harness.dialog.showMessageBox.mock.calls.at(-1)?.[1];
    // Sanitização em linha única: o newline do nome de arquivo nunca vira
    // quebra de linha real no modal (injeção de linhas impossível).
    expect(options?.detail).toContain('FAKE AUTHORITY.json');
    expect(options?.detail).not.toContain('squads\nFAKE AUTHORITY.json');
  });

  it('squad grande importa com modal compacto fixado por hash (sem veto de tamanho)', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadImport, 893);
    const { file } = validImportFile('N'.repeat(6_100));
    harness.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [file],
    });
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await expect(handler({ sender })).resolves.toMatchObject({
      ok: false,
      error: 'user_denied',
    });
    const options = harness.dialog.showMessageBox.mock.calls.at(-1)?.[1];
    expect(options?.detail).toContain('SHA-256 canônico');
    expect(options?.detail).not.toContain('N'.repeat(200));
    expect(harness.applyPreparedSquadsImport).not.toHaveBeenCalled();
  });

  it('recusa troca de workspace durante picker ou confirmação', async () => {
    const first = setup(ORCH_CHANNELS.squadImport, 881);
    const { file } = validImportFile();
    harness.dialog.showOpenDialog.mockImplementationOnce(async () => {
      harness.scopes.set(first.sender.id, SCOPE_B);
      return { canceled: false, filePaths: [file] };
    });
    await expect(first.handler({ sender: first.sender })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/authority changed/i),
    });

    const second = setup(ORCH_CHANNELS.squadImport, 882);
    harness.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [file],
    });
    harness.dialog.showMessageBox.mockImplementationOnce(async () => {
      harness.scopes.set(second.sender.id, SCOPE_B);
      return { response: 1 };
    });
    await expect(second.handler({ sender: second.sender })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/authority changed/i),
    });
    expect(harness.applyPreparedSquadsImport).not.toHaveBeenCalled();
  });

  it('recusa symlink e arquivo maior que 1 MiB antes do prepare/modal', async () => {
    const symlinkCase = setup(ORCH_CHANNELS.squadImport, 883);
    const { dir, file } = validImportFile();
    const link = path.join(dir, 'linked.json');
    fs.symlinkSync(file, link);
    harness.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [link],
    });
    await expect(
      symlinkCase.handler({ sender: symlinkCase.sender }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/symlink|regular/i),
    });

    const hugeCase = setup(ORCH_CHANNELS.squadImport, 884);
    const huge = path.join(dir, 'huge.json');
    fs.writeFileSync(huge, Buffer.alloc(1024 * 1024 + 1, 0x20));
    harness.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [huge],
    });
    await expect(
      hugeCase.handler({ sender: hugeCase.sender }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/1 MiB|too large/i),
    });
    expect(harness.prepareSquadsImport).not.toHaveBeenCalled();
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('reabre e recusa dev/ino/size/mtime/hash drift depois do modal', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadImport, 885);
    const { file } = validImportFile();
    harness.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [file],
    });
    harness.dialog.showMessageBox.mockImplementationOnce(async () => {
      fs.writeFileSync(file, '{"squads":[]}\n', 'utf8');
      return { response: 1 };
    });

    await expect(handler({ sender })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/changed|drift/i),
    });
    expect(harness.applyPreparedSquadsImport).not.toHaveBeenCalled();
  });

  it('bloqueia import quando qualquer target está running ou tem inventário físico', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadImport, 886);
    const { file } = validImportFile();
    harness.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [file],
    });
    harness.projectStores.listSuites.mockReturnValue([
      {
        scope: SCOPE_B,
        missions: {
          list: () => [
            {
              id: 'mission-import-target',
              squadId: 'imported-secure',
              status: 'running',
            },
          ],
        },
      },
    ]);

    await expect(handler({ sender })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/squad_in_use/i),
    });
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(harness.applyPreparedSquadsImport).not.toHaveBeenCalled();
  });

  it('propaga CAS do apply e não publica estado parcial', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadImport, 887);
    const { file } = validImportFile();
    harness.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [file],
    });
    harness.applyPreparedSquadsImport.mockImplementationOnce(() => {
      throw new Error('squad CAS changed for imported-secure');
    });

    await expect(handler({ sender })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/CAS changed/i),
    });
    expect(harness.squads).toHaveLength(0);
  });

  it('serializa import/export em uma única lane global', async () => {
    const importing = setup(ORCH_CHANNELS.squadImport, 888);
    const exporting = setup(ORCH_CHANNELS.squadExport, 889);
    const picker = deferred<{ canceled: boolean; filePaths: string[] }>();
    harness.dialog.showOpenDialog.mockImplementationOnce(() => picker.promise);

    const importFlight = importing.handler({ sender: importing.sender });
    await Promise.resolve();
    await expect(
      exporting.handler({ sender: exporting.sender }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/already pending|in progress/i),
    });
    expect(harness.dialog.showSaveDialog).not.toHaveBeenCalled();
    picker.resolve({ canceled: true, filePaths: [] });
    await expect(importFlight).resolves.toEqual({ ok: false });
  });

  it('captura bytes antes do save dialog e publica atomicamente no path selecionado', async () => {
    const { handler, sender, window } = setup(ORCH_CHANNELS.squadExport, 890);
    const dir = makeTempDir();
    const target = path.join(dir, 'export.json');
    const before = '{"squads":[{"id":"before"}]}';
    const after = '{"squads":[{"id":"after"}]}';
    harness.exportSquadsJson.mockReturnValueOnce(before);
    harness.dialog.showSaveDialog.mockImplementationOnce(async () => {
      harness.exportSquadsJson.mockReturnValue(after);
      return { canceled: false, filePath: target };
    });

    await expect(handler({ sender })).resolves.toEqual({
      ok: true,
      path: target,
    });
    expect(harness.dialog.showSaveDialog).toHaveBeenCalledWith(
      window,
      expect.anything(),
    );
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    expect(
      fs.readdirSync(dir).filter((name) => name.includes('.nexus-export-')),
    ).toEqual([]);
  });

  it('recusa export para symlink e preserva destino sem escrita parcial', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.squadExport, 891);
    const dir = makeTempDir();
    const victim = path.join(dir, 'victim.json');
    const link = path.join(dir, 'selected.json');
    fs.writeFileSync(victim, 'KEEP', 'utf8');
    fs.symlinkSync(victim, link);
    harness.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: link,
    });

    await expect(handler({ sender })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/symlink|regular/i),
    });
    expect(fs.readFileSync(victim, 'utf8')).toBe('KEEP');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

describe('native operator attestation authority', () => {
  function setup(channel: string) {
    const handler = harness.handlers.get(channel);
    if (!handler) throw new Error(`missing ${channel} handler`);
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    return { handler, sender };
  }

  it('nega resposta do renderer por padrão e não cria handoff humano', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.clarifyAnswerSubmit);
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await expect(handler({ sender }, {
      missionId: 'mission-1',
      questionId: 'question-1',
      answer: 'opt-2',
    })).rejects.toThrow(/user_denied/i);
    expect(harness.persistClarifyAnswer).not.toHaveBeenCalled();
    const options = harness.dialog.showMessageBox.mock.calls.at(-1)?.[1];
    if (!options) throw new Error('missing clarify confirmation options');
    expect(options).toMatchObject({ defaultId: 0, cancelId: 0, noLink: true });
    expect(options.detail).toContain('Qual banco deve ser usado?');
    expect(options.detail).toContain('SQLite [opt-2]');
  });

  it('revalida o workspace após o clique e entrega só o fence exibido', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.clarifyAnswerSubmit);
    const raw = {
      missionId: 'mission-1',
      questionId: 'question-1',
      answer: 'opt-2',
    };
    harness.dialog.showMessageBox.mockImplementationOnce(async () => {
      harness.scopes.set(sender.id, SCOPE_B);
      return { response: 1 };
    });
    await expect(handler({ sender }, raw)).rejects.toThrow(/authority changed/i);
    expect(harness.persistClarifyAnswer).not.toHaveBeenCalled();

    harness.scopes.set(sender.id, SCOPE_A);
    await expect(handler({ sender }, raw)).resolves.toEqual({
      ok: true,
      handoffId: 'answer-1',
    });
    expect(harness.persistClarifyAnswer).toHaveBeenCalledOnce();
    expect(harness.persistClarifyAnswer).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE_A,
      raw,
      'c'.repeat(64),
    );
  });

  it('mostra revisão integral e exige clique nativo antes de injetá-la', async () => {
    const { handler, sender } = setup(ORCH_CHANNELS.operatorReviewSubmit);
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const raw = {
      missionId: 'mission-1',
      annotations: [
        { path: 'src/checkout.ts', line: 42, body: 'Trate o valor nulo integralmente.' },
      ],
    };
    await expect(handler({ sender }, raw)).rejects.toThrow(/user_denied/i);
    expect(harness.persistOperatorReview).not.toHaveBeenCalled();
    const options = harness.dialog.showMessageBox.mock.calls.at(-1)?.[1];
    if (!options) throw new Error('missing operator review confirmation options');
    expect(options.detail).toContain('src/checkout.ts:42');
    expect(options.detail).toContain('Trate o valor nulo integralmente.');
  });
});

describe('orchestration init/close epoch serialization', () => {
  it('does not resurrect the coordinator when close wins a pending MCP bind', async () => {
    let releaseMcp: (() => void) | undefined;
    vi.mocked(startMcpServer).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseMcp = resolve;
        }),
    );

    const initialize = initOrchestration();
    await Promise.resolve();
    expect(startOrchestrationCoordinator).not.toHaveBeenCalled();

    const closing = closeOrchestration();
    releaseMcp?.();
    await initialize;
    await closing;

    expect(startOrchestrationCoordinator).not.toHaveBeenCalled();
    expect(stopMcpServer).toHaveBeenCalledOnce();
    expect(disposeProjectDomainStoreRegistry).toHaveBeenCalledOnce();
  });

  it('keeps stores and services alive when coordinator settlement is unproven', async () => {
    await initOrchestration();
    vi.mocked(stopOrchestrationCoordinator).mockRejectedValueOnce(
      new Error('participant still has a physical effect in flight'),
    );
    vi.mocked(stopMcpServer).mockClear();
    vi.mocked(disposeProjectDomainStoreRegistry).mockClear();

    await expect(closeOrchestration()).rejects.toThrow(/physical effect/i);
    expect(stopMcpServer).not.toHaveBeenCalled();
    expect(disposeProjectDomainStoreRegistry).not.toHaveBeenCalled();

    vi.mocked(stopOrchestrationCoordinator).mockResolvedValueOnce();
    await closeOrchestration();
  });
});

describe('teclado do operador em pane de missão', () => {
  function setup() {
    const handler = harness.handlers.get(ORCH_CHANNELS.paneOperatorInput);
    if (!handler) throw new Error('missing paneOperatorInput handler');
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.operatorInput.ownedSessions.clear();
    harness.operatorInput.missions.clear();
    harness.operatorInput.writes.length = 0;
    return { handler, sender };
  }

  function livePane(sender: { id: number }, sessionId = 'pty-1') {
    harness.operatorInput.ownedSessions.set(`${sender.id}:${sessionId}`, {
      missionId: 'mission-1',
    });
    harness.operatorInput.missions.set('mission-1', { status: 'running' });
    return sessionId;
  }

  it('entrega a digitação do operador pelo lane main-owned', async () => {
    const { handler, sender } = setup();
    const sessionId = livePane(sender);
    expect(handler({ sender }, { sessionId, data: 'ola\r' })).toBe(
      true,
    );
    expect(harness.operatorInput.writes).toEqual([
      { sessionId, data: 'ola\r' },
    ]);
  });

  it('recusa bracketed paste: injeção orquestrada não entra por aqui', async () => {
    const { handler, sender } = setup();
    const sessionId = livePane(sender);
    expect(
      handler({ sender }, { sessionId, data: '\x1b[200~kickoff\x1b[201~' }),
    ).toBe(false);
    expect(harness.operatorInput.writes).toEqual([]);
  });

  it('recusa sessão que este renderer não apresenta', async () => {
    const { handler, sender } = setup();
    livePane(sender);
    expect(
      handler({ sender }, { sessionId: 'pty-de-outro', data: 'x' }),
    ).toBe(false);
    expect(harness.operatorInput.writes).toEqual([]);
  });

  it('recusa missão encerrada', async () => {
    const { handler, sender } = setup();
    const sessionId = livePane(sender);
    harness.operatorInput.missions.set('mission-1', { status: 'done' });
    expect(
      handler({ sender }, { sessionId, data: 'x' }),
    ).toBe(false);
    expect(harness.operatorInput.writes).toEqual([]);
  });

  it('recusa payload acima do teto de digitação', async () => {
    const { handler, sender } = setup();
    const sessionId = livePane(sender);
    expect(
      handler({ sender }, { sessionId, data: 'a'.repeat(4_097) }),
    ).toBe(false);
    expect(harness.operatorInput.writes).toEqual([]);
  });
});
